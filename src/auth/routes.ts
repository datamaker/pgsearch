import { randomBytes } from 'crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config.js';
import { query } from '../db/connection.js';
import {
  authEnabled,
  buildAuthUrl,
  exchangeCode,
  signOidcState,
  verifyOidcState,
} from './oidc.js';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  resolveSessionUser,
  sha256Hex,
  signSession,
  type AuthUser,
} from './session.js';

const OIDC_STATE_COOKIE = 'pgsearch_oidc';

function secureCookies(): boolean {
  return config.publicUrl.startsWith('https://');
}

/** 관리자 세션 필수 라우트용 가드. 통과 시 사용자, 아니면 403 후 null. */
async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<AuthUser | null> {
  const user = await resolveSessionUser(request);
  if (!user || user.role !== 'admin') {
    reply.status(403).send({ message: 'admin role required' });
    return null;
  }
  return user;
}

interface IdParams {
  id: string;
}

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /auth/status - 인증 활성화 여부 + 현재 로그인 사용자
  fastify.get('/auth/status', async (request) => {
    if (!authEnabled()) return { enabled: false, user: null };
    const user = await resolveSessionUser(request);
    return {
      enabled: true,
      user: user ? { email: user.email, name: user.name, role: user.role } : null,
    };
  });

  // GET /auth/oidc/start - IdP로 리다이렉트 (PKCE + state)
  fastify.get('/auth/oidc/start', async (request, reply) => {
    if (!authEnabled()) {
      reply.status(404);
      return { message: 'sso not configured' };
    }
    const { url, state, verifier } = await buildAuthUrl();
    return reply
      .setCookie(OIDC_STATE_COOKIE, signOidcState({ state, verifier }), {
        path: '/auth/oidc',
        httpOnly: true,
        sameSite: 'lax',
        secure: secureCookies(),
        maxAge: 600,
      })
      .redirect(url);
  });

  // GET /auth/oidc/callback - 코드 교환 + JIT 프로비저닝 + 세션 발급
  fastify.get<{ Querystring: { code?: string; state?: string } }>(
    '/auth/oidc/callback',
    async (request, reply) => {
      if (!authEnabled()) {
        reply.status(404);
        return { message: 'sso not configured' };
      }
      const stored = request.cookies[OIDC_STATE_COOKIE]
        ? verifyOidcState(request.cookies[OIDC_STATE_COOKIE]!)
        : null;
      reply.clearCookie(OIDC_STATE_COOKIE, { path: '/auth/oidc' });

      const { code, state } = request.query;
      if (!stored || !code || !state || state !== stored.state) {
        reply.status(400);
        return { message: 'sso flow expired or invalid; start again' };
      }

      let identity;
      try {
        identity = await exchangeCode(code, stored.verifier);
      } catch (err) {
        request.log.warn({ err }, 'oidc callback failed');
        reply.status(403);
        return { message: 'sso sign-in failed' };
      }

      // JIT 프로비저닝
      let { rows } = await query<AuthUser>(
        'SELECT id, email, name, role, is_active FROM users WHERE email = $1',
        [identity.email]
      );
      let user = rows[0];
      if (!user) {
        const { rows: countRows } = await query<{ count: string }>('SELECT COUNT(*) FROM users');
        const isFirstUser = parseInt(countRows[0].count, 10) === 0;
        const role =
          config.adminEmails.includes(identity.email) || isFirstUser ? 'admin' : 'member';
        ({ rows } = await query<AuthUser>(
          `INSERT INTO users (email, name, role) VALUES ($1, $2, $3)
           RETURNING id, email, name, role, is_active`,
          [identity.email, identity.name, role]
        ));
        user = rows[0];
      } else if (config.adminEmails.includes(identity.email) && user.role === 'member') {
        // 환경변수 admin 목록에 있으면 승격
        ({ rows } = await query<AuthUser>(
          `UPDATE users SET role = 'admin' WHERE id = $1
           RETURNING id, email, name, role, is_active`,
          [user.id]
        ));
        user = rows[0];
      }

      if (!user.is_active) {
        reply.status(403);
        return { message: 'account is deactivated' };
      }

      await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

      return reply
        .setCookie(SESSION_COOKIE, signSession(user.id), {
          path: '/',
          httpOnly: true,
          sameSite: 'lax',
          secure: secureCookies(),
          maxAge: SESSION_MAX_AGE_SEC,
        })
        .redirect('/');
    }
  );

  // POST /auth/logout - 세션 쿠키 제거
  fastify.post('/auth/logout', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { message: 'logged out' };
  });

  // ─── 멤버 관리 (admin 전용) ───────────────────────────────

  // GET /auth/users - 사용자 목록
  fastify.get('/auth/users', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    const { rows } = await query(
      'SELECT id, email, name, role, is_active, last_login_at FROM users ORDER BY id'
    );
    return { results: rows };
  });

  // PATCH /auth/users/:id - 역할/활성화 변경
  fastify.patch<{ Params: IdParams; Body: { role?: string; is_active?: boolean } }>(
    '/auth/users/:id',
    async (request, reply) => {
      const admin = await requireAdmin(request, reply);
      if (!admin) return reply;

      const id = parseInt(request.params.id, 10);
      const { role, is_active: isActive } = request.body ?? {};

      if (role !== undefined && role !== 'admin' && role !== 'member') {
        reply.status(400);
        return { message: "role must be 'admin' or 'member'" };
      }
      // 자기 자신 강등/비활성화 방지 (락아웃 가드)
      if (id === admin.id && (role === 'member' || isActive === false)) {
        reply.status(400);
        return { message: 'cannot demote or deactivate yourself' };
      }

      const { rows } = await query(
        `UPDATE users SET
           role = COALESCE($2, role),
           is_active = COALESCE($3, is_active)
         WHERE id = $1
         RETURNING id, email, name, role, is_active, last_login_at`,
        [id, role ?? null, isActive ?? null]
      );
      if (rows.length === 0) {
        reply.status(404);
        return { message: 'user not found' };
      }
      return rows[0];
    }
  );

  // ─── API 키 관리 (admin 전용) ─────────────────────────────

  // GET /auth/keys - 키 목록 (키 값/해시는 절대 반환하지 않음)
  fastify.get('/auth/keys', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    const { rows } = await query(
      'SELECT id, name, created_at, last_used_at FROM api_keys ORDER BY id'
    );
    return { results: rows };
  });

  // POST /auth/keys - 키 생성 (원본 키는 이 응답에서 딱 한 번만 노출)
  fastify.post<{ Body: { name?: string } }>('/auth/keys', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    const name = (request.body?.name ?? '').trim();
    if (!name) {
      reply.status(400);
      return { message: 'name is required' };
    }
    const rawKey = randomBytes(32).toString('base64url');
    const { rows } = await query(
      `INSERT INTO api_keys (name, key_hash) VALUES ($1, $2)
       RETURNING id, name, created_at, last_used_at`,
      [name, sha256Hex(rawKey)]
    );
    reply.status(201);
    return { ...rows[0], key: rawKey };
  });

  // DELETE /auth/keys/:id - 키 삭제
  fastify.delete<{ Params: IdParams }>('/auth/keys/:id', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    const id = parseInt(request.params.id, 10);
    const { rowCount } = await query('DELETE FROM api_keys WHERE id = $1', [id]);
    if (!rowCount) {
      reply.status(404);
      return { message: 'key not found' };
    }
    return { message: 'deleted' };
  });
}

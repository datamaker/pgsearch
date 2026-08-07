import type { FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/connection.js';
import { authEnabled } from './oidc.js';
import { resolveSessionUser, sha256Hex } from './session.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * API 라우트 공통 인증 가드 (preHandler).
 * - OIDC 미설정 시: 전부 허용 (기존과 동일한 open mode)
 * - 세션 쿠키: 유효한 사용자면 허용, 단 쓰기 작업은 admin만
 * - API 키: Authorization: Bearer <key> — 읽기/쓰기 모두 허용
 */
export async function authGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!authEnabled()) return;

  // 1) 세션 쿠키
  const user = await resolveSessionUser(request);
  if (user) {
    request.user = user;
    if (WRITE_METHODS.has(request.method) && user.role !== 'admin') {
      reply.status(403).send({ message: 'admin role required for write operations' });
    }
    return;
  }

  // 2) API 키 (Meilisearch 스타일 Bearer 키)
  const header = request.headers.authorization ?? '';
  const key = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (key) {
    const { rows } = await query<{ id: number }>(
      'SELECT id FROM api_keys WHERE key_hash = $1',
      [sha256Hex(key)]
    );
    if (rows.length > 0) {
      // fire-and-forget
      query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [rows[0].id]).catch(() => {});
      return;
    }
  }

  reply.status(401).send({ message: 'unauthorized' });
}

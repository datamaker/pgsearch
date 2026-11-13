import type { FastifyRequest, FastifyReply } from 'fastify';
import { query } from '../db/connection.js';
import { authEnabled, openModeAllowed } from './oidc.js';
import { resolveSessionUser, sha256Hex } from './session.js';

/** 문서/인덱스를 바꾸지 않는 "읽기" 라우트 중 POST 인 것 (검색). */
const READ_POST_ROUTES = new Set(['/indexes/:uid/search']);

/**
 * 읽기 요청인가 — GET/HEAD/OPTIONS, 그리고 POST 검색.
 * 원본 URL 이 아니라 라우터가 매칭한 라우트 패턴으로 판단한다 (경로 인코딩 우회 방지).
 */
export function isReadRequest(request: FastifyRequest): boolean {
  const method = request.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  return method === 'POST' && READ_POST_ROUTES.has(request.routeOptions?.url ?? '');
}

function authError(message: string, code: string) {
  return { message, code, type: 'auth', link: `https://docs.meilisearch.com/errors#${code}` };
}

interface ApiKeyRow {
  id: number;
  expires_at: Date | null;
  read_only: boolean;
}

/**
 * API 라우트 공통 인증 가드 (preHandler).
 * - OIDC 미설정 시: 개발 환경이거나 PGSEARCH_OPEN_MODE=1 일 때만 전부 허용 (open mode).
 *   운영에서 설정이 빠진 채라면 열어 주지 않고 503 (부팅 단계에서도 막는다 — index.ts).
 * - 세션 쿠키: 유효한 사용자면 허용, 단 쓰기 작업은 admin만 (검색 POST 는 읽기로 본다)
 * - API 키: Authorization: Bearer <key>
 *     · 만료(expires_at)가 지난 키는 401
 *     · read_only 키는 조회·검색만 허용, 그 외는 403
 *     · 둘 다 없는 키(기존 키 포함)는 읽기/쓰기 모두 허용
 */
export async function authGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!authEnabled()) {
    if (openModeAllowed()) return;
    reply
      .status(503)
      .send(authError('authentication is not configured on this server', 'auth_not_configured'));
    return;
  }

  // 1) 세션 쿠키
  const user = await resolveSessionUser(request);
  if (user) {
    request.user = user;
    if (!isReadRequest(request) && user.role !== 'admin') {
      reply.status(403).send({ message: 'admin role required for write operations' });
    }
    return;
  }

  // 2) API 키 (Meilisearch 스타일 Bearer 키)
  const header = request.headers.authorization ?? '';
  const key = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (key) {
    const { rows } = await query<ApiKeyRow>(
      'SELECT id, expires_at, read_only FROM api_keys WHERE key_hash = $1',
      [sha256Hex(key)]
    );
    const row = rows[0];
    if (row) {
      if (row.expires_at && row.expires_at.getTime() <= Date.now()) {
        reply.status(401).send(authError('The provided API key has expired.', 'invalid_api_key'));
        return;
      }
      if (row.read_only && !isReadRequest(request)) {
        reply
          .status(403)
          .send(authError('This API key is read-only (search and get only).', 'invalid_api_key'));
        return;
      }
      // fire-and-forget
      query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [row.id]).catch(() => {});
      return;
    }
  }

  reply.status(401).send({ message: 'unauthorized' });
}

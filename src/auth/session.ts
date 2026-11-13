import { createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { query } from '../db/connection.js';
import { createGatehouseStatus, type GatehouseStatus } from './gatehouseStatus.js';

/** gatehouse 계정 상태 조회기. env 두 개가 다 있을 때만 실제로 묻는다. */
let gatehouse: GatehouseStatus = createGatehouseStatus({
  url: config.gatehouseStatus.url,
  secret: config.gatehouseStatus.secret,
});

/** 테스트에서 가짜 조회기를 끼운다. */
export function setGatehouseStatus(next: GatehouseStatus): void {
  gatehouse = next;
}

/** 세션 쿠키 이름 및 세션 JWT 헬퍼 */

export const SESSION_COOKIE = 'pgsearch_session';
export const SESSION_MAX_AGE_SEC = 7 * 24 * 60 * 60; // 7일

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  role: 'admin' | 'member';
  is_active: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
  }
}

export function signSession(userId: number): string {
  return jwt.sign({ userId }, config.sessionSecret, { expiresIn: '7d' });
}

export function verifySession(token: string): number | null {
  return verifySessionToken(token)?.userId ?? null;
}

/** 세션 JWT 검증. 사용자 id 와 발급 시각(ms)을 돌려준다. */
export function verifySessionToken(
  token: string
): { userId: number; issuedAtMs: number | null } | null {
  try {
    const p = jwt.verify(token, config.sessionSecret) as jwt.JwtPayload;
    if (typeof p.userId !== 'number') return null;
    return { userId: p.userId, issuedAtMs: typeof p.iat === 'number' ? p.iat * 1000 : null };
  } catch {
    return null;
  }
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function getUserById(id: number): Promise<AuthUser | null> {
  const { rows } = await query<AuthUser>(
    'SELECT id, email, name, role, is_active FROM users WHERE id = $1',
    [id]
  );
  return rows[0] ?? null;
}

/** 세션 쿠키에서 활성 사용자를 복원 (없거나 비활성이면 null) */
export async function resolveSessionUser(request: FastifyRequest): Promise<AuthUser | null> {
  const token = request.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const session = verifySessionToken(token);
  if (!session) return null;
  const user = await getUserById(session.userId);
  if (!user || !user.is_active) return null;

  // 대시보드 세션은 전부 SSO(gatehouse) 로 만들어진다. gatehouse 에서 비활성화됐거나
  // 세션 발급 뒤에 "세션 종료"가 눌렸으면 이 세션도 거절한다 (60초 캐시).
  if (gatehouse.enabled) {
    const verdict = await gatehouse.check(user.email, session.issuedAtMs);
    if (!verdict.ok) return null;
  }
  return user;
}

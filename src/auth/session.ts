import { createHash } from 'crypto';
import jwt from 'jsonwebtoken';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { query } from '../db/connection.js';

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
  try {
    const p = jwt.verify(token, config.sessionSecret) as jwt.JwtPayload;
    return typeof p.userId === 'number' ? p.userId : null;
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
  const userId = verifySession(token);
  if (userId === null) return null;
  const user = await getUserById(userId);
  return user && user.is_active ? user : null;
}

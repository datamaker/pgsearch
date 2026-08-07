// 환경 설정

import { randomBytes } from 'crypto';

const sessionSecret = process.env.PGSEARCH_SESSION_SECRET || '';
if (!sessionSecret && process.env.OIDC_ISSUER) {
  console.warn(
    'PGSEARCH_SESSION_SECRET is not set. Falling back to a random per-boot secret; sessions will not survive restarts.'
  );
}

export const config = {
  port: parseInt(process.env.PORT || '7700', 10),
  host: process.env.HOST || '0.0.0.0',

  // 외부에서 접근하는 공개 URL (OIDC redirect_uri 조립에 사용)
  publicUrl: (process.env.PGSEARCH_PUBLIC_URL || '').replace(/\/$/, ''),

  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'jungbin.kwon',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'pgsearch',
  },

  oidc: {
    issuer: (process.env.OIDC_ISSUER || '').replace(/\/$/, ''),
    clientId: process.env.OIDC_CLIENT_ID || 'pgsearch',
    clientSecret: process.env.OIDC_CLIENT_SECRET || '',
  },

  // 이 목록의 이메일은 최초 로그인 시 admin 역할로 프로비저닝됨
  adminEmails: (process.env.PGSEARCH_ADMIN_EMAILS || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean),

  sessionSecret: sessionSecret || randomBytes(32).toString('base64url'),

  search: {
    defaultLimit: 20,
    maxLimit: 1000,
    similarityThreshold: 0.3,  // pg_trgm 유사도 임계값
  },
};

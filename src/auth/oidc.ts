import { createHash, createPublicKey, randomBytes } from 'crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

/**
 * Optional OIDC SSO against an internal IdP. Enabled when OIDC_ISSUER,
 * OIDC_CLIENT_SECRET, and PGSEARCH_PUBLIC_URL are set; otherwise pgsearch
 * runs in open mode (no auth). Server-side redirect flow:
 * /auth/oidc/start -> IdP -> /auth/oidc/callback.
 */

export function authEnabled(): boolean {
  return Boolean(config.oidc.issuer && config.oidc.clientSecret && config.publicUrl);
}

/**
 * 인증 없이(open mode) 돌아도 되는가.
 *
 * 예전에는 OIDC 환경변수 셋 중 하나만 비어도 조용히 전체 API 가 무인증이 됐다
 * (운영에서 변수 하나 빠뜨리면 그대로 전부 공개). 이제 운영(NODE_ENV=production)에서는
 * PGSEARCH_OPEN_MODE=1 로 "일부러 연다"고 밝힌 경우에만 허용한다. 개발 환경은 그대로.
 */
export function openModeAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== 'production' || env.PGSEARCH_OPEN_MODE === '1';
}

export interface AuthBootCheck {
  ok: boolean;
  level: 'info' | 'warn' | 'error';
  message: string;
}

/** 부팅 때 인증 설정을 점검한다. ok 가 false 면 서버를 띄우지 않는다. */
export function checkAuthBootConfig(
  env: NodeJS.ProcessEnv = process.env,
  enabled: boolean = authEnabled()
): AuthBootCheck {
  if (enabled) {
    return { ok: true, level: 'info', message: 'Auth: OIDC SSO enabled.' };
  }
  const missing = [
    ['OIDC_ISSUER', config.oidc.issuer],
    ['OIDC_CLIENT_SECRET', config.oidc.clientSecret],
    ['PGSEARCH_PUBLIC_URL', config.publicUrl],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name)
    .join(', ');
  if (!openModeAllowed(env)) {
    return {
      ok: false,
      level: 'error',
      message:
        `Refusing to start: authentication is not configured (missing: ${missing || 'n/a'}) ` +
        'and NODE_ENV=production. Without it every endpoint would be open to anyone. ' +
        'Set the OIDC variables, or set PGSEARCH_OPEN_MODE=1 to run without authentication on purpose.',
    };
  }
  return {
    ok: true,
    level: 'warn',
    message:
      env.PGSEARCH_OPEN_MODE === '1'
        ? 'Auth: OPEN MODE (PGSEARCH_OPEN_MODE=1) — every endpoint is accessible WITHOUT authentication.'
        : `Auth: open mode (development; missing: ${missing}) — every endpoint is accessible without authentication.`,
  };
}

export function redirectUri(): string {
  return `${config.publicUrl}/auth/oidc/callback`;
}

interface DiscoveryDoc {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

let discoveryCache: DiscoveryDoc | null = null;
let jwksCache: { keys: Array<Record<string, string>> } | null = null;

async function discovery(): Promise<DiscoveryDoc> {
  if (!discoveryCache) {
    const res = await fetch(`${config.oidc.issuer}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`sso discovery failed: ${res.status}`);
    discoveryCache = (await res.json()) as DiscoveryDoc;
  }
  return discoveryCache;
}

async function signingKey(kid: string | undefined): Promise<ReturnType<typeof createPublicKey>> {
  if (!jwksCache?.keys?.some(k => k.kid === kid)) {
    const { jwks_uri: jwksUri } = await discovery();
    const res = await fetch(jwksUri);
    if (!res.ok) throw new Error(`sso jwks fetch failed: ${res.status}`);
    jwksCache = (await res.json()) as { keys: Array<Record<string, string>> };
  }
  const jwk = jwksCache.keys.find(k => k.kid === kid);
  if (!jwk) throw new Error('sso id_token signed with unknown key');
  return createPublicKey({ key: jwk, format: 'jwk' });
}

export interface OidcStart {
  url: string;
  state: string;
  verifier: string;
}

export async function buildAuthUrl(): Promise<OidcStart> {
  const { authorization_endpoint: authEndpoint } = await discovery();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');

  const url = new URL(authEndpoint);
  url.searchParams.set('client_id', config.oidc.clientId);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  return { url: url.href, state, verifier };
}

/** Short-lived signed blob for the state/verifier round-trip cookie. */
export function signOidcState(payload: { state: string; verifier: string }): string {
  return jwt.sign(payload, config.sessionSecret, { expiresIn: '10m' });
}

export function verifyOidcState(token: string): { state: string; verifier: string } | null {
  try {
    const p = jwt.verify(token, config.sessionSecret) as jwt.JwtPayload;
    if (typeof p.state !== 'string' || typeof p.verifier !== 'string') return null;
    return { state: p.state, verifier: p.verifier };
  } catch {
    return null;
  }
}

export interface OidcIdentity {
  email: string;
  name: string;
}

export async function exchangeCode(code: string, verifier: string): Promise<OidcIdentity> {
  const { token_endpoint: tokenEndpoint } = await discovery();
  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: config.oidc.clientId,
      client_secret: config.oidc.clientSecret,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(`sso token exchange failed: ${(await res.text()).slice(0, 200)}`);
  const { id_token: idToken } = (await res.json()) as { id_token?: string };
  if (!idToken) throw new Error('sso response missing id_token');

  const decoded = jwt.decode(idToken, { complete: true });
  const key = await signingKey(decoded?.header.kid);
  const claims = await new Promise<jwt.JwtPayload>((resolve, reject) => {
    jwt.verify(idToken, key, { issuer: config.oidc.issuer, audience: config.oidc.clientId }, (err, c) => {
      if (err) reject(err);
      else resolve(c as jwt.JwtPayload);
    });
  });

  const email = String(claims.email ?? '').toLowerCase();
  if (!email || claims.email_verified !== true) throw new Error('sso identity has no verified email');
  return { email, name: String(claims.name ?? email) };
}

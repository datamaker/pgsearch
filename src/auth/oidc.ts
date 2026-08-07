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

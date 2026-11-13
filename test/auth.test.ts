// 인증 관련 테스트 (OIDC 설정된 상태 = 인증 켜짐):
//  - API 키: 만료(expires_at), 읽기 전용(read_only), 기존 키 호환, 생성 API 검증
//  - 세션: gatehouse 계정 상태 확인 (사내 공통 계약 A, 가짜 fetch 주입)
//  - 멤버 세션의 읽기/쓰기 구분
//
// 실제 PostgreSQL 이 필요하다 (README 의 Testing 참고). IdP 로는 요청을 보내지 않는다.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';

if (!(process.env.DB_NAME || '').includes('test')) {
  throw new Error(
    'Refusing to run: set DB_NAME to a throwaway database whose name contains "test".'
  );
}
// config 는 import 시점에 환경변수를 읽는다 — 인증이 켜지도록 먼저 채운다.
process.env.OIDC_ISSUER = 'https://idp.invalid/oidc';
process.env.OIDC_CLIENT_SECRET = 'test-client-secret';
process.env.PGSEARCH_PUBLIC_URL = 'http://localhost:7700';
process.env.PGSEARCH_SESSION_SECRET = 'test-session-secret';
delete process.env.GATEHOUSE_STATUS_URL;
delete process.env.GATEHOUSE_STATUS_SECRET;

const { pool, closePool } = await import('../src/db/connection.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { buildApp } = await import('../src/app.js');
const { createIndex, deleteIndex } = await import('../src/services/indexService.js');
const { addDocuments } = await import('../src/services/documentService.js');
const { SESSION_COOKIE, signSession, sha256Hex, setGatehouseStatus } = await import(
  '../src/auth/session.js'
);
const { createGatehouseStatus } = await import('../src/auth/gatehouseStatus.js');
const { authEnabled } = await import('../src/auth/oidc.js');

const suffix = `${process.pid}_${Date.now()}`;
const INDEX = `t_auth_${suffix}`;
const ADMIN_EMAIL = `admin_${suffix}@example.com`;
const MEMBER_EMAIL = `member_${suffix}@example.com`;

let app: FastifyInstance;
let adminId: number;
let memberId: number;
const createdKeyIds: number[] = [];

const cookie = (userId: number) => ({ cookie: `${SESSION_COOKIE}=${signSession(userId)}` });
const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

/** DB 에 직접 키를 넣는다 (만료된 키처럼 API 로는 만들 수 없는 상태용). */
async function insertKey(name: string, opts: { expiresAt?: Date | null; readOnly?: boolean; legacy?: boolean } = {}) {
  const raw = `raw_${name}_${suffix}`;
  const { rows } = opts.legacy
    ? // 마이그레이션 전부터 있던 키처럼 새 컬럼을 건드리지 않고 넣는다.
      await pool.query('INSERT INTO api_keys (name, key_hash) VALUES ($1, $2) RETURNING id', [name, sha256Hex(raw)])
    : await pool.query(
        'INSERT INTO api_keys (name, key_hash, expires_at, read_only) VALUES ($1, $2, $3, $4) RETURNING id',
        [name, sha256Hex(raw), opts.expiresAt ?? null, opts.readOnly ?? false]
      );
  createdKeyIds.push(rows[0].id);
  return raw;
}

before(async () => {
  await runMigrations();
  assert.equal(authEnabled(), true);
  const users = await pool.query(
    `INSERT INTO users (email, name, role) VALUES ($1, 'Admin', 'admin'), ($2, 'Member', 'member')
     RETURNING id, role`,
    [ADMIN_EMAIL, MEMBER_EMAIL]
  );
  adminId = users.rows.find(r => r.role === 'admin').id;
  memberId = users.rows.find(r => r.role === 'member').id;

  await createIndex(INDEX, 'id');
  await addDocuments(INDEX, [
    { id: 1, title: 'Buffer solution for PCR' },
    { id: 2, title: 'PCR tube rack' },
  ]);
  app = await buildApp();
  await app.ready();
});

after(async () => {
  setGatehouseStatus(createGatehouseStatus());
  await app?.close();
  await deleteIndex(INDEX).catch(() => {});
  await pool.query('DELETE FROM ms_tasks WHERE index_uid = $1', [INDEX]);
  await pool.query('DELETE FROM api_keys WHERE id = ANY($1) OR name LIKE $2', [createdKeyIds, `%${suffix}`]);
  await pool.query('DELETE FROM users WHERE id = ANY($1)', [[adminId, memberId]]);
  await closePool();
});

// ─── 기본 가드 ───────────────────────────────────────────────

describe('인증 가드 기본', () => {
  test('자격증명 없으면 401', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/indexes' })).statusCode, 401);
    const res = await app.inject({ method: 'POST', url: `/indexes/${INDEX}/search`, payload: { q: 'pcr' } });
    assert.equal(res.statusCode, 401);
  });

  test('모르는 키는 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/indexes', headers: bearer('nope') });
    assert.equal(res.statusCode, 401);
  });
});

// ─── API 키 ──────────────────────────────────────────────────

describe('API 키: 만료와 읽기 전용', () => {
  test('마이그레이션: 새 컬럼이 있고 기본값은 무기한·전체 권한', async () => {
    const { rows } = await pool.query(
      `SELECT column_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'api_keys' AND column_name IN ('expires_at', 'read_only') ORDER BY column_name`
    );
    assert.deepEqual(rows.map(r => r.column_name), ['expires_at', 'read_only']);
    assert.equal(rows[0].is_nullable, 'YES');
    assert.equal(rows[1].column_default, 'false');
  });

  test('기존 방식 키(새 컬럼 미지정)는 읽기·쓰기 모두 되고 만료가 없다', async () => {
    const key = await insertKey('legacy', { legacy: true });
    const read = await app.inject({ method: 'GET', url: `/indexes/${INDEX}/documents`, headers: bearer(key) });
    assert.equal(read.statusCode, 200);
    const write = await app.inject({
      method: 'POST',
      url: `/indexes/${INDEX}/documents`,
      headers: bearer(key),
      payload: [{ id: 3, title: 'added by legacy key' }],
    });
    assert.equal(write.statusCode, 202, write.body);
    const del = await app.inject({ method: 'DELETE', url: `/indexes/${INDEX}/documents/3`, headers: bearer(key) });
    assert.equal(del.statusCode, 202);
  });

  test('만료된 키는 401, 만료 전 키는 통과', async () => {
    const expired = await insertKey('expired', { expiresAt: new Date(Date.now() - 1000) });
    const res = await app.inject({ method: 'GET', url: '/indexes', headers: bearer(expired) });
    assert.equal(res.statusCode, 401);
    assert.equal(res.json().code, 'invalid_api_key');
    const search = await app.inject({
      method: 'POST',
      url: `/indexes/${INDEX}/search`,
      headers: bearer(expired),
      payload: { q: 'pcr' },
    });
    assert.equal(search.statusCode, 401);

    const valid = await insertKey('not-yet-expired', { expiresAt: new Date(Date.now() + 3600_000) });
    assert.equal((await app.inject({ method: 'GET', url: '/indexes', headers: bearer(valid) })).statusCode, 200);
  });

  test('읽기 전용 키: 조회·검색(GET/POST)은 되고 쓰기는 전부 403', async () => {
    const key = await insertKey('readonly', { readOnly: true });
    const h = bearer(key);

    const allowed: [string, string, unknown?][] = [
      ['GET', '/indexes'],
      ['GET', `/indexes/${INDEX}`],
      ['GET', `/indexes/${INDEX}/documents`],
      ['GET', `/indexes/${INDEX}/documents/1`],
      ['GET', `/indexes/${INDEX}/settings`],
      ['GET', `/indexes/${INDEX}/search?q=pcr`],
      ['POST', `/indexes/${INDEX}/search`, { q: 'pcr' }],
    ];
    for (const [method, url, payload] of allowed) {
      const res = await app.inject({ method: method as 'GET', url, headers: h, payload: payload as object });
      assert.equal(res.statusCode, 200, `${method} ${url}: ${res.body}`);
    }
    const hits = await app.inject({ method: 'POST', url: `/indexes/${INDEX}/search`, headers: h, payload: { q: 'pcr' } });
    assert.equal(hits.json().hits.length, 2);

    const denied: [string, string, unknown?][] = [
      ['POST', '/indexes', { uid: `t_denied_${suffix}` }],
      ['PATCH', `/indexes/${INDEX}`, { primaryKey: 'id' }],
      ['DELETE', `/indexes/${INDEX}`],
      ['POST', `/indexes/${INDEX}/documents`, [{ id: 9, title: 'x' }]],
      ['PUT', `/indexes/${INDEX}/documents`, [{ id: 9, title: 'x' }]],
      ['DELETE', `/indexes/${INDEX}/documents`],
      ['DELETE', `/indexes/${INDEX}/documents/1`],
      ['POST', `/indexes/${INDEX}/documents/delete-batch`, [1]],
      ['PATCH', `/indexes/${INDEX}/settings`, { stopWords: ['the'] }],
      ['DELETE', `/indexes/${INDEX}/settings`],
      ['PUT', `/indexes/${INDEX}/settings/stop-words`, ['the']],
      // 경로를 꼬아서 검색 라우트인 척해도 매칭된 라우트로 판단하므로 통하지 않는다
      ['POST', `/indexes/${INDEX}/documents?x=/search`, [{ id: 9, title: 'x' }]],
    ];
    for (const [method, url, payload] of denied) {
      const res = await app.inject({ method: method as 'POST', url, headers: h, payload: payload as object });
      assert.equal(res.statusCode, 403, `${method} ${url}: ${res.body}`);
      assert.equal(res.json().code, 'invalid_api_key');
    }

    // 실제로 아무것도 바뀌지 않았다
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM ms_documents WHERE index_uid = $1', [INDEX]);
    assert.equal(rows[0].n, 2);
    const idx = await pool.query('SELECT 1 FROM ms_indexes WHERE uid = $1', [`t_denied_${suffix}`]);
    assert.equal(idx.rowCount, 0);
  });

  test('읽기 전용 키로는 키·멤버 관리 API 에 접근할 수 없다', async () => {
    const key = await insertKey('readonly-admin-probe', { readOnly: true });
    for (const url of ['/auth/keys', '/auth/users']) {
      const res = await app.inject({ method: 'GET', url, headers: bearer(key) });
      assert.equal(res.statusCode, 403, url);
    }
  });

  test('생성 API: read_only / expires_at 을 받아 저장하고, 목록에 보인다', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const created = await app.inject({
      method: 'POST',
      url: '/auth/keys',
      headers: cookie(adminId),
      payload: { name: `ro_${suffix}`, read_only: true, expires_at: expiresAt },
    });
    assert.equal(created.statusCode, 201, created.body);
    const body = created.json();
    createdKeyIds.push(body.id);
    assert.equal(body.read_only, true);
    assert.equal(new Date(body.expires_at).toISOString(), expiresAt);
    assert.ok(body.key.length >= 40);

    // 만든 키가 실제로 읽기 전용으로 동작
    const write = await app.inject({ method: 'DELETE', url: `/indexes/${INDEX}/documents`, headers: bearer(body.key) });
    assert.equal(write.statusCode, 403);
    const read = await app.inject({ method: 'GET', url: `/indexes/${INDEX}/documents`, headers: bearer(body.key) });
    assert.equal(read.statusCode, 200);

    const list = await app.inject({ method: 'GET', url: '/auth/keys', headers: cookie(adminId) });
    const row = list.json().results.find((k: { id: number }) => k.id === body.id);
    assert.equal(row.read_only, true);
    assert.ok(row.expires_at);
    assert.equal(row.key, undefined);
    assert.equal(row.key_hash, undefined);
  });

  test('생성 API: 옵션을 생략하면 예전과 같은 전체 권한·무기한 키', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/auth/keys',
      headers: cookie(adminId),
      payload: { name: `plain_${suffix}` },
    });
    assert.equal(created.statusCode, 201);
    createdKeyIds.push(created.json().id);
    assert.equal(created.json().read_only, false);
    assert.equal(created.json().expires_at, null);
  });

  test('생성 API: 잘못된 값은 400', async () => {
    const bad: Record<string, unknown>[] = [
      { name: `b1_${suffix}`, expires_at: 'not a date' },
      { name: `b2_${suffix}`, expires_at: new Date(Date.now() - 1000).toISOString() },
      { name: `b3_${suffix}`, expires_at: 12345 },
      { name: `b4_${suffix}`, read_only: 'yes' },
      { name: '' },
      { name: 'x'.repeat(101) },
    ];
    for (const payload of bad) {
      const res = await app.inject({ method: 'POST', url: '/auth/keys', headers: cookie(adminId), payload });
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
    }
  });

  test('멤버는 키를 만들 수 없다', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/keys',
      headers: cookie(memberId),
      payload: { name: `m_${suffix}` },
    });
    assert.equal(res.statusCode, 403);
  });
});

// ─── 세션 역할 ───────────────────────────────────────────────

describe('세션: 멤버는 읽기·검색만', () => {
  test('멤버: GET·검색 POST 는 200, 쓰기는 403', async () => {
    const h = cookie(memberId);
    assert.equal((await app.inject({ method: 'GET', url: '/indexes', headers: h })).statusCode, 200);
    const search = await app.inject({ method: 'POST', url: `/indexes/${INDEX}/search`, headers: h, payload: { q: 'pcr' } });
    assert.equal(search.statusCode, 200, search.body);
    const write = await app.inject({ method: 'DELETE', url: `/indexes/${INDEX}/documents`, headers: h });
    assert.equal(write.statusCode, 403);
  });
});

// ─── gatehouse 계정 상태 ─────────────────────────────────────

describe('gatehouse 계정 상태 확인 (계약 A)', () => {
  type Reply = { status: number; body?: unknown } | Error;
  let reply: Reply = { status: 200, body: { active: true, revoked_before: null } };
  let calls: { url: string; secret: string }[] = [];
  let clock = Date.now();

  function install(): void {
    calls = [];
    clock = Date.now();
    setGatehouseStatus(
      createGatehouseStatus({
        url: 'https://auth.example.test',
        secret: 'shared-secret',
        now: () => clock,
        warn: () => {},
        fetch: async (url, init) => {
          calls.push({ url, secret: init.headers['X-Gatehouse-Secret'] });
          if (reply instanceof Error) throw reply;
          const r = reply;
          return { status: r.status, json: async () => r.body };
        },
      })
    );
  }
  const status = async (userId: number) =>
    (await app.inject({ method: 'GET', url: '/auth/status', headers: cookie(userId) })).json();
  const list = (userId: number) => app.inject({ method: 'GET', url: '/indexes', headers: cookie(userId) });

  test('env 가 없으면(기본) 꺼져 있고 세션은 그대로 유효', async () => {
    setGatehouseStatus(createGatehouseStatus());
    assert.equal((await list(adminId)).statusCode, 200);
  });

  test('active 면 통과하고, 요청은 계약대로 (경로·이메일·시크릿 헤더)', async () => {
    reply = { status: 200, body: { active: true, revoked_before: null } };
    install();
    assert.equal((await list(adminId)).statusCode, 200);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      `https://auth.example.test/internal/account?email=${encodeURIComponent(ADMIN_EMAIL)}`
    );
    assert.equal(calls[0].secret, 'shared-secret');
  });

  test('비활성화되면 60초 캐시가 지난 뒤 401 — API·대시보드 상태·관리 라우트 모두', async () => {
    reply = { status: 200, body: { active: true, revoked_before: null } };
    install();
    assert.equal((await list(adminId)).statusCode, 200);

    reply = { status: 200, body: { active: false, revoked_before: null } };
    assert.equal((await list(adminId)).statusCode, 200, '캐시 안에서는 아직 통과');
    assert.equal(calls.length, 1);

    clock += 61_000;
    assert.equal((await list(adminId)).statusCode, 401);
    assert.equal((await status(adminId)).user, null);
    const keys = await app.inject({ method: 'GET', url: '/auth/keys', headers: cookie(adminId) });
    assert.equal(keys.statusCode, 403);
    assert.equal(calls.length, 2, '이메일별 캐시로 한 번만 더 물었다');
  });

  test('404(gatehouse 가 모르는 이메일)는 비활성 취급', async () => {
    reply = { status: 404, body: { active: false } };
    install();
    assert.equal((await list(memberId)).statusCode, 401);
  });

  test('revoked_before 이전에 발급된 세션은 거절, 이후 발급은 통과', async () => {
    reply = { status: 200, body: { active: true, revoked_before: new Date(Date.now() + 60_000).toISOString() } };
    install();
    assert.equal((await list(adminId)).statusCode, 401);

    reply = { status: 200, body: { active: true, revoked_before: new Date(Date.now() - 3600_000).toISOString() } };
    install();
    assert.equal((await list(adminId)).statusCode, 200);
  });

  test('gatehouse 장애: 성공한 적 없으면 통과, 있으면 마지막 결과 유지', async () => {
    reply = new Error('ECONNREFUSED');
    install();
    assert.equal((await list(adminId)).statusCode, 200);

    reply = { status: 200, body: { active: false, revoked_before: null } };
    install();
    assert.equal((await list(adminId)).statusCode, 401);
    reply = { status: 503 };
    clock += 61_000;
    assert.equal((await list(adminId)).statusCode, 401, '장애 중에도 마지막으로 확인된 비활성 상태를 쓴다');
  });

  test('API 키(기계용)는 gatehouse 를 묻지 않는다', async () => {
    reply = { status: 404, body: { active: false } };
    install();
    const key = await insertKey('machine');
    const res = await app.inject({ method: 'GET', url: '/indexes', headers: bearer(key) });
    assert.equal(res.statusCode, 200);
    assert.equal(calls.length, 0);
    setGatehouseStatus(createGatehouseStatus());
  });
});

// 필터 연산자 파싱, 검색어(tsquery) 특수문자, 목록 페이지네이션, 에러 응답,
// open mode(인증 미설정) 부팅 정책 테스트.
//
// 이 파일은 OIDC 환경변수 없이 돈다 = open mode. 실제 PostgreSQL 이 필요하다
// (README 의 Testing 참고). DB_NAME 에 "test" 가 없으면 시작하지 않는다.

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

if (!(process.env.DB_NAME || '').includes('test')) {
  throw new Error(
    'Refusing to run: set DB_NAME to a throwaway database whose name contains "test".'
  );
}
delete process.env.OIDC_ISSUER;
delete process.env.OIDC_CLIENT_SECRET;
delete process.env.PGSEARCH_PUBLIC_URL;
delete process.env.PGSEARCH_OPEN_MODE;
delete process.env.NODE_ENV;

const { pool, closePool } = await import('../src/db/connection.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { buildApp } = await import('../src/app.js');
const { createIndex, deleteIndex } = await import('../src/services/indexService.js');
const { addDocuments } = await import('../src/services/documentService.js');
const { parseFilter } = await import('../src/services/filterParser.js');
const { toTsQuery } = await import('../src/services/searchService.js');
const { checkAuthBootConfig, openModeAllowed } = await import('../src/auth/oidc.js');

const suffix = `${process.pid}_${Date.now()}`;
const INDEX = `t_filter_${suffix}`;

let app: FastifyInstance;

async function search(body: unknown) {
  const res = await app.inject({ method: 'POST', url: `/indexes/${INDEX}/search`, payload: body as object });
  return { status: res.statusCode, json: res.json() };
}
const ids = (json: { hits: { id: number }[] }) => json.hits.map(h => h.id).sort((a, b) => a - b);

before(async () => {
  await runMigrations();
  await createIndex(INDEX, 'id');
  await addDocuments(INDEX, [
    { id: 1, title: 'Buffer solution for PCR', status: 'active', price: 10, url: 'a=b' },
    { id: 2, title: 'PCR tube rack (R&D) C++', status: 'active', price: 30 },
    { id: 3, title: "Glass beaker it's 1.5 L", status: 'archived', price: 20 },
    { id: 4, title: 'Unpriced anti-mouse item', status: 'draft', price: 'N/A' },
    { id: 5, title: 'No price field at all', status: 'draft' },
  ]);
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app?.close();
  await deleteIndex(INDEX).catch(() => {});
  await pool.query('DELETE FROM ms_tasks WHERE index_uid = $1', [INDEX]);
  await closePool();
});

// ─── 필터 연산자 ─────────────────────────────────────────────

describe('필터 연산자 파싱 (>=, <=, != 우선순위)', () => {
  test('두 글자 연산자가 필드명에 섞이지 않는다', () => {
    const cases: [string, string, string, unknown][] = [
      ['price >= 10', 'price', '>=', 10],
      ['price <= 10', 'price', '<=', 10],
      ['price != 10', 'price', 'IS DISTINCT FROM', 10],
      ['price > 10', 'price', '>', 10],
      ['price < 10', 'price', '<', 10],
      ['price = 10', 'price', '=', 10],
      ['price>=10', 'price', '>=', 10],
      ["status != 'active'", 'status', 'IS DISTINCT FROM', 'active'],
      ["status = 'active'", 'status', '=', 'active'],
    ];
    for (const [filter, field, op, value] of cases) {
      const parsed = parseFilter(filter, 2)!;
      assert.deepEqual(parsed.params, [field, value], filter);
      assert.ok(parsed.sql.includes(` ${op} $3`), `${filter} → ${parsed.sql}`);
      // 필드명은 항상 바인드 파라미터로만 나간다
      assert.ok(!parsed.sql.includes('price') && !parsed.sql.includes('status'), parsed.sql);
    }
  });

  test('값 안의 연산자 문자는 값으로 남는다', () => {
    assert.deepEqual(parseFilter("url = 'a=b'")!.params, ['url', 'a=b']);
    assert.deepEqual(parseFilter("note = 'x >= y'")!.params, ['note', 'x >= y']);
    assert.deepEqual(parseFilter("tag IN ['a=b', 'c']")!.params, ['tag', ['a=b', 'c']]);
  });

  test('IS NULL / IS NOT NULL / 잘못된 문법', () => {
    assert.deepEqual(parseFilter('price IS NULL')!.params, ['price']);
    assert.ok(parseFilter('price IS NOT NULL')!.sql.includes('IS NOT NULL'));
    assert.throws(() => parseFilter('just words'), /Invalid filter syntax/);
    assert.throws(() => parseFilter('>= 10'), /Invalid filter syntax/);
  });

  test('실제 검색 결과: >=, <=, !=, >, <, =', async () => {
    const expected: [string, number[]][] = [
      ['price >= 20', [2, 3]],
      ['price <= 20', [1, 3]],
      ['price > 20', [2]],
      ['price < 20', [1]],
      ['price = 20', [3]],
      // != 는 그 값이 아닌 모든 문서 (숫자가 아니거나 필드가 없는 문서 포함)
      ['price != 20', [1, 2, 4, 5]],
      ["status != 'active'", [3, 4, 5]],
      ['price >= 10 AND price <= 20', [1, 3]],
      ["(price >= 30 OR price <= 10) AND status = 'active'", [1, 2]],
      ["url = 'a=b'", [1]],
    ];
    for (const [filter, want] of expected) {
      const { status, json } = await search({ filter, limit: 50 });
      assert.equal(status, 200, `${filter}: ${JSON.stringify(json)}`);
      assert.deepEqual(ids(json), want, filter);
    }
  });

  test('배열 형식 필터에서도 동작', async () => {
    const { status, json } = await search({ filter: [['price >= 30', 'price <= 10'], "status != 'archived'"] });
    assert.equal(status, 200, JSON.stringify(json));
    assert.deepEqual(ids(json), [1, 2]);
  });

  test('숫자가 아닌 값("N/A")을 가진 문서가 있어도 숫자 비교가 500 을 내지 않는다', async () => {
    const { status, json } = await search({ filter: 'price >= 0', limit: 50 });
    assert.equal(status, 200, JSON.stringify(json));
    assert.deepEqual(ids(json), [1, 2, 3]);
  });
});

// ─── 검색어 특수문자 ─────────────────────────────────────────

describe('검색어의 tsquery 특수문자', () => {
  const nasty = [
    'C++ (R&D)',
    "it's",
    'a:b',
    'pcr & | ! tube',
    '(((',
    ')',
    '!!!',
    "'",
    "''",
    '\\',
    'foo\\',
    '<->',
    'pcr:*',
    'a <2> b',
    ':*',
    '&',
    'tube|rack',
    '!pcr',
    '\u0000pcr\u0000',
    'pcr\ttube\nrack',
    '한글 검색 "따옴표"',
    "x'||(select 1/0)::text||'",
  ];

  test('어떤 특수문자 조합도 500 을 내지 않는다', async () => {
    for (const q of nasty) {
      const { status, json } = await search({ q, attributesToHighlight: ['title'], showRankingScore: true });
      assert.equal(status, 200, `${JSON.stringify(q)} → ${JSON.stringify(json)}`);
      assert.ok(Array.isArray(json.hits));
    }
  });

  test('to_tsquery 가 실제로 받아들이는 문자열을 만든다', async () => {
    for (const q of nasty) {
      const tsq = toTsQuery(q);
      await pool.query("SELECT to_tsquery('simple', $1)", [tsq]); // 문법 오류면 여기서 던진다
    }
  });

  test('글자·숫자가 없는 단어는 버리고, 나머지는 따옴표 리터럴로 감싼다', () => {
    assert.equal(toTsQuery('   '), '');
    assert.equal(toTsQuery('!!! &&'), '');
    assert.equal(toTsQuery('pcr tube'), "'pcr':* & 'tube':*");
    assert.equal(toTsQuery("it's"), "'it''s':*");
    assert.equal(toTsQuery('a\\b'), "'a\\\\b':*");
  });

  test('평범한 검색은 그대로 찾는다 (접두어, 하이픈, 소수점, 특수문자 섞인 단어)', async () => {
    assert.deepEqual(ids((await search({ q: 'pcr' })).json), [1, 2]);
    assert.deepEqual(ids((await search({ q: 'buf' })).json), [1]);
    assert.ok(ids((await search({ q: 'anti-mouse' })).json).includes(4));
    assert.ok(ids((await search({ q: '1.5' })).json).includes(3));
    assert.ok(ids((await search({ q: 'R&D' })).json).includes(2));
    assert.ok(ids((await search({ q: "it's" })).json).includes(3));
  });
});

// ─── 에러 응답에 DB 내용이 새지 않는다 ───────────────────────

describe('전역 에러 핸들러', () => {
  const LEAKS = /postgres|pg_|syntax error|tsquery|byte sequence|relation|column|ms_documents|select |\$\d/i;

  test('DB 에러는 500 + 일반 메시지 (Meilisearch 형식), 원인은 응답에 없다', async () => {
    // NUL 바이트는 PostgreSQL text 로 바인딩할 수 없어 DB 에러가 난다.
    const { status, json } = await search({ facets: ['bad\u0000facet'] });
    assert.equal(status, 500);
    assert.deepEqual(json, {
      message: 'An internal error has occurred.',
      code: 'internal',
      type: 'internal',
      link: 'https://docs.meilisearch.com/errors#internal',
    });
    assert.ok(!LEAKS.test(JSON.stringify(json)));
  });

  test('문서 추가 중 DB 에러도 400 본문으로 새지 않는다', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/indexes/${INDEX}/documents`,
      payload: [{ id: 'nul-doc', title: 'bad \u0000 byte' }],
    });
    assert.ok(res.statusCode === 500 || res.statusCode === 202, String(res.statusCode));
    assert.ok(!LEAKS.test(res.body), res.body);
    await app.inject({ method: 'DELETE', url: `/indexes/${INDEX}/documents/nul-doc` });
  });

  test('잘못된 JSON 본문은 400 + Meilisearch 형식', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/indexes/${INDEX}/search`,
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'bad_request');
    assert.equal(res.json().type, 'invalid_request');
  });

  test('필터 문법 오류는 여전히 400 invalid_search_filter', async () => {
    const { status, json } = await search({ filter: 'a = 1) OR (b = 2' });
    assert.equal(status, 400);
    assert.equal(json.code, 'invalid_search_filter');
  });
});

// ─── 목록 limit/offset ──────────────────────────────────────

describe('문서·인덱스 목록의 limit/offset 검증', () => {
  const get = async (url: string) => {
    const res = await app.inject({ method: 'GET', url });
    return { status: res.statusCode, json: res.json() };
  };

  test('문서 목록: 기본값, 정상 값', async () => {
    const def = await get(`/indexes/${INDEX}/documents`);
    assert.equal(def.status, 200);
    assert.equal(def.json.limit, 20);
    assert.equal(def.json.offset, 0);
    assert.equal(def.json.total, 5);
    const page = await get(`/indexes/${INDEX}/documents?limit=2&offset=1`);
    assert.equal(page.status, 200);
    assert.equal(page.json.results.length, 2);
  });

  test('문서 목록: limit 은 상한(1000)으로 잘린다', async () => {
    const { status, json } = await get(`/indexes/${INDEX}/documents?limit=100000000`);
    assert.equal(status, 200);
    assert.equal(json.limit, 1000);
  });

  test('문서 목록: 음수·문자·소수는 400 (예전에는 500 또는 조용히 통과)', async () => {
    for (const [qs, code] of [
      ['limit=-1', 'invalid_document_limit'],
      ['limit=abc', 'invalid_document_limit'],
      ['limit=10abc', 'invalid_document_limit'],
      ['limit=1.5', 'invalid_document_limit'],
      ['offset=-5', 'invalid_document_offset'],
      ['offset=1e3', 'invalid_document_offset'],
      ['offset=99999999999999999999', 'invalid_document_offset'],
    ]) {
      const { status, json } = await get(`/indexes/${INDEX}/documents?${qs}`);
      assert.equal(status, 400, qs);
      assert.equal(json.code, code, qs);
    }
  });

  test('인덱스 목록: 같은 규칙', async () => {
    const ok = await get('/indexes?limit=5&offset=0');
    assert.equal(ok.status, 200);
    assert.equal(ok.json.limit, 5);
    const capped = await get('/indexes?limit=999999');
    assert.equal(capped.json.limit, 1000);
    for (const [qs, code] of [
      ['limit=-1', 'invalid_index_limit'],
      ['limit=x', 'invalid_index_limit'],
      ['offset=-1', 'invalid_index_offset'],
    ]) {
      const { status, json } = await get(`/indexes?${qs}`);
      assert.equal(status, 400, qs);
      assert.equal(json.code, code, qs);
    }
  });
});

// ─── 인증 미설정(open mode) 정책 ─────────────────────────────

describe('인증 미설정 시 fail-closed', () => {
  test('openModeAllowed: 운영에서는 PGSEARCH_OPEN_MODE=1 일 때만', () => {
    assert.equal(openModeAllowed({}), true);
    assert.equal(openModeAllowed({ NODE_ENV: 'development' }), true);
    assert.equal(openModeAllowed({ NODE_ENV: 'production' }), false);
    assert.equal(openModeAllowed({ NODE_ENV: 'production', PGSEARCH_OPEN_MODE: 'true' }), false);
    assert.equal(openModeAllowed({ NODE_ENV: 'production', PGSEARCH_OPEN_MODE: '1' }), true);
  });

  test('checkAuthBootConfig: 운영 + 미설정이면 부팅 거부, 메시지에 빠진 변수 이름', () => {
    const refused = checkAuthBootConfig({ NODE_ENV: 'production' }, false);
    assert.equal(refused.ok, false);
    assert.equal(refused.level, 'error');
    assert.match(refused.message, /OIDC_ISSUER/);
    assert.match(refused.message, /PGSEARCH_OPEN_MODE=1/);

    const explicit = checkAuthBootConfig({ NODE_ENV: 'production', PGSEARCH_OPEN_MODE: '1' }, false);
    assert.equal(explicit.ok, true);
    assert.equal(explicit.level, 'warn');
    assert.match(explicit.message, /OPEN MODE/);

    const dev = checkAuthBootConfig({}, false);
    assert.equal(dev.ok, true);
    assert.equal(dev.level, 'warn');

    const configured = checkAuthBootConfig({ NODE_ENV: 'production' }, true);
    assert.deepEqual([configured.ok, configured.level], [true, 'info']);
  });

  test('가드: 개발 환경 open mode 는 그대로 열려 있다', async () => {
    const res = await app.inject({ method: 'GET', url: '/indexes' });
    assert.equal(res.statusCode, 200);
  });

  test('가드: 운영인데 인증이 미설정이면 API 를 열지 않는다(503), OPEN_MODE=1 이면 연다', async () => {
    process.env.NODE_ENV = 'production';
    try {
      const closed = await app.inject({ method: 'GET', url: '/indexes' });
      assert.equal(closed.statusCode, 503);
      assert.equal(closed.json().code, 'auth_not_configured');
      const write = await app.inject({ method: 'DELETE', url: `/indexes/${INDEX}` });
      assert.equal(write.statusCode, 503);
      // 헬스체크는 계속 응답한다
      assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);

      process.env.PGSEARCH_OPEN_MODE = '1';
      const open = await app.inject({ method: 'GET', url: '/indexes' });
      assert.equal(open.statusCode, 200);
    } finally {
      delete process.env.NODE_ENV;
      delete process.env.PGSEARCH_OPEN_MODE;
    }
  });

  test('실제 부팅: NODE_ENV=production + OIDC 미설정이면 종료 코드 1 로 죽는다', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', PORT: '0' };
    delete env.OIDC_ISSUER;
    delete env.OIDC_CLIENT_SECRET;
    delete env.PGSEARCH_PUBLIC_URL;
    delete env.PGSEARCH_OPEN_MODE;
    delete env.NODE_TEST_CONTEXT;
    const res = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(res.status, 1, res.stdout + res.stderr);
    assert.match(res.stderr, /Refusing to start/);
    assert.ok(!/PgSearch is running/.test(res.stdout));
  });
});

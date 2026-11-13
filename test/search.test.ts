// 검색 엔드포인트 회귀 테스트 (SQL 인젝션 / 요청 검증)
//
// 실제 PostgreSQL(pg_trgm 포함)이 필요하다. 실행 방법은 README의 Testing 참고.
// 테스트는 DB에 인덱스/문서를 쓰고 지우므로, 실수로 운영 DB에 붙지 않도록
// DB_NAME에 "test"가 들어 있지 않으면 시작하지 않는다.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';

if (!(process.env.DB_NAME || '').includes('test')) {
  throw new Error(
    'Refusing to run: set DB_NAME to a throwaway database whose name contains "test".'
  );
}

const { config } = await import('../src/config.js');
const { pool, closePool } = await import('../src/db/connection.js');
const { runMigrations } = await import('../src/db/migrate.js');
const { searchRoutes } = await import('../src/routes/search.js');
const { createIndex, deleteIndex } = await import('../src/services/indexService.js');
const { addDocuments } = await import('../src/services/documentService.js');

const suffix = `${process.pid}_${Date.now()}`;
const INDEX = `t_search_${suffix}`;
const OTHER_INDEX = `t_other_${suffix}`;

// 고전적인 error-based 인젝션 페이로드. 수정 전에는 SQL 리터럴을 닫고 나가서
// "division by zero" 500을 냈다.
const INJECTION = "x'||(select 1/0)::text||'";

let app: FastifyInstance;

// 테스트 동안 DB로 나간 모든 SQL 텍스트를 기록한다 — 요청 값이 SQL 문자열에
// 섞여 들어가지 않았는지 직접 확인하기 위해서.
const executedSql: string[] = [];
const originalQuery = pool.query.bind(pool);
(pool as unknown as { query: unknown }).query = (text: unknown, ...rest: unknown[]) => {
  executedSql.push(typeof text === 'string' ? text : String((text as { text?: string })?.text));
  return (originalQuery as (...args: unknown[]) => unknown)(text, ...rest);
};

async function post(index: string, body: unknown) {
  const res = await app.inject({
    method: 'POST',
    url: `/indexes/${index}/search`,
    payload: body as object,
  });
  return { status: res.statusCode, json: res.json() };
}

before(async () => {
  await runMigrations();
  await createIndex(INDEX, 'id');
  await createIndex(OTHER_INDEX, 'id');
  await addDocuments(INDEX, [
    { id: 1, title: 'Buffer solution for PCR', status: 'active', price: 10 },
    { id: 2, title: 'PCR tube rack', status: 'active', price: 30 },
    { id: 3, title: 'Glass beaker', status: 'archived', price: 20 },
  ]);
  await addDocuments(OTHER_INDEX, [
    { id: 1, title: 'Secret PCR document', status: 'secret', price: 99 },
  ]);

  app = Fastify();
  await app.register(searchRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  await deleteIndex(INDEX).catch(() => {});
  await deleteIndex(OTHER_INDEX).catch(() => {});
  await pool.query('DELETE FROM ms_tasks WHERE index_uid = ANY($1)', [[INDEX, OTHER_INDEX]]);
  await closePool();
});

// ─── 하이라이트 태그 인젝션 ─────────────────────────────────

test('highlightPreTag 인젝션 페이로드는 SQL이 아니라 단순 텍스트로 취급된다', async () => {
  executedSql.length = 0;
  const { status, json } = await post(INDEX, {
    q: 'pcr',
    attributesToHighlight: ['title'],
    highlightPreTag: INJECTION,
    highlightPostTag: '</x>',
  });

  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.hits.length, 2);
  for (const hit of json.hits) {
    assert.match(hit._formatted.title, /x'\|\|\(select 1\/0\)::text\|\|'PCR<\/x>/i);
  }
  assert.ok(executedSql.length > 0);
  for (const sql of executedSql) {
    assert.ok(!sql.includes('select 1/0'), `payload leaked into SQL text: ${sql}`);
  }
});

test('highlightPostTag 인젝션 페이로드도 SQL에 들어가지 않는다', async () => {
  executedSql.length = 0;
  const payload = "'||(select current_setting('server_version')::int)||'";
  const { status, json } = await post(INDEX, {
    q: 'pcr',
    attributesToHighlight: ['title'],
    highlightPostTag: payload,
  });

  assert.equal(status, 200, JSON.stringify(json));
  assert.ok(json.hits[0]._formatted.title.includes(payload));
  for (const sql of executedSql) {
    assert.ok(!sql.includes('current_setting'), `payload leaked into SQL text: ${sql}`);
  }
});

test('ts_headline 옵션은 바인드 파라미터로 전달된다', async () => {
  executedSql.length = 0;
  await post(INDEX, { q: 'pcr', attributesToHighlight: ['title'] });
  const headlineSql = executedSql.find(sql => sql.includes('ts_headline'));
  assert.ok(headlineSql, 'ts_headline query not found');
  assert.match(headlineSql, /ts_headline\('simple', search_text, to_tsquery\('simple', \$2\), \$\d+\)/);
  assert.ok(!headlineSql.includes('StartSel'));
});

test('기본 <em> 하이라이트가 그대로 동작한다', async () => {
  const { status, json } = await post(INDEX, { q: 'pcr', attributesToHighlight: ['title'] });
  assert.equal(status, 200);
  const titles = json.hits.map((h: any) => h._formatted.title).sort();
  assert.deepEqual(titles, ['<em>PCR</em> tube rack', 'Buffer solution for <em>PCR</em>']);
  // 원본 필드는 건드리지 않는다
  assert.ok(json.hits.every((h: any) => !h.title.includes('<em>')));
});

test('<mark> 같은 커스텀 태그가 동작한다', async () => {
  const { status, json } = await post(INDEX, {
    q: 'beaker',
    attributesToHighlight: ['title'],
    highlightPreTag: '<mark>',
    highlightPostTag: '</mark>',
  });
  assert.equal(status, 200);
  assert.equal(json.hits[0]._formatted.title, 'Glass <mark>beaker</mark>');
});

test('속성이 있는 태그(따옴표, =, 쉼표 포함)도 동작한다', async () => {
  const { status, json } = await post(INDEX, {
    q: 'beaker',
    attributesToHighlight: ['title'],
    highlightPreTag: '<span class="hl" data-x=\'a,b\'>',
    highlightPostTag: '</span>',
  });
  assert.equal(status, 200);
  assert.equal(
    json.hits[0]._formatted.title,
    'Glass <span class="hl" data-x=\'a,b\'>beaker</span>'
  );
});

test('태그 안의 $1, $& 는 치환 패턴이 아니라 글자로 취급된다', async () => {
  const { status, json } = await post(INDEX, {
    q: 'beaker',
    attributesToHighlight: ['title'],
    highlightPreTag: '[$1$&$`]',
    highlightPostTag: "[$']",
  });
  assert.equal(status, 200);
  assert.equal(json.hits[0]._formatted.title, "Glass [$1$&$`]beaker[$']");
});

test('잘못된 하이라이트 태그는 400', async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ highlightPreTag: 'a'.repeat(65) }, 'invalid_search_highlight_pre_tag'],
    [{ highlightPostTag: 'a'.repeat(65) }, 'invalid_search_highlight_post_tag'],
    [{ highlightPreTag: 123 }, 'invalid_search_highlight_pre_tag'],
    [{ highlightPreTag: { a: 1 } }, 'invalid_search_highlight_pre_tag'],
    [{ highlightPostTag: ['</em>'] }, 'invalid_search_highlight_post_tag'],
    [{ highlightPreTag: '<em>\u0000' }, 'invalid_search_highlight_pre_tag'],
    [{ highlightPostTag: '</em>\n' }, 'invalid_search_highlight_post_tag'],
  ];
  for (const [extra, code] of cases) {
    const { status, json } = await post(INDEX, { q: 'pcr', ...extra });
    assert.equal(status, 400, JSON.stringify(extra));
    assert.equal(json.code, code);
    assert.equal(json.type, 'invalid_request');
  }
  // 경계값: 정확히 64자는 허용
  const ok = await post(INDEX, { q: 'pcr', highlightPreTag: 'a'.repeat(64) });
  assert.equal(ok.status, 200);
});

// ─── limit / offset 검증 ────────────────────────────────────

test('limit이 상한을 넘으면 상한으로 잘린다', async () => {
  const big = await post(INDEX, { q: '', limit: 1_000_000 });
  assert.equal(big.status, 200);
  assert.equal(big.json.limit, config.search.maxLimit);

  // 상한을 낮춰 실제 반환 건수도 잘리는지 확인
  const original = config.search.maxLimit;
  config.search.maxLimit = 2;
  try {
    const { status, json } = await post(INDEX, { q: '', limit: 50 });
    assert.equal(status, 200);
    assert.equal(json.limit, 2);
    assert.equal(json.hits.length, 2);
    assert.equal(json.estimatedTotalHits, 3);
  } finally {
    config.search.maxLimit = original;
  }
});

test('유효한 limit/offset은 그대로 동작한다', async () => {
  const all = await post(INDEX, {});
  assert.equal(all.status, 200);
  assert.equal(all.json.limit, config.search.defaultLimit);
  assert.equal(all.json.offset, 0);
  assert.equal(all.json.hits.length, 3);

  const one = await post(INDEX, { q: '', limit: 1, offset: 1, sort: ['price:asc'] });
  assert.equal(one.status, 200);
  assert.equal(one.json.hits.length, 1);
  assert.equal(one.json.hits[0].id, 3);

  const zero = await post(INDEX, { limit: 0 });
  assert.equal(zero.status, 200);
  assert.equal(zero.json.hits.length, 0);

  // null은 "지정 안 함" — LIMIT NULL(무제한)로 흘러가면 안 된다
  const nul = await post(INDEX, { limit: null, offset: null });
  assert.equal(nul.status, 200);
  assert.equal(nul.json.limit, config.search.defaultLimit);
});

test('숫자 파라미터가 음이 아닌 정수가 아니면 400', async () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ limit: -1 }, 'invalid_search_limit'],
    [{ limit: 1.5 }, 'invalid_search_limit'],
    [{ limit: '10' }, 'invalid_search_limit'],
    [{ limit: '1; DROP TABLE ms_documents' }, 'invalid_search_limit'],
    [{ offset: -5 }, 'invalid_search_offset'],
    [{ offset: 'abc' }, 'invalid_search_offset'],
    [{ page: -1 }, 'invalid_search_page'],
    [{ page: 'x' }, 'invalid_search_page'],
    [{ hitsPerPage: 2.2 }, 'invalid_search_hits_per_page'],
    [{ hitsPerPage: -3 }, 'invalid_search_hits_per_page'],
  ];
  for (const [extra, code] of cases) {
    const { status, json } = await post(INDEX, { q: '', ...extra });
    assert.equal(status, 400, JSON.stringify(extra));
    assert.equal(json.code, code);
  }
});

test('GET 검색도 같은 검증을 탄다', async () => {
  const bad = await app.inject({ method: 'GET', url: `/indexes/${INDEX}/search?limit=10abc` });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, 'invalid_search_limit');

  const neg = await app.inject({ method: 'GET', url: `/indexes/${INDEX}/search?offset=-1` });
  assert.equal(neg.statusCode, 400);

  const ok = await app.inject({ method: 'GET', url: `/indexes/${INDEX}/search?q=pcr&limit=1` });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().hits.length, 1);

  const capped = await app.inject({ method: 'GET', url: `/indexes/${INDEX}/search?limit=999999` });
  assert.equal(capped.statusCode, 200);
  assert.equal(capped.json().limit, config.search.maxLimit);
});

test('타입이 틀린 본문 값은 500이 아니라 400', async () => {
  const cases: Array<[unknown, string]> = [
    [{ q: 123 }, 'invalid_search_q'],
    [{ sort: 'price:asc' }, 'invalid_search_sort'],
    [{ sort: [1] }, 'invalid_search_sort'],
    [{ facets: 'status' }, 'invalid_search_facets'],
    [{ filter: 5 }, 'invalid_search_filter'],
    [{ filter: [[1]] }, 'invalid_search_filter'],
    [{ attributesToHighlight: 'title' }, 'invalid_search_attributes_to_highlight'],
    [[1, 2], 'bad_request'],
  ];
  for (const [body, code] of cases) {
    const { status, json } = await post(INDEX, body);
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(json.code, code);
  }
});

// ─── 필터 / 정렬 / 패싯 ─────────────────────────────────────

test('검색어 + 필터 + 정렬 + 패싯 조합이 정상 동작한다 (파라미터 번호 확인)', async () => {
  const { status, json } = await post(INDEX, {
    q: 'pcr',
    filter: "(status = 'active' AND price > 5) OR status = 'nope'",
    sort: ['price:desc'],
    facets: ['status'],
    attributesToHighlight: ['title'],
    showRankingScore: true,
  });
  assert.equal(status, 200, JSON.stringify(json));
  assert.deepEqual(json.hits.map((h: any) => h.id), [2, 1]);
  assert.deepEqual(json.facetDistribution, { status: { active: 2 } });
  assert.equal(typeof json.hits[0]._rankingScore, 'number');
  assert.equal(json.hits[0]._formatted.title, '<em>PCR</em> tube rack');
});

test('배열 필터가 동작한다', async () => {
  const { status, json } = await post(INDEX, {
    filter: [['status = archived', 'price = 30'], 'price > 15'],
    sort: ['price:asc'],
  });
  assert.equal(status, 200, JSON.stringify(json));
  assert.deepEqual(json.hits.map((h: any) => h.id), [3, 2]);
});

test('괄호로 index_uid 범위를 벗어나는 필터는 400이고 다른 인덱스 문서를 노출하지 않는다', async () => {
  const escapes = [
    "status = 'nope') OR (status = 'secret'",
    "status = 'nope') OR (price > 0",
    "status = 'active' OR",
    "status = 'active' AND AND price > 0",
    "(status = 'active'",
    "status = 'active')",
    '()',
  ];
  for (const filter of escapes) {
    const { status, json } = await post(INDEX, { filter });
    assert.equal(status, 400, filter);
    assert.equal(json.code, 'invalid_search_filter');
    assert.equal(json.hits, undefined);
  }
});

test('필터 필드명/값, 정렬 필드, 패싯 이름의 SQL 페이로드는 무해하다', async () => {
  const evil = "x'; DROP TABLE ms_documents; --";
  const { status, json } = await post(INDEX, {
    q: 'pcr',
    filter: [`${evil} = ${evil}`],
    sort: [`${evil}:desc`, 'price) DESC, (select 1/0'],
    facets: [evil, 'status'],
  });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.hits.length, 0);

  const still = await pool.query('SELECT COUNT(*)::int AS n FROM ms_documents WHERE index_uid = $1', [INDEX]);
  assert.equal(still.rows[0].n, 3);
});

test('없는 인덱스는 404', async () => {
  const { status, json } = await post(`missing_${suffix}`, { q: 'x' });
  assert.equal(status, 404);
  assert.equal(json.code, 'index_not_found');
});

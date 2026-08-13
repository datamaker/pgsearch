import { query } from '../db/connection.js';
import { getIndex, createError } from './indexService.js';
import { parseFilter } from './filterParser.js';
import { config } from '../config.js';
import type { MsSearchRequest, MsSearchResponse, MsSearchHit } from '../types/meilisearch.js';

interface SearchRow {
  data: Record<string, unknown>;
  rank: number;
  similarity: number;
  highlight: string;
}

interface FacetRow {
  facet_value: string;
  count: string;
}

// tsquery용 검색어 변환
function toTsQuery(q: string): string {
  if (!q || q.trim() === '') return '';

  // 단어들을 추출하고 prefix 매칭을 위해 :* 추가
  const words = q.trim().split(/\s+/).filter(w => w.length > 0);
  return words.map(w => `${w}:*`).join(' & ');
}

// 검색어 정규화 (pg_trgm용)
function normalizeQuery(q: string): string {
  return q.trim().toLowerCase();
}

export async function search(
  indexUid: string,
  request: MsSearchRequest
): Promise<MsSearchResponse> {
  const startTime = Date.now();

  const index = await getIndex(indexUid);
  if (!index) {
    throw createError(`Index \`${indexUid}\` not found.`, 'index_not_found');
  }

  const {
    q = '',
    offset = 0,
    limit = config.search.defaultLimit,
    filter,
    facets,
    attributesToRetrieve,
    attributesToHighlight,
    highlightPreTag = '<em>',
    highlightPostTag = '</em>',
    sort,
    matchingStrategy = 'last',
    showRankingScore = false,
  } = request;

  const params: unknown[] = [indexUid];
  let paramIndex = 2;

  // 기본 쿼리 구성
  let whereClause = 'index_uid = $1';
  let orderClause = '';

  const tsQuery = toTsQuery(q);
  const normalizedQ = normalizeQuery(q);

  // 검색어가 있으면 FTS + pg_trgm 조건 추가
  if (q.trim()) {
    params.push(tsQuery);
    params.push(normalizedQ);

    whereClause += ` AND (
      search_vector @@ to_tsquery('simple', $${paramIndex})
      OR similarity(search_text, $${paramIndex + 1}) > ${config.search.similarityThreshold}
    )`;
    paramIndex += 2;

    orderClause = `ts_rank(search_vector, to_tsquery('simple', $2)) DESC,
                   similarity(search_text, $3) DESC`;
  }

  // 필터 적용 — parseFilter가 paramIndex부터 직접 올바른 플레이스홀더를 emit하므로
  // (이전의 $1→$10 오매칭이 있던) 문자열 replace 재인덱싱이 필요 없다.
  const filterResult = parseFilter(filter, paramIndex);
  if (filterResult && filterResult.sql) {
    whereClause += ` AND (${filterResult.sql})`;
    params.push(...filterResult.params);
    paramIndex += filterResult.params.length;
  }

  // 여기까지가 WHERE 절이 참조하는 파라미터 전부. count 쿼리는 이것만 쓴다.
  const whereParams = [...params];

  // 정렬 적용 — 필드명은 사용자 입력이므로 파라미터로, 방향은 화이트리스트로만.
  const orderParams: unknown[] = [];
  if (sort && sort.length > 0) {
    const sortClauses: string[] = [];
    for (const s of sort) {
      const [field, direction] = s.split(':');
      if (!field) continue;
      const dir = direction?.toLowerCase() === 'desc' ? 'DESC' : 'ASC';
      sortClauses.push(`data->>$${paramIndex + orderParams.length} ${dir}`);
      orderParams.push(field);
    }
    if (sortClauses.length > 0) {
      orderClause = sortClauses.join(', ');
    }
  }
  if (!orderClause) {
    orderClause = 'created_at DESC';
  }

  // 전체 개수 조회 (정렬은 개수에 영향 없음 → whereParams만)
  const countSql = `SELECT COUNT(*) FROM ms_documents WHERE ${whereClause}`;
  const countResult = await query<{ count: string }>(countSql, whereParams);
  const estimatedTotalHits = parseInt(countResult.rows[0].count, 10);

  // 검색 결과 조회 — where 파라미터 + 정렬 파라미터 + limit/offset
  const searchParams = [...whereParams, ...orderParams];
  const limitIndex = paramIndex + orderParams.length;
  searchParams.push(limit, offset);

  const headlineOptions = `StartSel=${highlightPreTag}, StopSel=${highlightPostTag}, MaxWords=35, MinWords=15`;

  let selectClause = 'data';
  if (q.trim()) {
    selectClause = `data,
      ts_rank(search_vector, to_tsquery('simple', $2)) as rank,
      similarity(search_text, $3) as similarity,
      ts_headline('simple', search_text, to_tsquery('simple', $2), '${headlineOptions}') as highlight`;
  }

  const searchSql = `
    SELECT ${selectClause}
    FROM ms_documents
    WHERE ${whereClause}
    ORDER BY ${orderClause}
    LIMIT $${limitIndex} OFFSET $${limitIndex + 1}
  `;

  const searchResult = await query<SearchRow>(searchSql, searchParams);

  // 결과 포맷팅
  const hits: MsSearchHit[] = searchResult.rows.map(row => {
    let doc = row.data;

    // attributesToRetrieve 적용
    if (attributesToRetrieve && attributesToRetrieve.length > 0 && !attributesToRetrieve.includes('*')) {
      const filtered: Record<string, unknown> = {};
      for (const attr of attributesToRetrieve) {
        if (attr in doc) {
          filtered[attr] = doc[attr];
        }
      }
      doc = filtered;
    }

    const hit: MsSearchHit = { ...doc };

    // 하이라이트 적용
    if (attributesToHighlight && attributesToHighlight.length > 0 && row.highlight) {
      hit._formatted = { ...doc };
      // 간단한 하이라이트 적용 (실제로는 각 필드별로 적용해야 함)
      for (const attr of attributesToHighlight) {
        if (attr in doc && typeof doc[attr] === 'string') {
          // 검색어가 포함된 부분을 하이라이트
          const value = doc[attr] as string;
          // 검색어를 정규식 리터럴로 이스케이프 — 이스케이프하지 않으면 사용자가 넣은
          // 메타문자가 예외나 ReDoS(정규식 기반 DoS)를 유발할 수 있다.
          const terms = q
            .split(/\s+/)
            .filter(Boolean)
            .map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
          const regex = terms.length > 0 ? new RegExp(`(${terms.join('|')})`, 'gi') : null;
          if (!regex) continue;
          (hit._formatted as Record<string, unknown>)[attr] = value.replace(
            regex,
            `${highlightPreTag}$1${highlightPostTag}`
          );
        }
      }
    }

    // 랭킹 스코어 추가
    if (showRankingScore && row.rank !== undefined) {
      hit._rankingScore = Math.max(row.rank, row.similarity || 0);
    }

    return hit;
  });

  // 패싯 계산
  let facetDistribution: Record<string, Record<string, number>> | undefined;

  if (facets && facets.length > 0) {
    facetDistribution = {};

    for (const facet of facets) {
      // 패싯 이름도 사용자 입력 → whereParams 다음 인덱스에 파라미터로 바인딩.
      const facetParamIndex = whereParams.length + 1;
      const facetSql = `
        SELECT data->>$${facetParamIndex} as facet_value, COUNT(*) as count
        FROM ms_documents
        WHERE ${whereClause} AND data ? $${facetParamIndex}
        GROUP BY data->>$${facetParamIndex}
        ORDER BY count DESC
        LIMIT 100
      `;

      const facetResult = await query<FacetRow>(facetSql, [...whereParams, facet]);
      facetDistribution[facet] = {};

      for (const row of facetResult.rows) {
        if (row.facet_value) {
          facetDistribution[facet][row.facet_value] = parseInt(row.count, 10);
        }
      }
    }
  }

  const processingTimeMs = Date.now() - startTime;

  return {
    hits,
    offset,
    limit,
    estimatedTotalHits,
    processingTimeMs,
    query: q,
    facetDistribution,
  };
}

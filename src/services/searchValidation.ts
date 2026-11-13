// 검색 요청 본문 검증/정규화
//
// 라우트에 스키마 검증이 없어서 요청 본문 값이 타입 확인 없이 그대로 서비스까지
// 내려갔다. 여기서 한 번 걸러서, 서비스 계층은 "타입이 맞고 범위 안에 있는 값"만
// 받도록 한다. 잘못된 값은 Meilisearch 형식의 에러(MsError)로 던지고 라우트가
// 400으로 응답한다.

import { config } from '../config.js';
import { createError } from './indexService.js';
import type { MsSearchRequest } from '../types/meilisearch.js';

// 하이라이트 태그 최대 길이. `<span class="search-highlight">` 정도는 넉넉히 들어간다.
export const MAX_HIGHLIGHT_TAG_LENGTH = 64;

// 제어 문자 (NUL 포함). 태그에 들어갈 이유가 없고, 로그/응답을 오염시킬 수 있다.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

// 검증 에러 코드 판별 — 라우트에서 400으로 매핑할 때 쓴다.
export function isSearchValidationError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof Error) return false;
  return typeof code === 'string' && (code.startsWith('invalid_search_') || code === 'bad_request');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 음이 아닌 정수만 허용. null/undefined는 "지정 안 함"으로 취급한다(Meilisearch와 동일).
// 숫자 타입만 받는다 — "10" 같은 문자열은 Meilisearch도 거부한다.
function nonNegativeInt(value: unknown, field: string, code: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw createError(
      `Invalid value at \`.${field}\`: expected a non-negative integer.`,
      code
    );
  }
  return value;
}

function highlightTag(value: unknown, field: string, code: string, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') {
    throw createError(`Invalid value type at \`.${field}\`: expected a string.`, code);
  }
  if (value.length > MAX_HIGHLIGHT_TAG_LENGTH) {
    throw createError(
      `Invalid value at \`.${field}\`: must be at most ${MAX_HIGHLIGHT_TAG_LENGTH} characters.`,
      code
    );
  }
  if (CONTROL_CHARS.test(value)) {
    throw createError(
      `Invalid value at \`.${field}\`: control characters are not allowed.`,
      code
    );
  }
  return value;
}

function stringArray(value: unknown, field: string, code: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
    throw createError(
      `Invalid value type at \`.${field}\`: expected an array of strings.`,
      code
    );
  }
  return value as string[];
}

function filterValue(value: unknown): MsSearchRequest['filter'] {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  const ok =
    Array.isArray(value) &&
    value.every(
      item =>
        typeof item === 'string' ||
        (Array.isArray(item) && item.every(sub => typeof sub === 'string'))
    );
  if (!ok) {
    throw createError(
      'Invalid value type at `.filter`: expected a string or an array of strings / string arrays.',
      'invalid_search_filter'
    );
  }
  return value as string[] | string[][];
}

// 검증을 통과한 검색 요청. 서비스가 쓰는 필드는 전부 기본값이 채워져 있다.
export interface NormalizedSearchRequest {
  q: string;
  offset: number;
  limit: number;
  filter: MsSearchRequest['filter'];
  facets?: string[];
  attributesToRetrieve?: string[];
  attributesToHighlight?: string[];
  highlightPreTag: string;
  highlightPostTag: string;
  sort?: string[];
  showRankingScore: boolean;
}

export function normalizeSearchRequest(body: unknown): NormalizedSearchRequest {
  // 본문 없는 POST는 빈 검색으로 취급한다 (Meilisearch와 동일).
  if (body === undefined || body === null) body = {};
  if (!isPlainObject(body)) {
    throw createError('Invalid request body: expected a JSON object.', 'bad_request');
  }

  if (body.q !== undefined && body.q !== null && typeof body.q !== 'string') {
    throw createError('Invalid value type at `.q`: expected a string.', 'invalid_search_q');
  }

  const offset = nonNegativeInt(body.offset, 'offset', 'invalid_search_offset') ?? 0;
  const requestedLimit =
    nonNegativeInt(body.limit, 'limit', 'invalid_search_limit') ?? config.search.defaultLimit;
  // page/hitsPerPage 페이지네이션은 아직 구현돼 있지 않아 값 자체는 쓰지 않지만,
  // 잘못된 값은 조용히 무시하지 않고 거부한다.
  nonNegativeInt(body.page, 'page', 'invalid_search_page');
  nonNegativeInt(body.hitsPerPage, 'hitsPerPage', 'invalid_search_hits_per_page');

  if (
    body.showRankingScore !== undefined &&
    body.showRankingScore !== null &&
    typeof body.showRankingScore !== 'boolean'
  ) {
    throw createError(
      'Invalid value type at `.showRankingScore`: expected a boolean.',
      'invalid_search_show_ranking_score'
    );
  }

  return {
    q: (body.q as string | null | undefined) ?? '',
    offset,
    // 상한 초과는 에러가 아니라 상한으로 잘라낸다 — 한 번의 요청으로 인덱스 전체를
    // 긁어 가거나 DB에 과도한 부하를 주는 것을 막는다.
    limit: Math.min(requestedLimit, config.search.maxLimit),
    filter: filterValue(body.filter),
    facets: stringArray(body.facets, 'facets', 'invalid_search_facets'),
    attributesToRetrieve: stringArray(
      body.attributesToRetrieve,
      'attributesToRetrieve',
      'invalid_search_attributes_to_retrieve'
    ),
    attributesToHighlight: stringArray(
      body.attributesToHighlight,
      'attributesToHighlight',
      'invalid_search_attributes_to_highlight'
    ),
    highlightPreTag: highlightTag(
      body.highlightPreTag,
      'highlightPreTag',
      'invalid_search_highlight_pre_tag',
      '<em>'
    ),
    highlightPostTag: highlightTag(
      body.highlightPostTag,
      'highlightPostTag',
      'invalid_search_highlight_post_tag',
      '</em>'
    ),
    sort: stringArray(body.sort, 'sort', 'invalid_search_sort'),
    showRankingScore: body.showRankingScore === true,
  };
}

// ─── 목록 엔드포인트(문서/인덱스) 페이지네이션 ─────────────────

// 목록 조회의 기본 limit (Meilisearch 와 동일).
export const DEFAULT_LIST_LIMIT = 20;

function listInt(raw: unknown, field: string, code: string): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  // 쿼리스트링은 문자열로 온다. parseInt 는 "10abc" 를 10 으로, "-5" 를 -5 로 읽어
  // 그대로 SQL 의 OFFSET/LIMIT 에 들어갔다(음수면 500). 숫자만으로 된 값만 받는다.
  const value =
    typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return nonNegativeInt(value, field, code);
}

/**
 * 문서/인덱스 목록의 offset·limit 검증. 검색과 같은 규칙을 쓴다:
 * 음이 아닌 정수만 허용(아니면 400), limit 은 config.search.maxLimit 으로 잘라낸다.
 */
export function parseListPagination(
  queryString: { offset?: unknown; limit?: unknown } | undefined,
  kind: 'document' | 'index'
): { offset: number; limit: number } {
  const q = queryString ?? {};
  const offset = listInt(q.offset, 'offset', `invalid_${kind}_offset`) ?? 0;
  const limit = listInt(q.limit, 'limit', `invalid_${kind}_limit`) ?? DEFAULT_LIST_LIMIT;
  return { offset, limit: Math.min(limit, config.search.maxLimit) };
}

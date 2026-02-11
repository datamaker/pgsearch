// Meilisearch 호환 타입 정의

export interface MsIndex {
  uid: string;
  primaryKey: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MsIndexListResponse {
  results: MsIndex[];
  offset: number;
  limit: number;
  total: number;
}

export interface MsTask {
  taskUid: number;
  indexUid: string;
  status: 'enqueued' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  type: string;
  enqueuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  details?: Record<string, unknown>;
  error?: MsError;
}

export interface MsError {
  message: string;
  code: string;
  type: string;
  link: string;
}

export interface MsDocumentListResponse<T = Record<string, unknown>> {
  results: T[];
  offset: number;
  limit: number;
  total: number;
}

export interface MsSearchRequest {
  q?: string;
  offset?: number;
  limit?: number;
  filter?: string | string[] | string[][];
  facets?: string[];
  attributesToRetrieve?: string[];
  attributesToHighlight?: string[];
  highlightPreTag?: string;
  highlightPostTag?: string;
  attributesToCrop?: string[];
  cropLength?: number;
  cropMarker?: string;
  sort?: string[];
  matchingStrategy?: 'last' | 'all' | 'frequency';
  showMatchesPosition?: boolean;
  showRankingScore?: boolean;
}

export interface MsSearchHit<T = Record<string, unknown>> {
  [key: string]: unknown;
  _formatted?: T;
  _matchesPosition?: Record<string, Array<{ start: number; length: number }>>;
  _rankingScore?: number;
}

export interface MsSearchResponse<T = Record<string, unknown>> {
  hits: MsSearchHit<T>[];
  offset: number;
  limit: number;
  estimatedTotalHits: number;
  processingTimeMs: number;
  query: string;
  facetDistribution?: Record<string, Record<string, number>>;
  facetStats?: Record<string, { min: number; max: number }>;
}

export interface CreateIndexRequest {
  uid: string;
  primaryKey?: string;
}

export interface UpdateIndexRequest {
  primaryKey: string;
}

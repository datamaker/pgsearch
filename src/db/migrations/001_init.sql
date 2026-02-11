-- PgSearch 초기 스키마
-- pg_trgm 확장 활성화 (오타 허용 검색)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 인덱스 메타데이터 테이블
CREATE TABLE IF NOT EXISTS ms_indexes (
    uid VARCHAR(255) PRIMARY KEY,
    primary_key VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 문서 저장 테이블 (JSONB 사용)
CREATE TABLE IF NOT EXISTS ms_documents (
    id SERIAL PRIMARY KEY,
    index_uid VARCHAR(255) REFERENCES ms_indexes(uid) ON DELETE CASCADE,
    doc_id TEXT NOT NULL,
    data JSONB NOT NULL,
    search_vector TSVECTOR,
    search_text TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(index_uid, doc_id)
);

-- 검색 성능을 위한 인덱스
CREATE INDEX IF NOT EXISTS idx_documents_index_uid ON ms_documents(index_uid);
CREATE INDEX IF NOT EXISTS idx_documents_search_vector ON ms_documents USING GIN(search_vector);
CREATE INDEX IF NOT EXISTS idx_documents_search_text_trgm ON ms_documents USING GIN(search_text gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_documents_data ON ms_documents USING GIN(data);

-- 비동기 작업 큐 테이블
CREATE TABLE IF NOT EXISTS ms_tasks (
    uid SERIAL PRIMARY KEY,
    index_uid VARCHAR(255),
    status VARCHAR(20) DEFAULT 'enqueued',
    type VARCHAR(50) NOT NULL,
    details JSONB,
    error JSONB,
    enqueued_at TIMESTAMPTZ DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ
);

-- pg_trgm 유사도 임계값 설정
SELECT set_limit(0.3);

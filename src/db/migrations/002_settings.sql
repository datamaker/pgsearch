-- 인덱스 설정 테이블
CREATE TABLE IF NOT EXISTS ms_settings (
    index_uid VARCHAR(255) PRIMARY KEY REFERENCES ms_indexes(uid) ON DELETE CASCADE,
    searchable_attributes JSONB DEFAULT '["*"]',
    displayed_attributes JSONB DEFAULT '["*"]',
    filterable_attributes JSONB DEFAULT '[]',
    sortable_attributes JSONB DEFAULT '[]',
    ranking_rules JSONB DEFAULT '["words", "typo", "proximity", "attribute", "sort", "exactness"]',
    stop_words JSONB DEFAULT '[]',
    synonyms JSONB DEFAULT '{}',
    distinct_attribute VARCHAR(255) DEFAULT NULL,
    typo_tolerance JSONB DEFAULT '{"enabled": true, "minWordSizeForTypos": {"oneTypo": 5, "twoTypos": 9}}',
    pagination JSONB DEFAULT '{"maxTotalHits": 1000}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 기존 인덱스에 기본 설정 추가
INSERT INTO ms_settings (index_uid)
SELECT uid FROM ms_indexes
WHERE uid NOT IN (SELECT index_uid FROM ms_settings)
ON CONFLICT DO NOTHING;

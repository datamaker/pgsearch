-- API 키: 만료 시각과 읽기 전용 플래그 (둘 다 선택)
-- 기존 키는 그대로 전체 권한·무기한이다 (expires_at NULL, read_only false).
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS read_only BOOLEAN NOT NULL DEFAULT false;

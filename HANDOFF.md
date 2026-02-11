# PgSearch Handoff Document

PostgreSQL 기반 Meilisearch 호환 검색 엔진

---

## 프로젝트 개요

PgSearch는 Meilisearch의 REST API와 호환되면서 PostgreSQL을 백엔드로 사용하는 검색 엔진입니다.

### 주요 특징
- **Meilisearch API 호환**: 기존 Meilisearch 클라이언트 사용 가능
- **PostgreSQL Full-Text Search**: `tsvector`, `tsquery` 활용
- **오타 허용 검색**: `pg_trgm` 확장 사용
- **관리 대시보드**: 내장 웹 UI 제공

---

## 기술 스택

| 구분 | 기술 |
|-----|------|
| Runtime | Node.js 20+ |
| Language | TypeScript |
| Framework | Fastify 4.x |
| Database | PostgreSQL 16 |
| Extensions | pg_trgm |

---

## 프로젝트 구조

```
pgsearch/
├── src/
│   ├── index.ts                 # 서버 진입점
│   ├── config.ts                # 환경 설정
│   ├── db/
│   │   ├── connection.ts        # DB 연결 풀
│   │   ├── migrate.ts           # 마이그레이션 실행기
│   │   └── migrations/
│   │       ├── 001_init.sql     # 초기 스키마
│   │       └── 002_settings.sql # 설정 테이블
│   ├── routes/
│   │   ├── indexes.ts           # /indexes API
│   │   ├── documents.ts         # /documents API
│   │   ├── search.ts            # /search API
│   │   └── settings.ts          # /settings API
│   ├── services/
│   │   ├── indexService.ts      # 인덱스 비즈니스 로직
│   │   ├── documentService.ts   # 문서 CRUD + tsvector 생성
│   │   ├── searchService.ts     # FTS + pg_trgm 검색
│   │   ├── settingsService.ts   # 인덱스 설정 관리
│   │   ├── filterParser.ts      # 필터 문법 파싱
│   │   └── taskQueue.ts         # 비동기 작업 관리
│   ├── types/
│   │   └── meilisearch.ts       # 타입 정의
│   └── public/
│       └── index.html           # 대시보드 UI
├── package.json
├── tsconfig.json
└── docker-compose.yml           # PostgreSQL 컨테이너
```

---

## 설치 및 실행

### 1. 의존성 설치
```bash
cd pgsearch
npm install
```

### 2. PostgreSQL 설정

**옵션 A: Docker 사용**
```bash
docker-compose up -d
```

**옵션 B: 로컬 PostgreSQL**
```bash
createdb pgsearch
```

환경변수로 연결 정보 설정 (선택):
```bash
export DB_HOST=localhost
export DB_PORT=5432
export DB_USER=postgres
export DB_PASSWORD=
export DB_NAME=pgsearch
```

### 3. 마이그레이션 실행
```bash
npm run migrate
```

### 4. 서버 실행
```bash
# 개발 모드 (hot reload)
npm run dev

# 프로덕션
npm run build
npm start
```

서버 URL: `http://localhost:7700`

---

## API 엔드포인트

### Indexes API

| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/indexes` | 인덱스 목록 |
| GET | `/indexes/:uid` | 인덱스 조회 |
| POST | `/indexes` | 인덱스 생성 |
| PATCH | `/indexes/:uid` | 인덱스 수정 |
| DELETE | `/indexes/:uid` | 인덱스 삭제 |

### Documents API

| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/indexes/:uid/documents` | 문서 목록 |
| GET | `/indexes/:uid/documents/:id` | 문서 조회 |
| POST | `/indexes/:uid/documents` | 문서 추가/수정 |
| DELETE | `/indexes/:uid/documents` | 모든 문서 삭제 |
| DELETE | `/indexes/:uid/documents/:id` | 문서 삭제 |

### Search API

| Method | Endpoint | 설명 |
|--------|----------|------|
| POST | `/indexes/:uid/search` | 검색 |
| GET | `/indexes/:uid/search?q=` | 검색 (GET) |

### Settings API

| Method | Endpoint | 설명 |
|--------|----------|------|
| GET | `/indexes/:uid/settings` | 설정 조회 |
| PATCH | `/indexes/:uid/settings` | 설정 수정 |
| DELETE | `/indexes/:uid/settings` | 설정 초기화 |

---

## 사용 예시

### 인덱스 생성
```bash
curl -X POST http://localhost:7700/indexes \
  -H 'Content-Type: application/json' \
  -d '{"uid": "movies", "primaryKey": "id"}'
```

### 문서 추가
```bash
curl -X POST http://localhost:7700/indexes/movies/documents \
  -H 'Content-Type: application/json' \
  -d '[
    {"id": 1, "title": "Inception", "genre": "Sci-Fi"},
    {"id": 2, "title": "Interstellar", "genre": "Sci-Fi"}
  ]'
```

### 검색
```bash
curl -X POST http://localhost:7700/indexes/movies/search \
  -H 'Content-Type: application/json' \
  -d '{
    "q": "incep",
    "attributesToHighlight": ["title"],
    "filter": "genre = '\''Sci-Fi'\''"
  }'
```

### 설정 변경
```bash
curl -X PATCH http://localhost:7700/indexes/movies/settings \
  -H 'Content-Type: application/json' \
  -d '{
    "filterableAttributes": ["genre", "year"],
    "sortableAttributes": ["id", "title"]
  }'
```

---

## 데이터베이스 스키마

### ms_indexes
인덱스 메타데이터
```sql
CREATE TABLE ms_indexes (
    uid VARCHAR(255) PRIMARY KEY,
    primary_key VARCHAR(255),
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ
);
```

### ms_documents
문서 저장 (JSONB)
```sql
CREATE TABLE ms_documents (
    id SERIAL PRIMARY KEY,
    index_uid VARCHAR(255) REFERENCES ms_indexes(uid),
    doc_id TEXT NOT NULL,
    data JSONB NOT NULL,
    search_vector TSVECTOR,    -- Full-text search
    search_text TEXT,          -- pg_trgm 용
    UNIQUE(index_uid, doc_id)
);
```

### ms_settings
인덱스 설정
```sql
CREATE TABLE ms_settings (
    index_uid VARCHAR(255) PRIMARY KEY,
    searchable_attributes JSONB,
    displayed_attributes JSONB,
    filterable_attributes JSONB,
    sortable_attributes JSONB,
    ranking_rules JSONB,
    stop_words JSONB,
    synonyms JSONB,
    distinct_attribute VARCHAR(255),
    ...
);
```

### ms_tasks
비동기 작업 로그
```sql
CREATE TABLE ms_tasks (
    uid SERIAL PRIMARY KEY,
    index_uid VARCHAR(255),
    status VARCHAR(20),
    type VARCHAR(50),
    details JSONB,
    enqueued_at TIMESTAMPTZ
);
```

---

## 핵심 로직

### 검색 쿼리 (searchService.ts)
```sql
SELECT data,
       ts_rank(search_vector, query) AS rank,
       similarity(search_text, $q) AS sim
FROM ms_documents,
     to_tsquery('simple', $tsquery) query
WHERE index_uid = $uid
  AND (search_vector @@ query OR similarity(search_text, $q) > 0.3)
ORDER BY rank DESC, sim DESC
LIMIT $limit OFFSET $offset;
```

### tsvector 생성 (documentService.ts)
문서 저장 시 모든 텍스트 필드를 추출하여 `search_vector`와 `search_text`에 저장

### 필터 파싱 (filterParser.ts)
Meilisearch 필터 문법을 SQL WHERE 절로 변환:
- `genre = 'Action'` → `data->>'genre' = 'Action'`
- `price > 100` → `(data->>'price')::numeric > 100`

---

## 환경 변수

| 변수 | 기본값 | 설명 |
|-----|--------|------|
| PORT | 7700 | 서버 포트 |
| HOST | 0.0.0.0 | 바인드 주소 |
| DB_HOST | localhost | PostgreSQL 호스트 |
| DB_PORT | 5432 | PostgreSQL 포트 |
| DB_USER | (시스템 사용자) | DB 사용자 |
| DB_PASSWORD | (없음) | DB 비밀번호 |
| DB_NAME | pgsearch | DB 이름 |

---

## 대시보드

브라우저에서 `http://localhost:7700` 접속

### 기능
- **Indexes**: 인덱스 목록 조회, 생성, 삭제
- **Documents**: 문서 조회, JSON으로 추가, 삭제
- **Settings**: 검색 설정 편집 (searchable, filterable 등)
- **Search**: 검색 테스트 (필터, 하이라이팅, 패싯)

---

## 제한 사항

| 항목 | 상태 | 비고 |
|-----|------|------|
| 동기식 처리 | O | Task는 즉시 완료됨 |
| Geo 검색 | X | PostGIS로 확장 가능 |
| 한국어 형태소 | X | mecab 연동 필요 |
| API Keys | X | 인증 미구현 |
| 멀티테넌시 | X | 단일 인스턴스 |

---

## 확장 가능성

1. **한국어 검색 개선**
   - mecab-ko + pg_mecab 연동
   - 또는 별도 한국어 토크나이저 구현

2. **Geo 검색**
   - PostGIS 확장 설치
   - `_geoRadius` 필터 구현

3. **인증/인가**
   - API Key 테이블 추가
   - Bearer token 검증 미들웨어

4. **비동기 처리**
   - Bull/BullMQ로 작업 큐 구현
   - 대용량 문서 배치 처리

---

## 문의

이 프로젝트에 대한 문의사항이 있으면 담당자에게 연락하세요.

# PgSearch

PostgreSQL-based search engine with Meilisearch-compatible API.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Docker](https://img.shields.io/docker/v/datamaker/pgsearch?label=docker)](https://hub.docker.com/r/datamaker/pgsearch)

## Features

- **Meilisearch API Compatible** - Drop-in replacement for Meilisearch
- **PostgreSQL Backend** - Use your existing PostgreSQL database
- **Full-Text Search** - Powered by PostgreSQL `tsvector` and `tsquery`
- **Typo Tolerance** - Fuzzy search using `pg_trgm` extension
- **Built-in Dashboard** - Web UI for managing indexes and testing search
- **Zero Config** - Works out of the box with sensible defaults

## Quick Start (Docker)

**One-line installation:**

```bash
curl -sSL https://raw.githubusercontent.com/datamaker/pgsearch/main/docker-compose.yml -o docker-compose.yml && docker compose up -d
```

Open http://localhost:7700 in your browser.

## Installation Options

### Option 1: Docker Compose (Recommended)

```bash
# Download and start
wget https://raw.githubusercontent.com/datamaker/pgsearch/main/docker-compose.yml
docker compose up -d
```

### Option 2: Docker (with external PostgreSQL)

```bash
docker run -d \
  --name pgsearch \
  -p 7700:7700 \
  -e DB_HOST=your-postgres-host \
  -e DB_USER=postgres \
  -e DB_PASSWORD=yourpassword \
  -e DB_NAME=pgsearch \
  datamaker/pgsearch:latest
```

### Option 3: From Source

```bash
git clone https://github.com/datamaker/pgsearch.git
cd pgsearch
npm install
npm run migrate
npm run dev
```

## API Usage

### Create an Index

```bash
curl -X POST http://localhost:7700/indexes \
  -H 'Content-Type: application/json' \
  -d '{"uid": "movies", "primaryKey": "id"}'
```

### Add Documents

```bash
curl -X POST http://localhost:7700/indexes/movies/documents \
  -H 'Content-Type: application/json' \
  -d '[
    {"id": 1, "title": "Inception", "genre": "Sci-Fi"},
    {"id": 2, "title": "Interstellar", "genre": "Sci-Fi"}
  ]'
```

### Search

```bash
curl -X POST http://localhost:7700/indexes/movies/search \
  -H 'Content-Type: application/json' \
  -d '{"q": "incep"}'
```

## Dashboard

Built-in web UI at http://localhost:7700

- **Indexes** - Create, view, delete indexes
- **Documents** - Add, view, delete documents
- **Settings** - Configure searchable/filterable attributes
- **Search** - Test search with filters and highlighting

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET/POST | `/indexes` | List/Create indexes |
| GET/PATCH/DELETE | `/indexes/:uid` | Get/Update/Delete index |
| GET/POST/DELETE | `/indexes/:uid/documents` | Manage documents |
| POST | `/indexes/:uid/search` | Search documents |
| GET/PATCH/DELETE | `/indexes/:uid/settings` | Manage settings |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 7700 | Server port |
| `DB_HOST` | localhost | PostgreSQL host |
| `DB_PORT` | 5432 | PostgreSQL port |
| `DB_USER` | postgres | Database user |
| `DB_PASSWORD` | - | Database password |
| `DB_NAME` | pgsearch | Database name |

## Authentication (optional)

Authentication is **fully off by default**. When the OIDC environment variables below are absent, PgSearch runs in open mode and every endpoint is accessible without credentials (backwards compatible).

To enable it, configure an OIDC identity provider:

| Variable | Default | Description |
|----------|---------|-------------|
| `OIDC_ISSUER` | - | OIDC issuer URL (discovery via `/.well-known/openid-configuration`) |
| `OIDC_CLIENT_ID` | `pgsearch` | OIDC client ID |
| `OIDC_CLIENT_SECRET` | - | OIDC client secret |
| `PGSEARCH_PUBLIC_URL` | - | Public base URL of this instance (used for the OIDC `redirect_uri`) |
| `PGSEARCH_ADMIN_EMAILS` | - | Comma-separated emails that get the `admin` role on login |
| `PGSEARCH_SESSION_SECRET` | random per boot | Secret for signing session cookies. Set it, or sessions reset on restart |

Auth is enabled when `OIDC_ISSUER`, `OIDC_CLIENT_SECRET`, and `PGSEARCH_PUBLIC_URL` are all set. Register `PGSEARCH_PUBLIC_URL + /auth/oidc/callback` as the redirect URI in your IdP.

### Roles

Users are provisioned automatically on first SSO login (JIT):

- **admin** — full read/write access, plus member and API key management in the dashboard. Assigned when the email is in `PGSEARCH_ADMIN_EMAILS`, or when it is the very first user.
- **member** — read/search-only via the dashboard and session cookie. Write requests return `403`.

Admins can promote/demote members and deactivate accounts in the dashboard's **Members** page (self-demotion/deactivation is blocked to prevent lockout).

### API Keys

For programmatic access (SDKs, servers), admins can create API keys in the dashboard's **API Keys** page. Keys are shown once at creation and only a SHA-256 hash is stored. Use them Meilisearch-style:

```bash
curl http://localhost:7700/indexes/movies/search \
  -H 'Authorization: Bearer <your-api-key>' \
  -H 'Content-Type: application/json' \
  -d '{"q": "wonder"}'
```

API keys have full read/write access.

## Meilisearch Compatibility

| Feature | Status |
|---------|--------|
| Indexes CRUD | ✅ |
| Documents CRUD | ✅ |
| Search | ✅ |
| Filters | ✅ |
| Facets | ✅ |
| Highlighting | ✅ |
| Settings | ✅ |
| Typo tolerance | ✅ |
| API Keys | ❌ |
| Geo search | ❌ |

## Tech Stack

- Node.js 20+ / TypeScript
- Fastify
- PostgreSQL 16+ with pg_trgm

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see [LICENSE](LICENSE) for details.

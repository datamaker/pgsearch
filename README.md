# PgSearch

PostgreSQL-based search engine with Meilisearch-compatible API.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Features

- **Meilisearch API Compatible** - Drop-in replacement for Meilisearch
- **PostgreSQL Backend** - Use your existing PostgreSQL database
- **Full-Text Search** - Powered by PostgreSQL `tsvector` and `tsquery`
- **Typo Tolerance** - Fuzzy search using `pg_trgm` extension
- **Built-in Dashboard** - Web UI for managing indexes and testing search
- **Zero Config** - Works out of the box with sensible defaults

## Quick Start

```bash
# Clone the repository
git clone https://github.com/YOUR_USERNAME/pgsearch.git
cd pgsearch

# Install dependencies
npm install

# Start PostgreSQL (Docker)
docker-compose up -d

# Run migrations
npm run migrate

# Start the server
npm run dev
```

Open http://localhost:7700 in your browser.

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

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET/POST | `/indexes` | List/Create indexes |
| GET/PATCH/DELETE | `/indexes/:uid` | Get/Update/Delete index |
| GET/POST/DELETE | `/indexes/:uid/documents` | Manage documents |
| POST | `/indexes/:uid/search` | Search documents |
| GET/PATCH/DELETE | `/indexes/:uid/settings` | Manage settings |

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 7700 | Server port |
| `DB_HOST` | localhost | PostgreSQL host |
| `DB_PORT` | 5432 | PostgreSQL port |
| `DB_USER` | postgres | Database user |
| `DB_PASSWORD` | - | Database password |
| `DB_NAME` | pgsearch | Database name |

## Tech Stack

- **Runtime**: Node.js
- **Language**: TypeScript
- **Framework**: Fastify
- **Database**: PostgreSQL
- **Extensions**: pg_trgm

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - see [LICENSE](LICENSE) for details.

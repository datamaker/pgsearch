import { config } from './config.js';
import { testConnection, closePool } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { checkAuthBootConfig } from './auth/oidc.js';
import { buildApp } from './app.js';

// 인증 설정 점검 — 운영에서 OIDC 설정이 빠졌는데 PGSEARCH_OPEN_MODE=1 도 아니면
// 띄우지 않는다 (조용히 전체 무인증으로 뜨는 것을 막는다).
const authCheck = checkAuthBootConfig();
if (!authCheck.ok) {
  console.error(authCheck.message);
  process.exit(1);
}
if (authCheck.level === 'warn') console.warn(authCheck.message);
else console.log(authCheck.message);

const fastify = await buildApp({ logger: true });

// 서버 시작
async function start(): Promise<void> {
  try {
    // DB 연결 테스트
    const dbConnected = await testConnection();
    if (!dbConnected) {
      console.error('Failed to connect to database. Please ensure PostgreSQL is running.');
      console.error('Run: docker-compose up -d');
      process.exit(1);
    }

    console.log('Database connected successfully');

    // Bring the schema up to date before serving. Idempotent, so it's safe on
    // every boot and makes `docker compose up` work against an empty database
    // (the container CMD is `node dist/index.js`, which otherwise never ran
    // migrations — every request then 500'd).
    await runMigrations();

    await fastify.listen({
      port: config.port,
      host: config.host,
    });

    console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   PgSearch is running!                                    ║
║                                                           ║
║   Dashboard:  http://localhost:${config.port}                       ║
║   API:        http://localhost:${config.port}/indexes               ║
║                                                           ║
║   Endpoints:                                              ║
║   - GET/POST /indexes                                     ║
║   - GET/PATCH/DELETE /indexes/:uid                        ║
║   - GET/POST/DELETE /indexes/:uid/documents               ║
║   - POST /indexes/:uid/search                             ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
    `);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

// Graceful shutdown
const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
signals.forEach(signal => {
  process.on(signal, async () => {
    console.log(`\nReceived ${signal}, shutting down gracefully...`);
    await fastify.close();
    await closePool();
    process.exit(0);
  });
});

start();

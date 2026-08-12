import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { testConnection, closePool } from './db/connection.js';
import { runMigrations } from './db/migrate.js';
import { indexRoutes } from './routes/indexes.js';
import { documentRoutes } from './routes/documents.js';
import { searchRoutes } from './routes/search.js';
import { settingsRoutes } from './routes/settings.js';
import { authRoutes } from './auth/routes.js';
import { authGuard } from './auth/middleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fastify = Fastify({
  logger: true,
});

// CORS 설정
await fastify.register(cors, {
  origin: true,
  credentials: true,
});

// 쿠키 파싱 (세션/OIDC state 쿠키)
await fastify.register(cookie);
fastify.decorateRequest('user', null);

// 정적 파일 서빙 (대시보드)
await fastify.register(fastifyStatic, {
  root: path.join(__dirname, 'public'),
  prefix: '/',
  decorateReply: false,
});

// 인증 라우트 (인증 가드 미적용)
await fastify.register(authRoutes);

// API 라우트 등록 (공통 인증 가드 적용 스코프)
await fastify.register(async (app) => {
  app.addHook('preHandler', authGuard);
  await app.register(indexRoutes);
  await app.register(documentRoutes);
  await app.register(searchRoutes);
  await app.register(settingsRoutes);
});

// Health check
fastify.get('/health', async () => {
  const dbConnected = await testConnection();
  return {
    status: dbConnected ? 'ok' : 'error',
    database: dbConnected ? 'connected' : 'disconnected',
  };
});

// API 정보 엔드포인트
fastify.get('/api/info', async () => {
  return {
    name: 'PgSearch',
    version: '1.0.0',
    description: 'PostgreSQL-based Meilisearch-compatible search engine',
  };
});

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

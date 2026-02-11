import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { testConnection, closePool } from './db/connection.js';
import { indexRoutes } from './routes/indexes.js';
import { documentRoutes } from './routes/documents.js';
import { searchRoutes } from './routes/search.js';
import { settingsRoutes } from './routes/settings.js';

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

// 정적 파일 서빙 (대시보드)
await fastify.register(fastifyStatic, {
  root: path.join(__dirname, 'public'),
  prefix: '/',
  decorateReply: false,
});

// 라우트 등록
await fastify.register(indexRoutes);
await fastify.register(documentRoutes);
await fastify.register(searchRoutes);
await fastify.register(settingsRoutes);

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

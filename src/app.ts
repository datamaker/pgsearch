import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { testConnection } from './db/connection.js';
import { indexRoutes } from './routes/indexes.js';
import { documentRoutes } from './routes/documents.js';
import { searchRoutes } from './routes/search.js';
import { settingsRoutes } from './routes/settings.js';
import { authRoutes } from './auth/routes.js';
import { authGuard } from './auth/middleware.js';
import { registerErrorHandler } from './errorHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface BuildAppOptions {
  logger?: FastifyServerOptions['logger'];
}

/**
 * Fastify 앱을 조립한다. listen 은 하지 않는다 — index.ts 가 띄우고,
 * 테스트는 app.inject 로 같은 앱을 그대로 두드린다.
 */
export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: opts.logger ?? false,
  });

  // 전역 에러 핸들러 — DB 에러 내용이 응답으로 새지 않게 한다.
  registerErrorHandler(fastify);

  // CORS 설정
  //
  // credentials(쿠키)를 크로스오리진으로 보내지 않는다. 이전의 origin:true +
  // credentials:true 조합은 임의 사이트가 관리자 세션 쿠키로 요청을 보낼 수 있게
  // 했다 — 그게 실제 취약점이었다. 검색 API는 브라우저에서 크로스오리진으로
  // 불리는 것이 정상이라 오리진은 기본 허용하되(CORS_ORIGIN으로 잠글 수 있음),
  // 자격증명은 끈다. 동일 출처 대시보드 요청은 CORS 대상이 아니라 영향 없다.
  await fastify.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : true,
    credentials: false,
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
  
  // Health check — 컨테이너 헬스체크는 사내 서비스 전부 /healthz 로 맞춘다.
  fastify.get('/healthz', async () => ({ ok: true }));
  
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

  return fastify;
}

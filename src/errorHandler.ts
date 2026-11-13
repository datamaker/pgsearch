import type { FastifyError, FastifyInstance } from 'fastify';
import { isMsError } from './services/indexService.js';

/**
 * 전역 에러 핸들러.
 *
 * 예전에는 처리되지 않은 에러(대부분 PostgreSQL 에러)가 Fastify 기본 핸들러로 가서
 * 메시지가 그대로 응답에 실렸다 — `syntax error in tsquery: "..."`, 테이블/컬럼 이름,
 * 제약 조건 이름 같은 내부 정보가 보였다. 이제 5xx 는 실제 에러를 서버 로그에만 남기고
 * 응답은 Meilisearch 형식의 일반 메시지로 통일한다.
 */

const INTERNAL_ERROR = {
  message: 'An internal error has occurred.',
  code: 'internal',
  type: 'internal',
  link: 'https://docs.meilisearch.com/errors#internal',
};

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    // 서비스 계층이 던진 Meilisearch 형식 에러(라우트가 직접 처리하지 못한 것) → 400.
    if (isMsError(error)) {
      return reply.status(error.code === 'index_not_found' ? 404 : 400).send(error);
    }

    // Fastify 자체의 클라이언트 오류(잘못된 JSON, 본문 초과, 지원 안 하는 미디어 타입 등).
    // 이 메시지들은 Fastify 가 만든 것이라 내부 정보가 없다. (PostgreSQL 에러에는
    // statusCode 가 없으므로 여기로 오지 않는다.)
    const status = error.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const code = status === 413 ? 'payload_too_large' : status === 415 ? 'unsupported_media_type' : 'bad_request';
      // Fastify 가 만든 메시지(FST_*)만 그대로 보여 주고, 그 밖의 것은 고정 문구로 바꾼다.
      const message = /^FST_/.test(error.code ?? '')
        ? error.message
        : error instanceof SyntaxError
          ? 'Malformed JSON in request body.'
          : 'Bad request.';
      return reply.status(status).send({
        message,
        code,
        type: 'invalid_request',
        link: `https://docs.meilisearch.com/errors#${code}`,
      });
    }

    // 나머지는 전부 내부 오류. 실제 내용은 로그에만.
    request.log.error({ err: error, url: request.url, method: request.method }, 'unhandled error');
    return reply.status(500).send(INTERNAL_ERROR);
  });
}

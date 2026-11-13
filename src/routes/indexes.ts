import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import * as indexService from '../services/indexService.js';
import { parseListPagination } from '../services/searchValidation.js';
import type { CreateIndexRequest, UpdateIndexRequest, MsError } from '../types/meilisearch.js';

interface ListQuery {
  offset?: string;
  limit?: string;
}

interface UidParams {
  uid: string;
}

export async function indexRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /indexes - 모든 인덱스 조회
  fastify.get<{ Querystring: ListQuery }>(
    '/indexes',
    async (request, reply) => {
      let page;
      try {
        // 검색과 같은 규칙: 음이 아닌 정수만, limit 은 상한으로 잘라낸다.
        page = parseListPagination(request.query, 'index');
      } catch (error) {
        reply.status(400);
        return error;
      }

      const result = await indexService.listIndexes(page.offset, page.limit);
      return result;
    }
  );

  // GET /indexes/:uid - 특정 인덱스 조회
  fastify.get<{ Params: UidParams }>(
    '/indexes/:uid',
    async (request, reply) => {
      const { uid } = request.params;
      const index = await indexService.getIndex(uid);

      if (!index) {
        reply.status(404);
        return indexService.createError(`Index \`${uid}\` not found.`, 'index_not_found');
      }

      return index;
    }
  );

  // POST /indexes - 인덱스 생성
  fastify.post<{ Body: CreateIndexRequest }>(
    '/indexes',
    async (request, reply) => {
      try {
        const { uid, primaryKey } = request.body ?? ({} as CreateIndexRequest);

        if (!uid) {
          reply.status(400);
          return indexService.createError('Missing field `uid`.', 'missing_index_uid');
        }

        const task = await indexService.createIndex(uid, primaryKey);
        reply.status(202);
        return task;
      } catch (error) {
        if (indexService.isMsError(error)) {
          reply.status(400);
          return error;
        }
        throw error;
      }
    }
  );

  // PATCH /indexes/:uid - 인덱스 업데이트
  fastify.patch<{ Params: UidParams; Body: UpdateIndexRequest }>(
    '/indexes/:uid',
    async (request, reply) => {
      try {
        const { uid } = request.params;
        const { primaryKey } = request.body ?? ({} as UpdateIndexRequest);

        if (!primaryKey) {
          reply.status(400);
          return indexService.createError('Missing field `primaryKey`.', 'missing_primary_key');
        }

        const task = await indexService.updateIndex(uid, primaryKey);
        reply.status(202);
        return task;
      } catch (error) {
        if ((error as MsError).code === 'index_not_found') {
          reply.status(404);
          return error;
        }
        if (indexService.isMsError(error)) {
          reply.status(400);
          return error;
        }
        throw error;
      }
    }
  );

  // DELETE /indexes/:uid - 인덱스 삭제
  fastify.delete<{ Params: UidParams }>(
    '/indexes/:uid',
    async (request, reply) => {
      try {
        const { uid } = request.params;
        const task = await indexService.deleteIndex(uid);
        reply.status(202);
        return task;
      } catch (error) {
        if ((error as MsError).code === 'index_not_found') {
          reply.status(404);
          return error;
        }
        throw error;
      }
    }
  );
}

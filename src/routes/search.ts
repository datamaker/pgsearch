import type { FastifyInstance } from 'fastify';
import { search } from '../services/searchService.js';
import type { MsSearchRequest, MsError } from '../types/meilisearch.js';

interface IndexParams {
  uid: string;
}

interface SearchQuery {
  q?: string;
  offset?: string;
  limit?: string;
  filter?: string;
  facets?: string;
  attributesToRetrieve?: string;
  attributesToHighlight?: string;
  sort?: string;
  matchingStrategy?: string;
  showRankingScore?: string;
}

export async function searchRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /indexes/:uid/search - 검색
  fastify.post<{ Params: IndexParams; Body: MsSearchRequest }>(
    '/indexes/:uid/search',
    async (request, reply) => {
      try {
        const { uid } = request.params;
        const result = await search(uid, request.body);
        return result;
      } catch (error) {
        if ((error as MsError).code === 'index_not_found') {
          reply.status(404);
          return error;
        }
        throw error;
      }
    }
  );

  // GET /indexes/:uid/search - 검색 (쿼리 파라미터)
  fastify.get<{ Params: IndexParams; Querystring: SearchQuery }>(
    '/indexes/:uid/search',
    async (request, reply) => {
      try {
        const { uid } = request.params;
        const query = request.query;

        const searchRequest: MsSearchRequest = {
          q: query.q,
          offset: query.offset ? parseInt(query.offset, 10) : undefined,
          limit: query.limit ? parseInt(query.limit, 10) : undefined,
          filter: query.filter,
          facets: query.facets?.split(',').map(f => f.trim()),
          attributesToRetrieve: query.attributesToRetrieve?.split(',').map(f => f.trim()),
          attributesToHighlight: query.attributesToHighlight?.split(',').map(f => f.trim()),
          sort: query.sort?.split(',').map(s => s.trim()),
          matchingStrategy: query.matchingStrategy as MsSearchRequest['matchingStrategy'],
          showRankingScore: query.showRankingScore === 'true',
        };

        const result = await search(uid, searchRequest);
        return result;
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

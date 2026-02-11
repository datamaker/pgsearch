import type { FastifyInstance } from 'fastify';
import * as settingsService from '../services/settingsService.js';
import type { IndexSettings } from '../services/settingsService.js';
import type { MsError } from '../types/meilisearch.js';

interface IndexParams {
  uid: string;
}

export async function settingsRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /indexes/:uid/settings - 모든 설정 조회
  fastify.get<{ Params: IndexParams }>(
    '/indexes/:uid/settings',
    async (request, reply) => {
      try {
        const { uid } = request.params;
        return await settingsService.getSettings(uid);
      } catch (error) {
        if ((error as MsError).code === 'index_not_found') {
          reply.status(404);
          return error;
        }
        throw error;
      }
    }
  );

  // PATCH /indexes/:uid/settings - 설정 업데이트
  fastify.patch<{ Params: IndexParams; Body: Partial<IndexSettings> }>(
    '/indexes/:uid/settings',
    async (request, reply) => {
      try {
        const { uid } = request.params;
        const task = await settingsService.updateSettings(uid, request.body);
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

  // DELETE /indexes/:uid/settings - 설정 초기화
  fastify.delete<{ Params: IndexParams }>(
    '/indexes/:uid/settings',
    async (request, reply) => {
      try {
        const { uid } = request.params;
        const task = await settingsService.resetSettings(uid);
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

  // Searchable Attributes
  fastify.get<{ Params: IndexParams }>(
    '/indexes/:uid/settings/searchable-attributes',
    async (request, reply) => {
      try {
        return await settingsService.getSearchableAttributes(request.params.uid);
      } catch (error) {
        if ((error as MsError).code === 'index_not_found') {
          reply.status(404);
          return error;
        }
        throw error;
      }
    }
  );

  fastify.put<{ Params: IndexParams; Body: string[] }>(
    '/indexes/:uid/settings/searchable-attributes',
    async (request, reply) => {
      try {
        const task = await settingsService.updateSearchableAttributes(request.params.uid, request.body);
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

  // Filterable Attributes
  fastify.get<{ Params: IndexParams }>(
    '/indexes/:uid/settings/filterable-attributes',
    async (request, reply) => {
      try {
        return await settingsService.getFilterableAttributes(request.params.uid);
      } catch (error) {
        if ((error as MsError).code === 'index_not_found') {
          reply.status(404);
          return error;
        }
        throw error;
      }
    }
  );

  fastify.put<{ Params: IndexParams; Body: string[] }>(
    '/indexes/:uid/settings/filterable-attributes',
    async (request, reply) => {
      try {
        const task = await settingsService.updateFilterableAttributes(request.params.uid, request.body);
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

  // Sortable Attributes
  fastify.get<{ Params: IndexParams }>(
    '/indexes/:uid/settings/sortable-attributes',
    async (request, reply) => {
      try {
        return await settingsService.getSortableAttributes(request.params.uid);
      } catch (error) {
        if ((error as MsError).code === 'index_not_found') {
          reply.status(404);
          return error;
        }
        throw error;
      }
    }
  );

  fastify.put<{ Params: IndexParams; Body: string[] }>(
    '/indexes/:uid/settings/sortable-attributes',
    async (request, reply) => {
      try {
        const task = await settingsService.updateSortableAttributes(request.params.uid, request.body);
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

  // Displayed Attributes
  fastify.get<{ Params: IndexParams }>(
    '/indexes/:uid/settings/displayed-attributes',
    async (request, reply) => {
      try {
        return await settingsService.getDisplayedAttributes(request.params.uid);
      } catch (error) {
        if ((error as MsError).code === 'index_not_found') {
          reply.status(404);
          return error;
        }
        throw error;
      }
    }
  );

  fastify.put<{ Params: IndexParams; Body: string[] }>(
    '/indexes/:uid/settings/displayed-attributes',
    async (request, reply) => {
      try {
        const task = await settingsService.updateDisplayedAttributes(request.params.uid, request.body);
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

  // Ranking Rules
  fastify.get<{ Params: IndexParams }>(
    '/indexes/:uid/settings/ranking-rules',
    async (request, reply) => {
      try {
        return await settingsService.getRankingRules(request.params.uid);
      } catch (error) {
        if ((error as MsError).code === 'index_not_found') {
          reply.status(404);
          return error;
        }
        throw error;
      }
    }
  );

  fastify.put<{ Params: IndexParams; Body: string[] }>(
    '/indexes/:uid/settings/ranking-rules',
    async (request, reply) => {
      try {
        const task = await settingsService.updateRankingRules(request.params.uid, request.body);
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

  // Stop Words
  fastify.get<{ Params: IndexParams }>(
    '/indexes/:uid/settings/stop-words',
    async (request, reply) => {
      try {
        return await settingsService.getStopWords(request.params.uid);
      } catch (error) {
        if ((error as MsError).code === 'index_not_found') {
          reply.status(404);
          return error;
        }
        throw error;
      }
    }
  );

  fastify.put<{ Params: IndexParams; Body: string[] }>(
    '/indexes/:uid/settings/stop-words',
    async (request, reply) => {
      try {
        const task = await settingsService.updateStopWords(request.params.uid, request.body);
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

  // Synonyms
  fastify.get<{ Params: IndexParams }>(
    '/indexes/:uid/settings/synonyms',
    async (request, reply) => {
      try {
        return await settingsService.getSynonyms(request.params.uid);
      } catch (error) {
        if ((error as MsError).code === 'index_not_found') {
          reply.status(404);
          return error;
        }
        throw error;
      }
    }
  );

  fastify.put<{ Params: IndexParams; Body: Record<string, string[]> }>(
    '/indexes/:uid/settings/synonyms',
    async (request, reply) => {
      try {
        const task = await settingsService.updateSynonyms(request.params.uid, request.body);
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

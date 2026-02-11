import type { FastifyInstance } from 'fastify';
import * as documentService from '../services/documentService.js';
import { createError } from '../services/indexService.js';
import type { MsError } from '../types/meilisearch.js';

interface IndexParams {
  uid: string;
}

interface DocumentParams {
  uid: string;
  documentId: string;
}

interface ListQuery {
  offset?: string;
  limit?: string;
  fields?: string;
}

interface AddDocumentsQuery {
  primaryKey?: string;
}

export async function documentRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /indexes/:uid/documents - 문서 목록 조회
  fastify.get<{ Params: IndexParams; Querystring: ListQuery }>(
    '/indexes/:uid/documents',
    async (request, reply) => {
      try {
        const { uid } = request.params;
        const offset = parseInt(request.query.offset || '0', 10);
        const limit = parseInt(request.query.limit || '20', 10);
        const fields = request.query.fields?.split(',').map(f => f.trim());

        const result = await documentService.listDocuments(uid, offset, limit, fields);
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

  // GET /indexes/:uid/documents/:documentId - 특정 문서 조회
  fastify.get<{ Params: DocumentParams; Querystring: ListQuery }>(
    '/indexes/:uid/documents/:documentId',
    async (request, reply) => {
      try {
        const { uid, documentId } = request.params;
        const fields = request.query.fields?.split(',').map(f => f.trim());

        const doc = await documentService.getDocument(uid, documentId, fields);

        if (!doc) {
          reply.status(404);
          return createError(
            `Document \`${documentId}\` not found.`,
            'document_not_found'
          );
        }

        return doc;
      } catch (error) {
        if ((error as MsError).code === 'index_not_found') {
          reply.status(404);
          return error;
        }
        throw error;
      }
    }
  );

  // POST /indexes/:uid/documents - 문서 추가/업데이트
  fastify.post<{
    Params: IndexParams;
    Querystring: AddDocumentsQuery;
    Body: Record<string, unknown>[];
  }>(
    '/indexes/:uid/documents',
    async (request, reply) => {
      try {
        const { uid } = request.params;
        const { primaryKey } = request.query;
        const documents = Array.isArray(request.body) ? request.body : [request.body];

        if (documents.length === 0) {
          reply.status(400);
          return createError('No documents provided.', 'missing_documents');
        }

        const task = await documentService.addDocuments(uid, documents, primaryKey);
        reply.status(202);
        return task;
      } catch (error) {
        if ((error as MsError).code === 'index_not_found') {
          reply.status(404);
          return error;
        }
        if ((error as MsError).code) {
          reply.status(400);
          return error;
        }
        throw error;
      }
    }
  );

  // PUT /indexes/:uid/documents - 문서 부분 업데이트 (POST와 동일하게 처리)
  fastify.put<{
    Params: IndexParams;
    Querystring: AddDocumentsQuery;
    Body: Record<string, unknown>[];
  }>(
    '/indexes/:uid/documents',
    async (request, reply) => {
      try {
        const { uid } = request.params;
        const { primaryKey } = request.query;
        const documents = Array.isArray(request.body) ? request.body : [request.body];

        if (documents.length === 0) {
          reply.status(400);
          return createError('No documents provided.', 'missing_documents');
        }

        const task = await documentService.addDocuments(uid, documents, primaryKey);
        reply.status(202);
        return task;
      } catch (error) {
        if ((error as MsError).code === 'index_not_found') {
          reply.status(404);
          return error;
        }
        if ((error as MsError).code) {
          reply.status(400);
          return error;
        }
        throw error;
      }
    }
  );

  // DELETE /indexes/:uid/documents - 모든 문서 삭제
  fastify.delete<{ Params: IndexParams }>(
    '/indexes/:uid/documents',
    async (request, reply) => {
      try {
        const { uid } = request.params;
        const task = await documentService.deleteAllDocuments(uid);
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

  // DELETE /indexes/:uid/documents/:documentId - 특정 문서 삭제
  fastify.delete<{ Params: DocumentParams }>(
    '/indexes/:uid/documents/:documentId',
    async (request, reply) => {
      try {
        const { uid, documentId } = request.params;
        const task = await documentService.deleteDocument(uid, documentId);
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

  // POST /indexes/:uid/documents/delete-batch - 배치 삭제
  fastify.post<{ Params: IndexParams; Body: (string | number)[] }>(
    '/indexes/:uid/documents/delete-batch',
    async (request, reply) => {
      try {
        const { uid } = request.params;
        const docIds = request.body.map(id => String(id));

        if (docIds.length === 0) {
          reply.status(400);
          return createError('No document IDs provided.', 'missing_document_ids');
        }

        const task = await documentService.deleteDocumentsBatch(uid, docIds);
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

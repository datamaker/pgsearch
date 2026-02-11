import { query, getClient } from '../db/connection.js';
import { createTask } from './taskQueue.js';
import { getIndex, createError } from './indexService.js';
import type { MsDocumentListResponse, MsTask } from '../types/meilisearch.js';

interface DocumentRow {
  id: number;
  index_uid: string;
  doc_id: string;
  data: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

// 문서에서 텍스트 필드 추출
function extractTextFields(obj: unknown, texts: string[] = []): string[] {
  if (typeof obj === 'string') {
    texts.push(obj);
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      extractTextFields(item, texts);
    }
  } else if (obj && typeof obj === 'object') {
    for (const value of Object.values(obj)) {
      extractTextFields(value, texts);
    }
  }
  return texts;
}

// 특수문자 이스케이프
function escapeText(text: string): string {
  return text.replace(/'/g, "''");
}

export async function listDocuments(
  indexUid: string,
  offset = 0,
  limit = 20,
  fields?: string[]
): Promise<MsDocumentListResponse> {
  const index = await getIndex(indexUid);
  if (!index) {
    throw createError(`Index \`${indexUid}\` not found.`, 'index_not_found');
  }

  const countResult = await query<{ count: string }>(
    'SELECT COUNT(*) FROM ms_documents WHERE index_uid = $1',
    [indexUid]
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const result = await query<DocumentRow>(
    'SELECT * FROM ms_documents WHERE index_uid = $1 ORDER BY created_at OFFSET $2 LIMIT $3',
    [indexUid, offset, limit]
  );

  let results = result.rows.map(row => row.data);

  // 필드 필터링
  if (fields && fields.length > 0 && !fields.includes('*')) {
    results = results.map(doc => {
      const filtered: Record<string, unknown> = {};
      for (const field of fields) {
        if (field in doc) {
          filtered[field] = doc[field];
        }
      }
      return filtered;
    });
  }

  return { results, offset, limit, total };
}

export async function getDocument(
  indexUid: string,
  docId: string,
  fields?: string[]
): Promise<Record<string, unknown> | null> {
  const index = await getIndex(indexUid);
  if (!index) {
    throw createError(`Index \`${indexUid}\` not found.`, 'index_not_found');
  }

  const result = await query<DocumentRow>(
    'SELECT * FROM ms_documents WHERE index_uid = $1 AND doc_id = $2',
    [indexUid, docId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  let doc = result.rows[0].data;

  // 필드 필터링
  if (fields && fields.length > 0 && !fields.includes('*')) {
    const filtered: Record<string, unknown> = {};
    for (const field of fields) {
      if (field in doc) {
        filtered[field] = doc[field];
      }
    }
    doc = filtered;
  }

  return doc;
}

export async function addDocuments(
  indexUid: string,
  documents: Record<string, unknown>[],
  primaryKey?: string
): Promise<MsTask> {
  const index = await getIndex(indexUid);
  if (!index) {
    throw createError(`Index \`${indexUid}\` not found.`, 'index_not_found');
  }

  // primaryKey 결정
  let pkField = index.primaryKey || primaryKey;

  // primaryKey가 없으면 첫 문서에서 추론
  if (!pkField && documents.length > 0) {
    const firstDoc = documents[0];
    if ('id' in firstDoc) pkField = 'id';
    else {
      const keys = Object.keys(firstDoc);
      const idKey = keys.find(k => k.toLowerCase().includes('id'));
      if (idKey) pkField = idKey;
    }
  }

  if (!pkField) {
    throw createError(
      'Primary key inference failed. Please specify the primary key.',
      'primary_key_inference_failed'
    );
  }

  // primaryKey 업데이트 (설정 안 되어 있으면)
  if (!index.primaryKey) {
    await query(
      'UPDATE ms_indexes SET primary_key = $1, updated_at = NOW() WHERE uid = $2',
      [pkField, indexUid]
    );
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    for (const doc of documents) {
      const docId = String(doc[pkField]);
      if (!docId) {
        throw createError(
          `Document does not have a \`${pkField}\` attribute.`,
          'missing_document_id'
        );
      }

      const texts = extractTextFields(doc);
      const searchText = texts.join(' ');
      const escapedSearchText = escapeText(searchText);

      await client.query(
        `INSERT INTO ms_documents (index_uid, doc_id, data, search_text, search_vector)
         VALUES ($1, $2, $3, $4, to_tsvector('simple', $4))
         ON CONFLICT (index_uid, doc_id)
         DO UPDATE SET
           data = EXCLUDED.data,
           search_text = EXCLUDED.search_text,
           search_vector = EXCLUDED.search_vector,
           updated_at = NOW()`,
        [indexUid, docId, JSON.stringify(doc), searchText]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return createTask(indexUid, 'documentAdditionOrUpdate', {
    receivedDocuments: documents.length,
    indexedDocuments: documents.length,
  });
}

export async function deleteAllDocuments(indexUid: string): Promise<MsTask> {
  const index = await getIndex(indexUid);
  if (!index) {
    throw createError(`Index \`${indexUid}\` not found.`, 'index_not_found');
  }

  const result = await query(
    'DELETE FROM ms_documents WHERE index_uid = $1',
    [indexUid]
  );

  return createTask(indexUid, 'documentDeletion', {
    deletedDocuments: result.rowCount,
  });
}

export async function deleteDocument(indexUid: string, docId: string): Promise<MsTask> {
  const index = await getIndex(indexUid);
  if (!index) {
    throw createError(`Index \`${indexUid}\` not found.`, 'index_not_found');
  }

  const result = await query(
    'DELETE FROM ms_documents WHERE index_uid = $1 AND doc_id = $2',
    [indexUid, docId]
  );

  return createTask(indexUid, 'documentDeletion', {
    deletedDocuments: result.rowCount,
  });
}

export async function deleteDocumentsBatch(
  indexUid: string,
  docIds: string[]
): Promise<MsTask> {
  const index = await getIndex(indexUid);
  if (!index) {
    throw createError(`Index \`${indexUid}\` not found.`, 'index_not_found');
  }

  const result = await query(
    'DELETE FROM ms_documents WHERE index_uid = $1 AND doc_id = ANY($2)',
    [indexUid, docIds]
  );

  return createTask(indexUid, 'documentDeletion', {
    deletedDocuments: result.rowCount,
  });
}

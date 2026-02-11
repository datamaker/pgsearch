import { query } from '../db/connection.js';
import { createTask } from './taskQueue.js';
import type { MsIndex, MsIndexListResponse, MsTask, MsError } from '../types/meilisearch.js';

interface IndexRow {
  uid: string;
  primary_key: string | null;
  created_at: Date;
  updated_at: Date;
}

export function createError(message: string, code: string): MsError {
  return {
    message,
    code,
    type: 'invalid_request',
    link: `https://docs.meilisearch.com/errors#${code}`,
  };
}

export async function listIndexes(offset = 0, limit = 20): Promise<MsIndexListResponse> {
  const countResult = await query<{ count: string }>('SELECT COUNT(*) FROM ms_indexes');
  const total = parseInt(countResult.rows[0].count, 10);

  const result = await query<IndexRow>(
    'SELECT * FROM ms_indexes ORDER BY created_at DESC OFFSET $1 LIMIT $2',
    [offset, limit]
  );

  return {
    results: result.rows.map(formatIndex),
    offset,
    limit,
    total,
  };
}

export async function getIndex(uid: string): Promise<MsIndex | null> {
  const result = await query<IndexRow>(
    'SELECT * FROM ms_indexes WHERE uid = $1',
    [uid]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return formatIndex(result.rows[0]);
}

export async function createIndex(uid: string, primaryKey?: string): Promise<MsTask> {
  // uid 유효성 검사
  if (!/^[a-zA-Z0-9_-]+$/.test(uid)) {
    throw createError(
      'Index uid can only contain alphanumeric characters, hyphens, and underscores.',
      'invalid_index_uid'
    );
  }

  // 이미 존재하는지 확인
  const existing = await getIndex(uid);
  if (existing) {
    throw createError(`Index \`${uid}\` already exists.`, 'index_already_exists');
  }

  await query(
    'INSERT INTO ms_indexes (uid, primary_key) VALUES ($1, $2)',
    [uid, primaryKey || null]
  );

  return createTask(uid, 'indexCreation');
}

export async function updateIndex(uid: string, primaryKey: string): Promise<MsTask> {
  const existing = await getIndex(uid);
  if (!existing) {
    throw createError(`Index \`${uid}\` not found.`, 'index_not_found');
  }

  // 문서가 있으면 primaryKey 변경 불가
  const docCount = await query<{ count: string }>(
    'SELECT COUNT(*) FROM ms_documents WHERE index_uid = $1',
    [uid]
  );
  if (parseInt(docCount.rows[0].count, 10) > 0 && existing.primaryKey !== primaryKey) {
    throw createError(
      'Primary key cannot be changed when documents exist.',
      'index_primary_key_already_exists'
    );
  }

  await query(
    'UPDATE ms_indexes SET primary_key = $1, updated_at = NOW() WHERE uid = $2',
    [primaryKey, uid]
  );

  return createTask(uid, 'indexUpdate');
}

export async function deleteIndex(uid: string): Promise<MsTask> {
  const existing = await getIndex(uid);
  if (!existing) {
    throw createError(`Index \`${uid}\` not found.`, 'index_not_found');
  }

  await query('DELETE FROM ms_indexes WHERE uid = $1', [uid]);

  return createTask(uid, 'indexDeletion');
}

function formatIndex(row: IndexRow): MsIndex {
  return {
    uid: row.uid,
    primaryKey: row.primary_key,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

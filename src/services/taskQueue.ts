import { query } from '../db/connection.js';
import type { MsTask } from '../types/meilisearch.js';

type TaskType =
  | 'indexCreation'
  | 'indexUpdate'
  | 'indexDeletion'
  | 'documentAdditionOrUpdate'
  | 'documentDeletion';

interface TaskRow {
  uid: number;
  index_uid: string;
  status: string;
  type: string;
  details: Record<string, unknown> | null;
  error: { message: string; code: string; type: string; link: string } | null;
  enqueued_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export async function createTask(
  indexUid: string,
  type: TaskType,
  details?: Record<string, unknown>
): Promise<MsTask> {
  const result = await query<TaskRow>(
    `INSERT INTO ms_tasks (index_uid, type, details, status)
     VALUES ($1, $2, $3, 'succeeded')
     RETURNING *`,
    [indexUid, type, details ? JSON.stringify(details) : null]
  );

  const row = result.rows[0];
  return formatTask(row);
}

export async function getTask(taskUid: number): Promise<MsTask | null> {
  const result = await query<TaskRow>(
    'SELECT * FROM ms_tasks WHERE uid = $1',
    [taskUid]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return formatTask(result.rows[0]);
}

function formatTask(row: TaskRow): MsTask {
  return {
    taskUid: row.uid,
    indexUid: row.index_uid,
    status: row.status as MsTask['status'],
    type: row.type,
    enqueuedAt: row.enqueued_at.toISOString(),
    startedAt: row.started_at?.toISOString(),
    finishedAt: row.finished_at?.toISOString(),
    details: row.details ?? undefined,
    error: row.error ?? undefined,
  };
}

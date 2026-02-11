import { query } from '../db/connection.js';
import { getIndex, createError } from './indexService.js';
import { createTask } from './taskQueue.js';
import type { MsTask } from '../types/meilisearch.js';

export interface IndexSettings {
  searchableAttributes: string[];
  displayedAttributes: string[];
  filterableAttributes: string[];
  sortableAttributes: string[];
  rankingRules: string[];
  stopWords: string[];
  synonyms: Record<string, string[]>;
  distinctAttribute: string | null;
  typoTolerance: {
    enabled: boolean;
    minWordSizeForTypos: {
      oneTypo: number;
      twoTypos: number;
    };
  };
  pagination: {
    maxTotalHits: number;
  };
}

interface SettingsRow {
  index_uid: string;
  searchable_attributes: string[];
  displayed_attributes: string[];
  filterable_attributes: string[];
  sortable_attributes: string[];
  ranking_rules: string[];
  stop_words: string[];
  synonyms: Record<string, string[]>;
  distinct_attribute: string | null;
  typo_tolerance: IndexSettings['typoTolerance'];
  pagination: IndexSettings['pagination'];
}

const DEFAULT_SETTINGS: IndexSettings = {
  searchableAttributes: ['*'],
  displayedAttributes: ['*'],
  filterableAttributes: [],
  sortableAttributes: [],
  rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
  stopWords: [],
  synonyms: {},
  distinctAttribute: null,
  typoTolerance: {
    enabled: true,
    minWordSizeForTypos: {
      oneTypo: 5,
      twoTypos: 9,
    },
  },
  pagination: {
    maxTotalHits: 1000,
  },
};

export async function getSettings(indexUid: string): Promise<IndexSettings> {
  const index = await getIndex(indexUid);
  if (!index) {
    throw createError(`Index \`${indexUid}\` not found.`, 'index_not_found');
  }

  const result = await query<SettingsRow>(
    'SELECT * FROM ms_settings WHERE index_uid = $1',
    [indexUid]
  );

  if (result.rows.length === 0) {
    // 설정이 없으면 기본값으로 생성
    await query(
      'INSERT INTO ms_settings (index_uid) VALUES ($1) ON CONFLICT DO NOTHING',
      [indexUid]
    );
    return DEFAULT_SETTINGS;
  }

  return formatSettings(result.rows[0]);
}

export async function updateSettings(
  indexUid: string,
  settings: Partial<IndexSettings>
): Promise<MsTask> {
  const index = await getIndex(indexUid);
  if (!index) {
    throw createError(`Index \`${indexUid}\` not found.`, 'index_not_found');
  }

  // 기존 설정이 없으면 생성
  await query(
    'INSERT INTO ms_settings (index_uid) VALUES ($1) ON CONFLICT DO NOTHING',
    [indexUid]
  );

  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (settings.searchableAttributes !== undefined) {
    updates.push(`searchable_attributes = $${paramIndex++}`);
    values.push(JSON.stringify(settings.searchableAttributes));
  }
  if (settings.displayedAttributes !== undefined) {
    updates.push(`displayed_attributes = $${paramIndex++}`);
    values.push(JSON.stringify(settings.displayedAttributes));
  }
  if (settings.filterableAttributes !== undefined) {
    updates.push(`filterable_attributes = $${paramIndex++}`);
    values.push(JSON.stringify(settings.filterableAttributes));
  }
  if (settings.sortableAttributes !== undefined) {
    updates.push(`sortable_attributes = $${paramIndex++}`);
    values.push(JSON.stringify(settings.sortableAttributes));
  }
  if (settings.rankingRules !== undefined) {
    updates.push(`ranking_rules = $${paramIndex++}`);
    values.push(JSON.stringify(settings.rankingRules));
  }
  if (settings.stopWords !== undefined) {
    updates.push(`stop_words = $${paramIndex++}`);
    values.push(JSON.stringify(settings.stopWords));
  }
  if (settings.synonyms !== undefined) {
    updates.push(`synonyms = $${paramIndex++}`);
    values.push(JSON.stringify(settings.synonyms));
  }
  if (settings.distinctAttribute !== undefined) {
    updates.push(`distinct_attribute = $${paramIndex++}`);
    values.push(settings.distinctAttribute);
  }
  if (settings.typoTolerance !== undefined) {
    updates.push(`typo_tolerance = $${paramIndex++}`);
    values.push(JSON.stringify(settings.typoTolerance));
  }
  if (settings.pagination !== undefined) {
    updates.push(`pagination = $${paramIndex++}`);
    values.push(JSON.stringify(settings.pagination));
  }

  if (updates.length > 0) {
    updates.push(`updated_at = NOW()`);
    values.push(indexUid);

    await query(
      `UPDATE ms_settings SET ${updates.join(', ')} WHERE index_uid = $${paramIndex}`,
      values
    );
  }

  return createTask(indexUid, 'indexUpdate', { settings: Object.keys(settings) });
}

export async function resetSettings(indexUid: string): Promise<MsTask> {
  const index = await getIndex(indexUid);
  if (!index) {
    throw createError(`Index \`${indexUid}\` not found.`, 'index_not_found');
  }

  await query('DELETE FROM ms_settings WHERE index_uid = $1', [indexUid]);
  await query('INSERT INTO ms_settings (index_uid) VALUES ($1)', [indexUid]);

  return createTask(indexUid, 'indexUpdate', { settings: 'reset' });
}

// 개별 설정 가져오기
export async function getSearchableAttributes(indexUid: string): Promise<string[]> {
  const settings = await getSettings(indexUid);
  return settings.searchableAttributes;
}

export async function getFilterableAttributes(indexUid: string): Promise<string[]> {
  const settings = await getSettings(indexUid);
  return settings.filterableAttributes;
}

export async function getSortableAttributes(indexUid: string): Promise<string[]> {
  const settings = await getSettings(indexUid);
  return settings.sortableAttributes;
}

export async function getDisplayedAttributes(indexUid: string): Promise<string[]> {
  const settings = await getSettings(indexUid);
  return settings.displayedAttributes;
}

export async function getRankingRules(indexUid: string): Promise<string[]> {
  const settings = await getSettings(indexUid);
  return settings.rankingRules;
}

export async function getStopWords(indexUid: string): Promise<string[]> {
  const settings = await getSettings(indexUid);
  return settings.stopWords;
}

export async function getSynonyms(indexUid: string): Promise<Record<string, string[]>> {
  const settings = await getSettings(indexUid);
  return settings.synonyms;
}

// 개별 설정 업데이트
export async function updateSearchableAttributes(indexUid: string, value: string[]): Promise<MsTask> {
  return updateSettings(indexUid, { searchableAttributes: value });
}

export async function updateFilterableAttributes(indexUid: string, value: string[]): Promise<MsTask> {
  return updateSettings(indexUid, { filterableAttributes: value });
}

export async function updateSortableAttributes(indexUid: string, value: string[]): Promise<MsTask> {
  return updateSettings(indexUid, { sortableAttributes: value });
}

export async function updateDisplayedAttributes(indexUid: string, value: string[]): Promise<MsTask> {
  return updateSettings(indexUid, { displayedAttributes: value });
}

export async function updateRankingRules(indexUid: string, value: string[]): Promise<MsTask> {
  return updateSettings(indexUid, { rankingRules: value });
}

export async function updateStopWords(indexUid: string, value: string[]): Promise<MsTask> {
  return updateSettings(indexUid, { stopWords: value });
}

export async function updateSynonyms(indexUid: string, value: Record<string, string[]>): Promise<MsTask> {
  return updateSettings(indexUid, { synonyms: value });
}

function formatSettings(row: SettingsRow): IndexSettings {
  return {
    searchableAttributes: row.searchable_attributes,
    displayedAttributes: row.displayed_attributes,
    filterableAttributes: row.filterable_attributes,
    sortableAttributes: row.sortable_attributes,
    rankingRules: row.ranking_rules,
    stopWords: row.stop_words,
    synonyms: row.synonyms,
    distinctAttribute: row.distinct_attribute,
    typoTolerance: row.typo_tolerance,
    pagination: row.pagination,
  };
}

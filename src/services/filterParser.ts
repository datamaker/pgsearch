// Meilisearch 필터 문법을 SQL WHERE 절로 변환

type FilterValue = string | string[] | string[][];

interface ParsedCondition {
  sql: string;
  params: unknown[];
}

// 연산자 매핑
const OPERATORS: Record<string, string> = {
  '=': '=',
  '!=': '!=',
  '>': '>',
  '>=': '>=',
  '<': '<',
  '<=': '<=',
};

// 값에서 따옴표 제거
function unquote(value: string): string {
  if ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1);
  }
  return value;
}

// 단일 조건 파싱: "field = 'value'" 또는 "field > 100"
function parseCondition(condition: string, paramIndex: number): ParsedCondition {
  condition = condition.trim();

  // 연산자 찾기
  for (const [op, sqlOp] of Object.entries(OPERATORS)) {
    const parts = condition.split(new RegExp(`\\s*${op.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`));
    if (parts.length === 2) {
      const field = parts[0].trim();
      const value = unquote(parts[1].trim());

      // 숫자인지 확인
      const isNumeric = !isNaN(Number(value)) && value !== '';

      if (isNumeric) {
        return {
          sql: `(data->>'${field}')::numeric ${sqlOp} $${paramIndex}`,
          params: [Number(value)],
        };
      } else {
        return {
          sql: `data->>'${field}' ${sqlOp} $${paramIndex}`,
          params: [value],
        };
      }
    }
  }

  // IS NULL / IS NOT NULL
  if (condition.toLowerCase().includes(' is null')) {
    const field = condition.replace(/\s+is\s+null/i, '').trim();
    return { sql: `data->>'${field}' IS NULL`, params: [] };
  }
  if (condition.toLowerCase().includes(' is not null')) {
    const field = condition.replace(/\s+is\s+not\s+null/i, '').trim();
    return { sql: `data->>'${field}' IS NOT NULL`, params: [] };
  }

  // EXISTS
  if (condition.toLowerCase().startsWith('exists(')) {
    const field = condition.slice(7, -1).trim();
    return { sql: `data ? '${field}'`, params: [] };
  }

  // IN 연산자: field IN ['a', 'b']
  const inMatch = condition.match(/^(\w+)\s+IN\s+\[(.*)\]$/i);
  if (inMatch) {
    const field = inMatch[1];
    const values = inMatch[2].split(',').map(v => unquote(v.trim()));
    return {
      sql: `data->>'${field}' = ANY($${paramIndex})`,
      params: [values],
    };
  }

  throw new Error(`Invalid filter syntax: ${condition}`);
}

// 문자열 필터 파싱 (AND, OR 지원)
function parseStringFilter(filter: string): ParsedCondition {
  let sql = '';
  const params: unknown[] = [];
  let paramIndex = 1;

  // 괄호 처리를 위한 간단한 토큰화
  // 실제 구현에서는 더 정교한 파서가 필요
  const tokens = tokenize(filter);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].trim();

    if (token.toUpperCase() === 'AND') {
      sql += ' AND ';
    } else if (token.toUpperCase() === 'OR') {
      sql += ' OR ';
    } else if (token === '(') {
      sql += '(';
    } else if (token === ')') {
      sql += ')';
    } else if (token) {
      const condition = parseCondition(token, params.length + 1);
      sql += condition.sql;
      params.push(...condition.params);
    }
  }

  return { sql, params };
}

// 간단한 토크나이저
function tokenize(filter: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes = false;
  let quoteChar = '';
  let depth = 0;

  for (let i = 0; i < filter.length; i++) {
    const char = filter[i];

    if (!inQuotes && (char === '"' || char === "'")) {
      inQuotes = true;
      quoteChar = char;
      current += char;
    } else if (inQuotes && char === quoteChar) {
      inQuotes = false;
      current += char;
    } else if (!inQuotes && char === '(') {
      if (current.trim()) tokens.push(current.trim());
      tokens.push('(');
      current = '';
      depth++;
    } else if (!inQuotes && char === ')') {
      if (current.trim()) tokens.push(current.trim());
      tokens.push(')');
      current = '';
      depth--;
    } else if (!inQuotes && filter.slice(i, i + 4).toUpperCase() === ' AND') {
      if (current.trim()) tokens.push(current.trim());
      tokens.push('AND');
      current = '';
      i += 3;
    } else if (!inQuotes && filter.slice(i, i + 3).toUpperCase() === ' OR') {
      if (current.trim()) tokens.push(current.trim());
      tokens.push('OR');
      current = '';
      i += 2;
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    tokens.push(current.trim());
  }

  return tokens;
}

// 배열 필터 파싱 (Meilisearch 형식)
// 외부 배열 = AND, 내부 배열 = OR
function parseArrayFilter(filter: string[] | string[][]): ParsedCondition {
  const params: unknown[] = [];
  const conditions: string[] = [];

  for (const item of filter) {
    if (Array.isArray(item)) {
      // 내부 배열은 OR로 연결
      const orConditions: string[] = [];
      for (const subItem of item) {
        const condition = parseCondition(subItem, params.length + 1);
        orConditions.push(condition.sql);
        params.push(...condition.params);
      }
      conditions.push(`(${orConditions.join(' OR ')})`);
    } else {
      const condition = parseCondition(item, params.length + 1);
      conditions.push(condition.sql);
      params.push(...condition.params);
    }
  }

  return {
    sql: conditions.join(' AND '),
    params,
  };
}

// 메인 필터 파싱 함수
export function parseFilter(
  filter: FilterValue | undefined,
  startParamIndex = 1
): ParsedCondition | null {
  if (!filter) {
    return null;
  }

  if (typeof filter === 'string') {
    return parseStringFilter(filter);
  }

  if (Array.isArray(filter)) {
    return parseArrayFilter(filter);
  }

  return null;
}

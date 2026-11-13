// Meilisearch 필터 문법을 SQL WHERE 절로 변환

type FilterValue = string | string[] | string[][];

interface ParsedCondition {
  sql: string;
  params: unknown[];
}

// 연산자 매핑.
// `!=` 는 IS DISTINCT FROM 으로 옮긴다 — SQL 의 `!=` 는 필드가 없는(NULL) 문서를
// 떨어뜨리지만, Meilisearch 의 `!=` 는 "그 값이 아닌 모든 문서"(필드 없는 문서 포함)다.
const OPERATORS: Record<string, string> = {
  '=': '=',
  '!=': 'IS DISTINCT FROM',
  '>': '>',
  '>=': '>=',
  '<': '<',
  '<=': '<=',
};

// "필드 연산자 값" 을 한 번에 가른다. 두 글자 연산자(>=, <=, !=)를 한 글자 연산자보다
// 먼저 시도해야 한다. 예전에는 `=` 부터 차례로 split 해서 `price >= 10` 이
// 필드 "price >" + 값 "10" 으로 읽혔다(그래서 >=, <=, != 가 전부 조용히 빈 결과였다).
// 필드명에는 연산자 문자가 올 수 없고, 값 쪽은 무엇이든 올 수 있다(`url = 'a=b'`).
const COMPARISON = /^([^=!<>]+?)\s*(>=|<=|!=|=|>|<)\s*([\s\S]*)$/;

// 숫자로 읽을 수 있는 값만 numeric 으로 캐스팅한다. 그냥 `::numeric` 을 붙이면 그 필드에
// 숫자가 아닌 값("N/A" 등)을 가진 문서가 하나만 있어도 쿼리 전체가 에러(500)가 된다.
// (상수이며 사용자 입력이 섞이지 않는다.)
const NUMERIC_TEXT = '^\\s*-?[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?\\s*$';

// 값에서 따옴표 제거
function unquote(value: string): string {
  if ((value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1);
  }
  return value;
}

// 단일 조건 파싱: "field = 'value'" 또는 "field > 100"
//
// 필드명은 사용자 입력이므로 SQL에 문자열로 끼워넣지 않고 바인드 파라미터로 넘긴다
// (`data->>$n`). PostgreSQL의 `->>`/`?` 연산자는 우변 키를 파라미터로 받으므로,
// 이렇게 하면 필드명을 통한 SQL 인젝션이 구조적으로 불가능해진다. `startIndex`부터
// 순서대로 플레이스홀더를 소비하며, 반환하는 `params`가 그 순서와 정확히 일치한다.
function parseCondition(condition: string, startIndex: number): ParsedCondition {
  condition = condition.trim();

  // IN / IS NULL / EXISTS 를 비교 연산자보다 먼저 본다 — 값 안에 `=` 가 들어 있는
  // `tag IN ['a=b']` 같은 조건이 비교식으로 잘못 읽히지 않게.

  // IN 연산자: field IN ['a', 'b']
  const inMatch = condition.match(/^(\w+)\s+IN\s+\[([\s\S]*)\]$/i);
  if (inMatch) {
    const field = inMatch[1];
    const values = inMatch[2].split(',').map(v => unquote(v.trim()));
    return {
      sql: `data->>$${startIndex} = ANY($${startIndex + 1})`,
      params: [field, values],
    };
  }

  // IS NOT NULL / IS NULL
  const notNullMatch = condition.match(/^([^=!<>'"]+?)\s+is\s+not\s+null$/i);
  if (notNullMatch) {
    return { sql: `data->>$${startIndex} IS NOT NULL`, params: [notNullMatch[1].trim()] };
  }
  const nullMatch = condition.match(/^([^=!<>'"]+?)\s+is\s+null$/i);
  if (nullMatch) {
    return { sql: `data->>$${startIndex} IS NULL`, params: [nullMatch[1].trim()] };
  }

  // EXISTS
  const existsMatch = condition.match(/^exists\(([\s\S]*)\)$/i);
  if (existsMatch) {
    return { sql: `data ? $${startIndex}`, params: [existsMatch[1].trim()] };
  }

  // 비교 연산자
  const cmp = condition.match(COMPARISON);
  if (cmp) {
    const field = cmp[1].trim();
    const sqlOp = OPERATORS[cmp[2]];
    const value = unquote(cmp[3].trim());
    if (!field) throw new Error(`Invalid filter syntax: ${condition}`);

    // 숫자인지 확인
    const isNumeric = value.trim() !== '' && Number.isFinite(Number(value));

    if (isNumeric) {
      return {
        sql:
          `(CASE WHEN data->>$${startIndex} ~ '${NUMERIC_TEXT}' ` +
          `THEN (data->>$${startIndex})::numeric END) ${sqlOp} $${startIndex + 1}::numeric`,
        params: [field, Number(value)],
      };
    }
    return {
      sql: `data->>$${startIndex} ${sqlOp} $${startIndex + 1}`,
      params: [field, value],
    };
  }

  throw new Error(`Invalid filter syntax: ${condition}`);
}

// 문자열 필터 파싱 (AND, OR 지원)
function parseStringFilter(filter: string, startParamIndex: number): ParsedCondition {
  let sql = '';
  const params: unknown[] = [];

  // 괄호 처리를 위한 간단한 토큰화
  // 실제 구현에서는 더 정교한 파서가 필요
  const tokens = tokenize(filter);

  // 괄호/AND/OR은 사용자 입력이 SQL 구조로 그대로 나가는 유일한 부분이다. 값은 전부
  // 바인딩되지만 구조를 검사하지 않으면 `a = 1) OR (b = 2` 같은 입력이 바깥의
  // `index_uid = $1 AND (...)` 괄호를 닫고 나가서 다른 인덱스 문서까지 매칭시킨다.
  // 그래서 괄호 짝과 "피연산자 ↔ 연산자" 순서를 직접 확인한다.
  let depth = 0;
  let expectOperand = true;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].trim();
    if (!token) continue;
    const upper = token.toUpperCase();

    if (upper === 'AND' || upper === 'OR') {
      if (expectOperand) throw new Error(`Invalid filter syntax: unexpected ${upper}`);
      sql += ` ${upper} `;
      expectOperand = true;
    } else if (token === '(') {
      if (!expectOperand) throw new Error('Invalid filter syntax: unexpected `(`');
      sql += '(';
      depth++;
    } else if (token === ')') {
      if (expectOperand || depth === 0) throw new Error('Invalid filter syntax: unexpected `)`');
      sql += ')';
      depth--;
    } else {
      if (!expectOperand) throw new Error(`Invalid filter syntax: ${token}`);
      const condition = parseCondition(token, startParamIndex + params.length);
      sql += condition.sql;
      params.push(...condition.params);
      expectOperand = false;
    }
  }

  if (depth !== 0) throw new Error('Invalid filter syntax: unbalanced parentheses');
  if (sql && expectOperand) throw new Error('Invalid filter syntax: incomplete expression');

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
function parseArrayFilter(filter: string[] | string[][], startParamIndex: number): ParsedCondition {
  const params: unknown[] = [];
  const conditions: string[] = [];

  for (const item of filter) {
    if (Array.isArray(item)) {
      // 내부 배열은 OR로 연결. 빈 배열은 `()`가 되어 SQL 문법 오류를 내므로 건너뛴다.
      if (item.length === 0) continue;
      const orConditions: string[] = [];
      for (const subItem of item) {
        const condition = parseCondition(subItem, startParamIndex + params.length);
        orConditions.push(condition.sql);
        params.push(...condition.params);
      }
      conditions.push(`(${orConditions.join(' OR ')})`);
    } else {
      const condition = parseCondition(item, startParamIndex + params.length);
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
    return parseStringFilter(filter, startParamIndex);
  }

  if (Array.isArray(filter)) {
    return parseArrayFilter(filter, startParamIndex);
  }

  return null;
}

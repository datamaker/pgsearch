// 환경 설정

export const config = {
  port: parseInt(process.env.PORT || '7700', 10),
  host: process.env.HOST || '0.0.0.0',

  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'jungbin.kwon',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'pgsearch',
  },

  search: {
    defaultLimit: 20,
    maxLimit: 1000,
    similarityThreshold: 0.3,  // pg_trgm 유사도 임계값
  },
};

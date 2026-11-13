import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { pool, closePool } from './connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATION_LOCK_KEY = 770004001;

// Exported so the server can run migrations on boot (see index.ts). The SQL is
// idempotent (CREATE TABLE/EXTENSION … IF NOT EXISTS), so running it on every
// start is safe and means a fresh `docker compose up` comes up with a ready
// schema instead of 500-ing against an empty database.
export async function runMigrations(): Promise<void> {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  console.log('Running migrations...');

  // 여러 프로세스(레플리카, 병렬 테스트)가 동시에 부팅해도 마이그레이션은 한 번에 하나만
  // 돈다. CREATE EXTENSION / ALTER TABLE … IF NOT EXISTS 는 동시에 실행되면 서로 부딪혀
  // 실패할 수 있어서, 세션 단위 advisory lock 으로 줄을 세운다.
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf-8');

      console.log(`  Running: ${file}`);
      try {
        await client.query(sql);
        console.log(`  ✓ ${file} completed`);
      } catch (error) {
        console.error(`  ✗ ${file} failed:`, error);
        throw error;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }

  console.log('All migrations completed successfully!');
}

// Run standalone only when invoked directly (`npm run migrate`), so importing
// this module from the server doesn't kick off a migration + pool close.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  runMigrations()
    .then(() => closePool())
    .catch((error) => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}

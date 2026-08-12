import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { pool, closePool } from './connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Exported so the server can run migrations on boot (see index.ts). The SQL is
// idempotent (CREATE TABLE/EXTENSION … IF NOT EXISTS), so running it on every
// start is safe and means a fresh `docker compose up` comes up with a ready
// schema instead of 500-ing against an empty database.
export async function runMigrations(): Promise<void> {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();

  console.log('Running migrations...');

  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf-8');

    console.log(`  Running: ${file}`);
    try {
      await pool.query(sql);
      console.log(`  ✓ ${file} completed`);
    } catch (error) {
      console.error(`  ✗ ${file} failed:`, error);
      throw error;
    }
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

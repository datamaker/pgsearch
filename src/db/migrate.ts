import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, closePool } from './connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runMigrations(): Promise<void> {
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

runMigrations()
  .then(() => closePool())
  .catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
  });

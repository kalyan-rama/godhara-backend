import fs from 'fs';
import path from 'path';
import { ensureSchema, flushToPostgres, pool } from './index.js';

async function runMigration() {
  console.log("[Migration] Running schema verification...");
  await ensureSchema();

  const dbJsonPath = path.join(process.cwd(), 'data', 'db.json');
  if (!fs.existsSync(dbJsonPath)) {
    console.log("[Migration] No local data/db.json file found to migrate. Database schema has been initialized successfully!");
    process.exit(0);
  }

  console.log("[Migration] Found data/db.json. Reading file contents...");
  try {
    const raw = fs.readFileSync(dbJsonPath, 'utf8');
    const legacyData = JSON.parse(raw);

    console.log("[Migration] Flushing db.json data to live PostgreSQL database tables...");
    await flushToPostgres(legacyData);

    console.log("[Migration] SUCCESS: All data has been migrated successfully from db.json to PostgreSQL!");
    process.exit(0);
  } catch (err: any) {
    console.error("[Migration] ERROR: Migration failed with error:", err.message || err);
    process.exit(1);
  }
}

runMigration();

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');

async function main() {
  const schemaPath = path.join(__dirname, '..', 'database', 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  await db.query(schema);
  console.log('[database] schema is ready');
  await db.close();
}

main().catch(async (error) => {
  console.error('[database] migration failed:', error);
  try { await db.close(); } catch (_) { /* ignore close error */ }
  process.exitCode = 1;
});

'use strict';

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required. Copy .env.example to .env and configure PostgreSQL.');
}

const useSsl = String(process.env.DATABASE_SSL || '').toLowerCase() === 'true';
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  max: 12,
  idleTimeoutMillis: 30000
});

pool.on('error', (error) => {
  console.error('[database] idle client error', error);
});

async function query(text, values) {
  return pool.query(text, values);
}

async function close() {
  await pool.end();
}

module.exports = { query, close, pool };

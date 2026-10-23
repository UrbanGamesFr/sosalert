'use strict';
// Applique les fichiers migrations/*.sql dans l'ordre, une seule fois chacun.
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(424242)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const dir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    const done = new Set((await client.query('SELECT version FROM schema_migrations')).rows.map(r => r.version));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [f]);
        await client.query('COMMIT');
        console.log(`migration appliquée : ${f}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
    }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(424242)'); } catch (_) { /* ignore */ }
    client.release();
  }
}

module.exports = { migrate };

if (require.main === module) {
  migrate().then(() => pool.end()).catch(e => { console.error(e); process.exit(1); });
}

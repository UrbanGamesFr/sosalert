'use strict';
// Processus séparé de l'API : envois, échéances de trajet, rétention.
// Si l'API tombe, les échéances continuent d'être surveillées ; et inversement.
const { migrate } = require('./migrate');
const jobs = require('./jobs');
const { pool } = require('./db');

let stopping = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loop(name, everyMs, fn) {
  while (!stopping) {
    const t0 = Date.now();
    try { await fn(); } catch (e) { console.error(`[worker:${name}]`, e); }
    await sleep(Math.max(200, everyMs - (Date.now() - t0)));
  }
}

(async () => {
  await migrate();
  console.log('SOSAlert worker démarré');
  // Heartbeat lisible par la supervision : dernière exécution réussie
  await pool.query('CREATE TABLE IF NOT EXISTS worker_heartbeat (id int PRIMARY KEY, at timestamptz NOT NULL)');
  await Promise.all([
    loop('notifications', 2000, async () => { while (await jobs.processNotifications(20) === 20 && !stopping) { /* vider la file */ } }),
    loop('trips', 5000, () => jobs.processTrips()),
    loop('heartbeat', 30000, () => pool.query('INSERT INTO worker_heartbeat (id, at) VALUES (1, now()) ON CONFLICT (id) DO UPDATE SET at=now()')),
    loop('retention', 3600000, () => jobs.retention()),
  ]);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; setTimeout(() => process.exit(0), 5000).unref(); });

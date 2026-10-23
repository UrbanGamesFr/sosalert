'use strict';
const config = require('./config');
const { migrate } = require('./migrate');
const { build } = require('./app');

(async () => {
  await migrate();
  const app = build();
  await app.listen({ port: config.port, host: config.host });
  console.log(`SOSAlert API en écoute sur ${config.host}:${config.port} (${config.publicUrl})`);
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
})().catch(e => { console.error(e); process.exit(1); });

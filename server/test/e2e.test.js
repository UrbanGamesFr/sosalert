'use strict';
// Tests de bout en bout sur une vraie base PostgreSQL (DATABASE_URL), envois en mémoire.
// Couvre les scénarios de recette R-01 à R-09 et R-12 du cahier des charges.
process.env.MAIL_TRANSPORT = 'memory';
process.env.PUBLIC_URL = 'https://alert.test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://sosalert:dev@localhost/sosalert_test';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const { migrate } = require('../src/migrate');
const { build } = require('../src/app');
const jobs = require('../src/jobs');
const mailer = require('../src/mailer');
const push = require('../src/push');

let app;
const ORIGIN = 'https://alert.test';

function cookieOf(res) {
  const sc = [].concat(res.headers['set-cookie'] || []);
  const m = sc.map(c => /sid=([^;]+)/.exec(c)).find(Boolean);
  return m ? `sid=${m[1]}` : null;
}
async function call(method, url, { body, cookie, headers = {} } = {}) {
  const res = await app.inject({ method, url, payload: body, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...headers } });
  let json = null; try { json = res.json(); } catch (_) { /* vide */ }
  return { status: res.statusCode, json, res };
}
const lastMailTo = to => [...mailer.outbox].reverse().find(m => m.to === to);
const linkIn = (mail, prefix) => new RegExp(`https://alert\\.test/${prefix}/([A-Za-z0-9_-]+)`).exec(mail.text)[1];
const drain = async () => { for (let i = 0; i < 10; i++) if (!(await jobs.processNotifications(50))) break; };
const pos = (lat = 49.05, lng = 2.1) => ({ lat, lng, accuracy: 12, measuredAt: Date.now() - 5000 });

async function newUser(email, name = 'Christian') {
  const r = await call('POST', '/api/auth/register', { body: { email, password: 'motdepasse-solide', name, acceptTerms: '2026-10' } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const cookie = cookieOf(r.res);
  await drain();
  const token = linkIn(lastMailTo(email), 'v');
  assert.equal((await call('POST', '/api/auth/verify', { body: { token } })).status, 200);
  return cookie;
}
async function activeContact(cookie, name, email) {
  const r = await call('POST', '/api/contacts', { cookie, body: { name, email } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await drain();
  const token = linkIn(lastMailTo(email), 'i');
  return { id: r.json.contact.id, inviteToken: token };
}

test.before(async () => {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  app = build();
  await app.ready();
});
test.after(async () => { await app.close(); await db.pool.end(); });

test('R-01 inscription : contacts bloqués tant que l’e-mail n’est pas vérifié', async () => {
  const r = await call('POST', '/api/auth/register', { body: { email: 'nv@exemple.fr', password: 'motdepasse-solide', name: 'NV', acceptTerms: '2026-10' } });
  const cookie = cookieOf(r.res);
  const c = await call('POST', '/api/contacts', { cookie, body: { name: 'X', email: 'x@exemple.fr' } });
  assert.equal(c.status, 403);
  assert.equal(c.json.error, 'unverified');
  const bad = await call('POST', '/api/auth/register', { body: { email: 'nv2@exemple.fr', password: 'court', name: 'NV', acceptTerms: '2026-10' } });
  assert.equal(bad.status, 400);
  const noTerms = await call('POST', '/api/auth/register', { body: { email: 'nv3@exemple.fr', password: 'motdepasse-solide', name: 'NV' } });
  assert.equal(noTerms.status, 400);
});

test('R-02/R-04/R-05 : invitation, SOS idempotent, échec d’un canal sans blocage, accusé, clôture', async () => {
  const cookie = await newUser('chris@exemple.fr');
  const cam = await activeContact(cookie, 'Camille', 'camille@exemple.fr');
  const bad = await activeContact(cookie, 'Echec', 'boite-pleine@exemple.fr');
  // Simule une adresse que le prestataire rejette à partir de maintenant
  await db.query(`UPDATE contacts SET email='echec@exemple.fr' WHERE id=$1`, [bad.id]);

  // Avant acceptation : aucun destinataire (R-02)
  let a = await call('POST', '/api/alerts', { cookie, headers: { 'idempotency-key': 'k'.repeat(20) }, body: { type: 'Urgence', position: pos() } });
  assert.equal(a.status, 201);
  assert.equal(a.json.alert.status, 'sans_destinataire');
  assert.equal(a.json.alert.recipients.length, 0);

  for (const c of [cam, bad]) {
    const inv = await call('GET', `/api/public/invite/${c.inviteToken}`);
    assert.equal(inv.json.ownerName, 'Christian');
    assert.equal((await call('POST', `/api/public/invite/${c.inviteToken}/accept`)).json.status, 'active');
  }

  // Abonnement push du contact Camille
  const sub = { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } };
  assert.equal((await call('POST', `/api/public/invite/${cam.inviteToken}/push`, { body: { subscription: sub } })).status, 200);

  // SOS envoyé deux fois avec la même clé (perte réseau, R-09) : une seule alerte
  const key = 'sos-' + Date.now() + '-abcdefgh';
  const a1 = await call('POST', '/api/alerts', { cookie, headers: { 'idempotency-key': key }, body: { type: 'Agression', comment: 'Rue de la Gare', position: pos() } });
  const a2 = await call('POST', '/api/alerts', { cookie, headers: { 'idempotency-key': key }, body: { type: 'Agression', comment: 'Rue de la Gare', position: pos() } });
  assert.equal(a1.status, 201); assert.equal(a2.status, 200);
  assert.equal(a1.json.alert.id, a2.json.alert.id);
  const n = (await db.query('SELECT count(*)::int n FROM notifications WHERE alert_id=$1', [a1.json.alert.id])).rows[0].n;
  assert.equal(n, 3, 'e-mail Camille + push Camille + e-mail Echec, pas de doublon');

  // Envoi : Camille OK, l'adresse en échec est retentée 5 fois puis marquée en échec (R-05)
  for (let i = 0; i < 6; i++) { await db.query(`UPDATE notifications SET next_attempt_at=now() WHERE state='queued'`); await drain(); }
  const det = (await call('GET', `/api/alerts/${a1.json.alert.id}`, { cookie })).json.alert;
  const camR = det.recipients.find(r => r.name === 'Camille');
  const badR = det.recipients.find(r => r.name === 'Echec');
  assert.ok(camR.deliveries.every(d => d.state === 'sent'));
  assert.equal(badR.deliveries[0].state, 'failed');
  assert.equal(badR.deliveries[0].attempts, 5);
  assert.equal(det.status, 'echec_partiel');
  assert.ok(push.sentInMemory.some(p => p.endpoint === sub.endpoint && /ALERTE/.test(p.payload.title)));

  // Le contact consulte puis accuse réception
  const mail = lastMailTo('camille@exemple.fr');
  assert.match(mail.subject, /ALERTE/);
  const viewToken = linkIn(mail, 'a');
  const view = await call('GET', `/api/public/alert/${viewToken}`);
  assert.equal(view.json.type, 'Agression');
  assert.equal(view.json.positions.length, 1);
  assert.equal((await call('POST', `/api/public/alert/${viewToken}/ack`)).status, 200);
  assert.equal((await call('GET', `/api/alerts/${a1.json.alert.id}`, { cookie })).json.alert.status, 'accusee');

  // Le jeton du lien a été purgé de la file après envoi
  const leftovers = (await db.query(`SELECT count(*)::int n FROM notifications WHERE state IN ('sent','failed') AND payload <> '{}'::jsonb`)).rows[0].n;
  assert.equal(leftovers, 0);

  // Clôture : notification envoyée aux contacts qui avaient reçu l'alerte
  const closed = await call('POST', `/api/alerts/${a1.json.alert.id}/close`, { cookie });
  assert.equal(closed.json.alert.status, 'cloturee');
  await drain();
  assert.match(lastMailTo('camille@exemple.fr').subject, /clôturé/);
  assert.equal((await call('GET', `/api/public/alert/${viewToken}`)).json.status, 'cloturee');
  assert.equal((await call('POST', `/api/alerts/${a1.json.alert.id}/positions`, { cookie, body: { position: pos() } })).status, 409);
});

test('R-03 révocation : retrait du contact = partages révoqués immédiatement', async () => {
  const cookie = await newUser('rev@exemple.fr', 'Rev');
  const c = await activeContact(cookie, 'Lea', 'lea@exemple.fr');
  await call('POST', `/api/public/invite/${c.inviteToken}/accept`);
  const s = await call('POST', '/api/shares', { cookie, body: { contactId: c.id, minutes: 60, position: pos() } });
  assert.equal(s.status, 200);
  const token = s.json.share.url.split('/p/')[1];
  assert.equal((await call('GET', `/api/public/share/${token}`)).status, 200);
  assert.equal((await call('DELETE', `/api/contacts/${c.id}`, { cookie })).status, 200);
  assert.equal((await call('GET', `/api/public/share/${token}`)).status, 404);
  // Après retrait, plus aucune alerte ne lui parvient
  const a = await call('POST', '/api/alerts', { cookie, headers: { 'idempotency-key': 'rev-' + 'x'.repeat(20) }, body: { position: pos() } });
  assert.equal(a.json.alert.recipients.length, 0);
});

test('R-07/R-08 trajet : échéance serveur, délai de grâce, alerte unique ; fin avant échéance = pas d’alerte', async () => {
  const cookie = await newUser('trip@exemple.fr', 'Tom');
  const c = await activeContact(cookie, 'Sam', 'sam@exemple.fr');
  await call('POST', `/api/public/invite/${c.inviteToken}/accept`);

  const t = await call('POST', '/api/trips', { cookie, body: { minutes: 30, graceMinutes: 5, contactIds: [c.id], consent: true, label: 'Retour gare' } });
  assert.equal(t.status, 200, JSON.stringify(t.json));
  const id = t.json.trip.id;
  assert.equal((await call('POST', '/api/trips', { cookie, body: { minutes: 30, graceMinutes: 5, contactIds: [c.id], consent: true } })).status, 409);
  const pts = await call('POST', `/api/trips/${id}/points`, { cookie, body: { points: [pos(49.05, 2.1), pos(49.051, 2.101), { lat: 999, lng: 0, accuracy: 1, measuredAt: Date.now() }] } });
  assert.equal(pts.json.accepted, 2);

  // Rappel 2 min avant l'échéance
  await db.query(`UPDATE trips SET started_at=now() - interval '28 minutes', deadline_at=now() + interval '2 minutes' WHERE id=$1`, [id]);
  await jobs.processTrips(); await drain();
  assert.match(lastMailTo('trip@exemple.fr').subject, /se termine/);
  // Échéance dépassée : délai de grâce
  await db.query(`UPDATE trips SET deadline_at=now() - interval '1 minute' WHERE id=$1`, [id]);
  await jobs.processTrips();
  assert.equal((await db.query('SELECT status FROM trips WHERE id=$1', [id])).rows[0].status, 'grace');
  // Grâce écoulée : alerte, une seule fois même si le worker repasse
  await db.query(`UPDATE trips SET deadline_at=now() - interval '6 minutes' WHERE id=$1`, [id]);
  await jobs.processTrips(); await jobs.processTrips();
  const alerts = (await db.query(`SELECT * FROM alerts WHERE trip_id=$1`, [id])).rows;
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].type, 'Arrivée non confirmée');
  const p = (await db.query('SELECT * FROM alert_positions WHERE alert_id=$1', [alerts[0].id])).rows[0];
  assert.equal(p.lat, 49.051, 'dernière position du trajet');
  await drain();
  assert.match(lastMailTo('sam@exemple.fr').subject, /ALERTE/);
  // Trop tard pour confirmer
  assert.equal((await call('POST', `/api/trips/${id}/finish`, { cookie, body: { kind: 'termine' } })).status, 409);
  // Les points reçus après l'alerte ne sont plus enregistrés
  assert.equal((await call('POST', `/api/trips/${id}/points`, { cookie, body: { points: [pos()] } })).json.accepted, 0);

  // R-08 : fin avant échéance
  const t2 = (await call('POST', '/api/trips', { cookie, body: { minutes: 30, graceMinutes: 5, contactIds: [c.id], consent: true } })).json.trip;
  assert.equal((await call('POST', `/api/trips/${t2.id}/finish`, { cookie, body: { kind: 'termine' } })).json.trip.status, 'termine');
  await db.query(`UPDATE trips SET deadline_at=now() - interval '1 hour' WHERE id=$1`, [t2.id]);
  await jobs.processTrips();
  assert.equal((await db.query('SELECT count(*)::int n FROM alerts WHERE trip_id=$1', [t2.id])).rows[0].n, 0);
});

test('R-12 isolation : un utilisateur n’accède pas aux données d’un autre ; CSRF bloqué', async () => {
  const a = await newUser('a@exemple.fr', 'A');
  const b = await newUser('b@exemple.fr', 'B');
  const alert = await call('POST', '/api/alerts', { cookie: a, headers: { 'idempotency-key': 'iso-' + 'y'.repeat(20) }, body: { position: pos() } });
  assert.equal((await call('GET', `/api/alerts/${alert.json.alert.id}`, { cookie: b })).status, 404);
  assert.equal((await call('POST', `/api/alerts/${alert.json.alert.id}/close`, { cookie: b })).status, 404);
  const csrf = await app.inject({ method: 'POST', url: '/api/alerts', headers: { origin: 'https://evil.example', cookie: a, 'idempotency-key': 'z'.repeat(20) }, payload: {} });
  assert.equal(csrf.statusCode, 403);
  assert.equal((await call('GET', '/api/alerts')).status, 401);
  assert.equal((await call('GET', '/api/public/alert/' + 'n'.repeat(43))).status, 404);
});

test('R-13 export et suppression du compte', async () => {
  const cookie = await newUser('rgpd@exemple.fr', 'R');
  await call('POST', '/api/alerts', { cookie, headers: { 'idempotency-key': 'rgpd-' + 'w'.repeat(20) }, body: { position: pos() } });
  const ex = await call('GET', '/api/me/export', { cookie });
  assert.equal(ex.json.alerts.length, 1);
  assert.equal(ex.json.account.email, 'rgpd@exemple.fr');
  assert.equal((await call('DELETE', '/api/me', { cookie, body: { password: 'faux' } })).status, 401);
  assert.equal((await call('DELETE', '/api/me', { cookie, body: { password: 'motdepasse-solide' } })).status, 200);
  assert.equal((await db.query(`SELECT count(*)::int n FROM users WHERE email='rgpd@exemple.fr'`)).rows[0].n, 0);
  assert.equal((await call('GET', '/api/me', { cookie })).status, 401);
});

test('Réinitialisation du mot de passe : invalide les anciennes sessions', async () => {
  const cookie = await newUser('pw@exemple.fr', 'P');
  await call('POST', '/api/auth/forgot', { body: { email: 'pw@exemple.fr' } });
  await drain();
  const token = linkIn(lastMailTo('pw@exemple.fr'), 'r');
  const r = await call('POST', '/api/auth/reset', { body: { token, password: 'nouveau-mot-de-passe' } });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/me', { cookie })).status, 401);
  assert.equal((await call('POST', '/api/auth/reset', { body: { token, password: 'encore-un-autre' } })).status, 400, 'lien à usage unique');
  assert.equal((await call('POST', '/api/auth/login', { body: { email: 'pw@exemple.fr', password: 'nouveau-mot-de-passe' } })).status, 200);
});

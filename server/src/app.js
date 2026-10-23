'use strict';
const path = require('path');
const fastify = require('fastify');
const argon2 = require('argon2');
const config = require('./config');
const db = require('./db');
const S = require('./services');
const { newToken, hashToken, newRef, HttpError, isEmail, cleanText, parsePosition } = require('./util');

const SESSION_COOKIE = 'sid';
const ALERT_TYPES = ['Urgence', 'Agression', 'Malaise', 'Accident', 'Je suis suivi(e)', 'Autre'];

function build() {
  const app = fastify({ logger: config.isProd ? { level: 'info' } : false, trustProxy: true, bodyLimit: 256 * 1024 });

  app.register(require('@fastify/cookie'));
  app.register(require('@fastify/rate-limit'), { global: false });
  app.register(require('@fastify/static'), { root: path.join(__dirname, '..', 'public'), prefix: '/', index: ['index.html'], wildcard: false });

  // Protection CSRF : les requêtes qui modifient des données doivent venir de notre propre origine.
  const allowedOrigin = new URL(config.publicUrl).origin;
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    const origin = req.headers.origin;
    if (origin && origin !== allowedOrigin) throw new HttpError(403, 'bad_origin', 'Origine non autorisée');
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'geolocation=(self), camera=(), microphone=()');
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.code, message: err.message });
    if (err.validation) return reply.code(400).send({ error: 'invalid', message: 'Données invalides : ' + err.message });
    if (err.statusCode === 429) return reply.code(429).send({ error: 'rate_limited', message: 'Trop de tentatives. Réessayez dans quelques minutes.' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
    req.log.error(err);
    return reply.code(500).send({ error: 'server', message: 'Erreur du serveur. Réessayez.' });
  });

  // ---------- Pages servies par l'app (le JS lit le jeton dans l'URL) ----------
  const page = file => (req, reply) => reply.header('Cache-Control', 'no-store').sendFile(file);
  for (const p of ['/a/:token', '/p/:token', '/i/:token']) app.get(p, page('contact.html'));
  for (const p of ['/v/:token', '/r/:token']) app.get(p, page('index.html'));
  // Supervision : 503 si la base ne répond pas ou si le worker (envois, échéances) est arrêté depuis plus de 2 min.
  app.get('/healthz', async (req, reply) => {
    await db.query('SELECT 1');
    let workerAge = null;
    try { const r = await db.query('SELECT extract(epoch FROM now()-at)::int AS age FROM worker_heartbeat WHERE id=1'); workerAge = r.rows[0] ? r.rows[0].age : null; } catch (_) { /* table absente */ }
    const queued = (await db.query(`SELECT count(*)::int n FROM notifications WHERE state='queued' AND next_attempt_at < now() - interval '2 minutes'`)).rows[0].n;
    const ok = workerAge !== null && workerAge < 120;
    reply.code(ok ? 200 : 503);
    return { ok, workerHeartbeatAgeS: workerAge, lateNotifications: queued };
  });

  // ---------- Session ----------
  async function currentUser(req) {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return null;
    const r = await db.query(
      `SELECT s.id AS session_id, s.last_seen_at, u.* FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at > now()`, [hashToken(raw)]);
    const u = r.rows[0];
    if (!u) return null;
    if (Date.now() - new Date(u.last_seen_at).getTime() > 3600000) {
      await db.query(`UPDATE sessions SET last_seen_at=now(), expires_at=now() + ($2 || ' days')::interval WHERE id=$1`, [u.session_id, String(config.sessionDays)]);
    }
    return u;
  }
  async function auth(req) {
    const u = await currentUser(req);
    if (!u) throw new HttpError(401, 'unauthenticated', 'Session expirée. Reconnectez-vous.');
    req.user = u;
  }
  function requireVerified(req) {
    if (!req.user.email_verified_at) throw new HttpError(403, 'unverified', 'Confirmez d’abord votre adresse e-mail (lien reçu par e-mail).');
  }
  async function openSession(reply, userId, ua) {
    const token = newToken();
    await db.query(`INSERT INTO sessions (user_id, token_hash, user_agent, expires_at) VALUES ($1,$2,$3, now() + ($4 || ' days')::interval)`,
      [userId, hashToken(token), cleanText(ua, 200), String(config.sessionDays)]);
    reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, secure: config.isProd, sameSite: 'lax', maxAge: config.sessionDays * 86400 });
  }
  async function sendEmailToken(client, user, purpose) {
    const token = newToken();
    const ttl = purpose === 'verify' ? `${config.verifyHours} hours` : `${config.resetMinutes} minutes`;
    await client.query(`INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at) VALUES ($1,$2,$3, now() + $4::interval)`, [hashToken(token), user.id, purpose, ttl]);
    const link = `${config.publicUrl}/${purpose === 'verify' ? 'v' : 'r'}/${token}`;
    await S.enqueue(client, { kind: purpose, channel: 'email', userId: user.id, address: user.email, payload: { link } });
  }
  function checkPassword(p) {
    if (typeof p !== 'string' || p.length < 10 || p.length > 200) throw new HttpError(400, 'weak_password', 'Le mot de passe doit faire au moins 10 caractères.');
  }
  const meDto = u => ({ id: u.id, email: u.email, name: u.display_name, emailVerified: !!u.email_verified_at, termsVersion: u.terms_version, termsAcceptedAt: u.terms_accepted_at, createdAt: u.created_at });

  const RL = (max, minutes) => ({ config: { rateLimit: { max, timeWindow: minutes * 60000 } } });

  app.get('/api/config', async () => ({ vapidPublicKey: config.push.publicKey || null, termsVersion: config.termsVersion, alertTypes: ALERT_TYPES }));

  app.post('/api/auth/register', RL(5, 60), async (req, reply) => {
    const { email, password, name, acceptTerms } = req.body || {};
    if (!isEmail(email)) throw new HttpError(400, 'bad_email', 'Adresse e-mail invalide.');
    const displayName = cleanText(name, 60);
    if (!displayName) throw new HttpError(400, 'bad_name', 'Indiquez votre prénom.');
    checkPassword(password);
    if (acceptTerms !== config.termsVersion) throw new HttpError(400, 'terms', 'Vous devez accepter les conditions d’utilisation.');
    const hash = await argon2.hash(password);
    const user = await db.tx(async c => {
      const ex = await c.query('SELECT id FROM users WHERE lower(email)=lower($1)', [email]);
      if (ex.rows.length) throw new HttpError(409, 'email_taken', 'Un compte existe déjà avec cette adresse. Connectez-vous ou réinitialisez le mot de passe.');
      const u = (await c.query(`INSERT INTO users (email, password_hash, display_name, terms_version, terms_accepted_at) VALUES ($1,$2,$3,$4, now()) RETURNING *`,
        [email.trim(), hash, displayName, config.termsVersion])).rows[0];
      await sendEmailToken(c, u, 'verify');
      await S.audit(c, u.id, 'utilisateur', 'compte.cree', `CGU v${config.termsVersion}`);
      return u;
    });
    await openSession(reply, user.id, req.headers['user-agent']);
    return { me: meDto(user) };
  });

  app.post('/api/auth/login', RL(10, 15), async (req, reply) => {
    const { email, password } = req.body || {};
    const u = isEmail(email) ? (await db.query('SELECT * FROM users WHERE lower(email)=lower($1)', [email])).rows[0] : null;
    // Vérification même si le compte n'existe pas : temps de réponse homogène
    const ok = u ? await argon2.verify(u.password_hash, String(password || '')) : (await argon2.hash('x'), false);
    if (!ok) throw new HttpError(401, 'bad_credentials', 'E-mail ou mot de passe incorrect.');
    await openSession(reply, u.id, req.headers['user-agent']);
    await S.audit(db.pool, u.id, 'utilisateur', 'session.ouverte');
    return { me: meDto(u) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const raw = req.cookies[SESSION_COOKIE];
    if (raw) await db.query('DELETE FROM sessions WHERE token_hash=$1', [hashToken(raw)]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/verify', RL(20, 15), async (req) => {
    const token = String((req.body || {}).token || '');
    return db.tx(async c => {
      const t = (await c.query(`SELECT * FROM email_tokens WHERE token_hash=$1 AND purpose='verify' FOR UPDATE`, [hashToken(token)])).rows[0];
      if (!t || t.used_at || new Date(t.expires_at) < new Date()) throw new HttpError(400, 'bad_token', 'Lien invalide ou expiré. Demandez un nouvel e-mail depuis l’application.');
      await c.query('UPDATE email_tokens SET used_at=now() WHERE token_hash=$1', [t.token_hash]);
      await c.query('UPDATE users SET email_verified_at=coalesce(email_verified_at, now()) WHERE id=$1', [t.user_id]);
      await S.audit(c, t.user_id, 'utilisateur', 'compte.email_verifie');
      return { ok: true };
    });
  });

  app.post('/api/auth/resend-verification', { preHandler: auth, ...RL(3, 60) }, async (req) => {
    if (req.user.email_verified_at) return { ok: true };
    await db.tx(c => sendEmailToken(c, req.user, 'verify'));
    return { ok: true };
  });

  app.post('/api/auth/forgot', RL(5, 60), async (req) => {
    const { email } = req.body || {};
    if (isEmail(email)) {
      const u = (await db.query('SELECT * FROM users WHERE lower(email)=lower($1)', [email])).rows[0];
      if (u) await db.tx(c => sendEmailToken(c, u, 'reset'));
    }
    return { ok: true }; // même réponse que le compte existe ou non
  });

  app.post('/api/auth/reset', RL(10, 15), async (req, reply) => {
    const { token, password } = req.body || {};
    checkPassword(password);
    const hash = await argon2.hash(password);
    const userId = await db.tx(async c => {
      const t = (await c.query(`SELECT * FROM email_tokens WHERE token_hash=$1 AND purpose='reset' FOR UPDATE`, [hashToken(String(token || ''))])).rows[0];
      if (!t || t.used_at || new Date(t.expires_at) < new Date()) throw new HttpError(400, 'bad_token', 'Lien invalide ou expiré. Refaites une demande.');
      await c.query('UPDATE email_tokens SET used_at=now() WHERE token_hash=$1', [t.token_hash]);
      // Un lien de réinitialisation reçu par e-mail prouve aussi la possession de l'adresse
      await c.query('UPDATE users SET password_hash=$2, email_verified_at=coalesce(email_verified_at, now()) WHERE id=$1', [t.user_id, hash]);
      await c.query('DELETE FROM sessions WHERE user_id=$1', [t.user_id]); // invalide toutes les sessions
      await S.audit(c, t.user_id, 'utilisateur', 'compte.mot_de_passe_reinitialise');
      return t.user_id;
    });
    await openSession(reply, userId, req.headers['user-agent']);
    return { ok: true };
  });

  // ---------- Compte ----------
  app.get('/api/me', { preHandler: auth }, async req => ({ me: meDto(req.user) }));

  app.patch('/api/me', { preHandler: auth }, async req => {
    const name = cleanText((req.body || {}).name, 60);
    if (!name) throw new HttpError(400, 'bad_name', 'Le nom ne peut pas être vide.');
    await db.query('UPDATE users SET display_name=$2 WHERE id=$1', [req.user.id, name]);
    await S.audit(db.pool, req.user.id, 'utilisateur', 'profil.modifie');
    return { ok: true };
  });

  app.delete('/api/me', { preHandler: auth, ...RL(5, 60) }, async (req, reply) => {
    const ok = await argon2.verify(req.user.password_hash, String((req.body || {}).password || ''));
    if (!ok) throw new HttpError(401, 'bad_credentials', 'Mot de passe incorrect.');
    // La suppression en cascade efface contacts, alertes, trajets, points, partages, sessions et journaux.
    await db.query('DELETE FROM users WHERE id=$1', [req.user.id]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me/export', { preHandler: auth, ...RL(5, 60) }, async req => {
    const id = req.user.id;
    const q = (sql) => db.query(sql, [id]).then(r => r.rows);
    await S.audit(db.pool, id, 'utilisateur', 'rgpd.export');
    return {
      format: 'sosalert-export-v1', exportedAt: new Date().toISOString(),
      account: meDto(req.user),
      contacts: await q('SELECT id, name, email, status, receives_alerts, invited_at, accepted_at, ended_at FROM contacts WHERE owner_id=$1'),
      alerts: await q(`SELECT a.id, a.ref, a.type, a.comment, a.origin, a.status, a.created_at, a.closed_at,
        (SELECT json_agg(json_build_object('lat',p.lat,'lng',p.lng,'accuracy',p.accuracy,'measured_at',p.measured_at)) FROM alert_positions p WHERE p.alert_id=a.id) AS positions,
        (SELECT json_agg(json_build_object('contact',r.contact_name,'first_viewed_at',r.first_viewed_at,'acked_at',r.acked_at)) FROM alert_recipients r WHERE r.alert_id=a.id) AS recipients
        FROM alerts a WHERE a.user_id=$1 ORDER BY a.created_at DESC`),
      trips: await q(`SELECT t.id, t.ref, t.label, t.status, t.started_at, t.deadline_at, t.grace_seconds, t.ended_at,
        (SELECT json_agg(json_build_object('lat',p.lat,'lng',p.lng,'accuracy',p.accuracy,'measured_at',p.measured_at) ORDER BY p.measured_at) FROM location_points p WHERE p.trip_id=t.id) AS points
        FROM trips t WHERE t.user_id=$1 ORDER BY t.started_at DESC`),
      shares: await q('SELECT id, contact_id, lat, lng, accuracy, measured_at, created_at, expires_at, revoked_at FROM shares WHERE user_id=$1'),
      devices: await q('SELECT id, created_at, last_ok_at FROM push_subscriptions WHERE user_id=$1'),
      activity: await q('SELECT actor, action, ref, at FROM audit_logs WHERE user_id=$1 ORDER BY at DESC'),
    };
  });

  app.get('/api/me/activity', { preHandler: auth }, async req =>
    ({ activity: (await db.query('SELECT actor, action, ref, at FROM audit_logs WHERE user_id=$1 ORDER BY at DESC LIMIT 100', [req.user.id])).rows }));

  function parseSub(body) {
    const s = body && body.subscription;
    if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || s.endpoint.length > 1000 || !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') {
      throw new HttpError(400, 'bad_subscription', 'Abonnement aux notifications invalide.');
    }
    return { endpoint: s.endpoint, p256dh: s.keys.p256dh.slice(0, 200), auth: s.keys.auth.slice(0, 100) };
  }

  app.post('/api/me/push', { preHandler: auth }, async req => {
    const s = parseSub(req.body);
    await db.query(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)
      ON CONFLICT (user_id, endpoint) WHERE user_id IS NOT NULL DO UPDATE SET p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth`, [req.user.id, s.endpoint, s.p256dh, s.auth]);
    await S.audit(db.pool, req.user.id, 'utilisateur', 'appareil.notifications_activees');
    return { ok: true };
  });

  // ---------- Contacts ----------
  const contactDto = c => ({ id: c.id, name: c.name, email: c.email, status: (c.status === 'pending' && new Date(c.invite_expires_at) < new Date()) ? 'expired' : c.status,
    receivesAlerts: c.receives_alerts, invitedAt: c.invited_at, inviteExpiresAt: c.invite_expires_at, acceptedAt: c.accepted_at, endedAt: c.ended_at, pushDevices: Number(c.push_devices || 0) });

  app.get('/api/contacts', { preHandler: auth }, async req => {
    const r = await db.query(`SELECT c.*, (SELECT count(*) FROM push_subscriptions p WHERE p.contact_id=c.id) AS push_devices
      FROM contacts c WHERE owner_id=$1 ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, name`, [req.user.id]);
    return { contacts: r.rows.map(contactDto) };
  });

  async function sendInvite(c, contact, owner) {
    const token = newToken();
    await c.query(`UPDATE contacts SET invite_token_hash=$2, invite_expires_at=now() + ($3 || ' hours')::interval, invited_at=now() WHERE id=$1`,
      [contact.id, hashToken(token), String(config.inviteHours)]);
    await S.enqueue(c, { kind: 'invite', channel: 'email', contactId: contact.id, userId: owner.id, address: contact.email, payload: { link: `${config.publicUrl}/i/${token}` } });
  }

  app.post('/api/contacts', { preHandler: auth, ...RL(20, 60) }, async req => {
    requireVerified(req);
    const name = cleanText((req.body || {}).name, 60);
    const email = String((req.body || {}).email || '').trim();
    if (!name) throw new HttpError(400, 'bad_name', 'Indiquez le nom du contact.');
    if (!isEmail(email)) throw new HttpError(400, 'bad_email', 'Adresse e-mail invalide.');
    if (email.toLowerCase() === req.user.email.toLowerCase()) throw new HttpError(400, 'self', 'Vous ne pouvez pas vous inviter vous-même.');
    const count = (await db.query(`SELECT count(*)::int n FROM contacts WHERE owner_id=$1 AND status IN ('pending','active')`, [req.user.id])).rows[0].n;
    if (count >= 10) throw new HttpError(400, 'too_many', 'Maximum 10 contacts.');
    const contact = await db.tx(async c => {
      let row;
      try {
        row = (await c.query(`INSERT INTO contacts (owner_id, name, email) VALUES ($1,$2,$3) RETURNING *`, [req.user.id, name, email])).rows[0];
      } catch (e) {
        if (e.code === '23505') throw new HttpError(409, 'duplicate', 'Ce contact est déjà invité ou actif.');
        throw e;
      }
      await sendInvite(c, row, req.user);
      await S.audit(c, req.user.id, 'utilisateur', 'contact.invite', name);
      return row;
    });
    return { contact: contactDto((await db.query('SELECT * FROM contacts WHERE id=$1', [contact.id])).rows[0]) };
  });

  async function ownContact(req) {
    const c = (await db.query('SELECT * FROM contacts WHERE id=$1 AND owner_id=$2', [req.params.id, req.user.id])).rows[0];
    if (!c) throw new HttpError(404, 'not_found', 'Contact introuvable.');
    return c;
  }
  const uuidParam = { schema: { params: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } }, required: ['id'] } } };

  app.post('/api/contacts/:id/resend', { preHandler: auth, ...uuidParam, ...RL(10, 60) }, async req => {
    requireVerified(req);
    const c = await ownContact(req);
    if (c.status !== 'pending') throw new HttpError(400, 'not_pending', 'Seule une invitation en attente peut être renvoyée.');
    await db.tx(async t => { await sendInvite(t, c, req.user); await S.audit(t, req.user.id, 'utilisateur', 'contact.invitation_renvoyee', c.name); });
    return { ok: true };
  });

  app.patch('/api/contacts/:id', { preHandler: auth, ...uuidParam }, async req => {
    const c = await ownContact(req);
    const v = (req.body || {}).receivesAlerts;
    if (typeof v !== 'boolean') throw new HttpError(400, 'invalid', 'Valeur attendue : vrai ou faux.');
    await db.query('UPDATE contacts SET receives_alerts=$2 WHERE id=$1', [c.id, v]);
    await S.audit(db.pool, req.user.id, 'utilisateur', 'contact.permission', `${c.name} reçoit_alertes=${v}`);
    return { ok: true };
  });

  // Retrait : effet immédiat côté serveur (F-013)
  app.delete('/api/contacts/:id', { preHandler: auth, ...uuidParam }, async req => {
    const c = await ownContact(req);
    await db.tx(async t => {
      if (c.status === 'pending' || c.status === 'active') {
        await t.query(`UPDATE contacts SET status='removed', ended_at=now(), invite_token_hash=NULL WHERE id=$1`, [c.id]);
      } else {
        await t.query('DELETE FROM contacts WHERE id=$1', [c.id]);
      }
      await t.query('UPDATE shares SET revoked_at=now() WHERE contact_id=$1 AND revoked_at IS NULL', [c.id]);
      await t.query(`DELETE FROM trip_contacts WHERE contact_id=$1 AND trip_id IN (SELECT id FROM trips WHERE status IN ('actif','grace'))`, [c.id]);
      await t.query('DELETE FROM push_subscriptions WHERE contact_id=$1', [c.id]);
      await S.audit(t, req.user.id, 'utilisateur', 'contact.retire', c.name);
    });
    return { ok: true };
  });

  // ---------- Alertes ----------
  async function alertDetail(alertId, userId) {
    const a = (await db.query('SELECT * FROM alerts WHERE id=$1 AND user_id=$2', [alertId, userId])).rows[0];
    if (!a) return null;
    const pos = (await db.query('SELECT lat, lng, accuracy, measured_at, stale FROM alert_positions WHERE alert_id=$1 ORDER BY measured_at DESC LIMIT 1', [a.id])).rows[0] || null;
    const recips = (await db.query('SELECT id, contact_name, first_viewed_at, acked_at FROM alert_recipients WHERE alert_id=$1 ORDER BY contact_name', [a.id])).rows;
    const notifs = (await db.query(`SELECT recipient_id, channel, state, attempts, provider_id, last_error, sent_at FROM notifications WHERE alert_id=$1 AND kind='alert' ORDER BY created_at`, [a.id])).rows;
    return {
      id: a.id, ref: a.ref, type: a.type, comment: a.comment, origin: a.origin, status: a.status, createdAt: a.created_at, closedAt: a.closed_at, position: pos,
      recipients: recips.map(r => ({ id: r.id, name: r.contact_name, firstViewedAt: r.first_viewed_at, ackedAt: r.acked_at,
        deliveries: notifs.filter(n => n.recipient_id === r.id).map(n => ({ channel: n.channel, state: n.state, attempts: n.attempts, providerId: n.provider_id, error: n.last_error, sentAt: n.sent_at })) })),
    };
  }

  app.get('/api/alerts', { preHandler: auth }, async req => {
    const r = await db.query(`SELECT a.id, a.ref, a.type, a.origin, a.status, a.created_at, a.closed_at,
      (SELECT count(*) FROM alert_recipients r WHERE r.alert_id=a.id)::int AS recipients
      FROM alerts a WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.user.id]);
    return { alerts: r.rows.map(a => ({ id: a.id, ref: a.ref, type: a.type, origin: a.origin, status: a.status, createdAt: a.created_at, closedAt: a.closed_at, recipients: a.recipients })) };
  });

  app.post('/api/alerts', { preHandler: auth, ...RL(20, 10) }, async (req, reply) => {
    const key = String(req.headers['idempotency-key'] || '');
    if (!/^[A-Za-z0-9_-]{16,80}$/.test(key)) throw new HttpError(400, 'idempotency', 'En-tête Idempotency-Key manquant ou invalide.');
    const b = req.body || {};
    const type = ALERT_TYPES.includes(b.type) ? b.type : 'Urgence';
    const pos = parsePosition(b.position);
    const { alert, created } = await db.tx(c => S.createAlert(c, { userId: req.user.id, idemKey: key, type, comment: cleanText(b.comment, 500), origin: 'sos', pos }));
    reply.code(created ? 201 : 200);
    return { alert: await alertDetail(alert.id, req.user.id), created };
  });

  app.get('/api/alerts/:id', { preHandler: auth, ...uuidParam }, async req => {
    const d = await alertDetail(req.params.id, req.user.id);
    if (!d) throw new HttpError(404, 'not_found', 'Alerte introuvable.');
    return { alert: d };
  });

  app.post('/api/alerts/:id/positions', { preHandler: auth, ...uuidParam, ...RL(120, 10) }, async req => {
    const a = (await db.query('SELECT id, status FROM alerts WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])).rows[0];
    if (!a) throw new HttpError(404, 'not_found', 'Alerte introuvable.');
    if (a.status === 'cloturee') throw new HttpError(409, 'closed', 'Alerte clôturée : la position n’est plus partagée.');
    const p = parsePosition((req.body || {}).position);
    if (!p) throw new HttpError(400, 'bad_position', 'Position manquante.');
    await db.query('INSERT INTO alert_positions (alert_id, lat, lng, accuracy, measured_at) VALUES ($1,$2,$3,$4,$5)', [a.id, p.lat, p.lng, p.accuracy, p.measuredAt]);
    return { ok: true };
  });

  app.post('/api/alerts/:id/close', { preHandler: auth, ...uuidParam }, async req => {
    const a = (await db.query('SELECT * FROM alerts WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])).rows[0];
    if (!a) throw new HttpError(404, 'not_found', 'Alerte introuvable.');
    await db.tx(c => S.closeAlert(c, a, 'utilisateur'));
    return { alert: await alertDetail(a.id, req.user.id) };
  });

  // ---------- Trajets ----------
  async function tripDto(t) {
    const contacts = (await db.query('SELECT c.id, c.name FROM trip_contacts tc JOIN contacts c ON c.id=tc.contact_id WHERE tc.trip_id=$1', [t.id])).rows;
    const pts = (await db.query('SELECT lat, lng, accuracy, measured_at FROM location_points WHERE trip_id=$1 ORDER BY measured_at', [t.id])).rows;
    return { id: t.id, ref: t.ref, label: t.label, status: t.status, startedAt: t.started_at, deadlineAt: t.deadline_at, graceSeconds: t.grace_seconds,
      expectedIntervalS: t.expected_interval_s, remindedAt: t.reminded_at, endedAt: t.ended_at, alertId: t.alert_id, contacts,
      points: pts.map(p => ({ lat: p.lat, lng: p.lng, accuracy: p.accuracy, t: new Date(p.measured_at).getTime() })), serverNow: Date.now() };
  }
  async function ownTrip(req, lock) {
    const t = (await db.query('SELECT * FROM trips WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id])).rows[0];
    if (!t) throw new HttpError(404, 'not_found', 'Trajet introuvable.');
    return t;
  }

  app.get('/api/trips', { preHandler: auth }, async req => {
    const active = (await db.query(`SELECT * FROM trips WHERE user_id=$1 AND status IN ('actif','grace')`, [req.user.id])).rows[0];
    const recent = (await db.query(`SELECT id, ref, label, status, started_at, ended_at, alert_id, (SELECT count(*) FROM location_points p WHERE p.trip_id=t.id)::int AS points
      FROM trips t WHERE user_id=$1 AND status NOT IN ('actif','grace') ORDER BY started_at DESC LIMIT 10`, [req.user.id])).rows;
    return { active: active ? await tripDto(active) : null,
      recent: recent.map(t => ({ id: t.id, ref: t.ref, label: t.label, status: t.status, startedAt: t.started_at, endedAt: t.ended_at, alertId: t.alert_id, points: t.points })), serverNow: Date.now() };
  });

  app.post('/api/trips', { preHandler: auth, ...RL(20, 60) }, async req => {
    requireVerified(req);
    const b = req.body || {};
    const minutes = Number(b.minutes), grace = Number(b.graceMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720) throw new HttpError(400, 'bad_duration', 'Durée entre 1 minute et 12 heures.');
    if (!Number.isInteger(grace) || grace < 1 || grace > 60) throw new HttpError(400, 'bad_grace', 'Délai de grâce entre 1 et 60 minutes.');
    if (b.consent !== true) throw new HttpError(400, 'consent', 'La collecte de position pendant le trajet doit être acceptée.');
    const ids = Array.isArray(b.contactIds) ? b.contactIds.filter(x => typeof x === 'string').slice(0, 10) : [];
    const valid = (await db.query(`SELECT id FROM contacts WHERE owner_id=$1 AND status='active' AND receives_alerts AND id::text = ANY($2::text[])`, [req.user.id, ids])).rows.map(r => r.id);
    if (!valid.length) throw new HttpError(400, 'no_contacts', 'Choisissez au moins un contact actif.');
    const t = await db.tx(async c => {
      let row;
      try {
        row = (await c.query(`INSERT INTO trips (ref, user_id, label, deadline_at, grace_seconds) VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval, $5) RETURNING *`,
          [newRef('T'), req.user.id, cleanText(b.label, 120), String(minutes), grace * 60])).rows[0];
      } catch (e) {
        if (e.code === '23505') throw new HttpError(409, 'active_trip', 'Un trajet est déjà en cours.');
        throw e;
      }
      for (const id of valid) await c.query('INSERT INTO trip_contacts (trip_id, contact_id) VALUES ($1,$2)', [row.id, id]);
      await S.audit(c, req.user.id, 'utilisateur', 'trajet.demarre', `${row.ref} ${minutes} min + ${grace} min`);
      return row;
    });
    return { trip: await tripDto(t) };
  });

  app.post('/api/trips/:id/points', { preHandler: auth, ...uuidParam, ...RL(240, 10) }, async req => {
    const t = await ownTrip(req);
    if (!['actif', 'grace'].includes(t.status)) return { accepted: 0, status: t.status }; // collecte arrêtée : on n'enregistre plus rien
    const list = Array.isArray((req.body || {}).points) ? req.body.points.slice(0, 200) : [];
    let n = 0;
    for (const raw of list) {
      let p; try { p = parsePosition(raw, { maxAgeMs: 12 * 3600 * 1000 }); } catch (_) { continue; }
      if (!p || p.measuredAt < new Date(t.started_at).getTime() - 60000) continue;
      await db.query('INSERT INTO location_points (trip_id, lat, lng, accuracy, measured_at) VALUES ($1,$2,$3,$4,$5)', [t.id, p.lat, p.lng, p.accuracy, p.measuredAt]);
      n++;
    }
    return { accepted: n, status: t.status };
  });

  app.post('/api/trips/:id/extend', { preHandler: auth, ...uuidParam }, async req => {
    const minutes = Number((req.body || {}).minutes);
    if (![5, 10, 15, 30, 60].includes(minutes)) throw new HttpError(400, 'bad_duration', 'Prolongation possible : 5, 10, 15, 30 ou 60 minutes.');
    const t = await db.tx(async c => {
      const row = (await c.query(`SELECT * FROM trips WHERE id=$1 AND user_id=$2 FOR UPDATE`, [req.params.id, req.user.id])).rows[0];
      if (!row) throw new HttpError(404, 'not_found', 'Trajet introuvable.');
      if (!['actif', 'grace'].includes(row.status)) throw new HttpError(409, 'ended', 'Ce trajet est terminé.');
      const up = (await c.query(`UPDATE trips SET deadline_at=greatest(deadline_at, now()) + ($2 || ' minutes')::interval, status='actif', reminded_at=NULL WHERE id=$1 RETURNING *`, [row.id, String(minutes)])).rows[0];
      await S.audit(c, req.user.id, 'utilisateur', 'trajet.prolonge', `${row.ref} +${minutes} min`);
      return up;
    });
    return { trip: await tripDto(t) };
  });

  app.post('/api/trips/:id/finish', { preHandler: auth, ...uuidParam }, async req => {
    const kind = (req.body || {}).kind === 'arrete' ? 'arrete' : 'termine';
    const t = await db.tx(async c => {
      const row = (await c.query(`SELECT * FROM trips WHERE id=$1 AND user_id=$2 FOR UPDATE`, [req.params.id, req.user.id])).rows[0];
      if (!row) throw new HttpError(404, 'not_found', 'Trajet introuvable.');
      if (!['actif', 'grace'].includes(row.status)) throw new HttpError(409, 'ended', row.status === 'alerte' ? 'Trop tard : l’alerte est déjà partie. Clôturez-la pour rassurer vos contacts.' : 'Ce trajet est déjà terminé.');
      const up = (await c.query(`UPDATE trips SET status=$2, ended_at=now() WHERE id=$1 RETURNING *`, [row.id, kind])).rows[0];
      await S.audit(c, req.user.id, 'utilisateur', kind === 'termine' ? 'trajet.arrivee_confirmee' : 'trajet.arrete', row.ref);
      return up;
    });
    return { trip: await tripDto(t) };
  });

  // ---------- Partage ponctuel ----------
  app.get('/api/shares', { preHandler: auth }, async req => {
    const r = await db.query(`SELECT s.id, s.contact_id, c.name AS contact_name, s.created_at, s.expires_at, s.revoked_at FROM shares s LEFT JOIN contacts c ON c.id=s.contact_id
      WHERE s.user_id=$1 ORDER BY s.created_at DESC LIMIT 30`, [req.user.id]);
    return { shares: r.rows.map(s => ({ id: s.id, contactId: s.contact_id, contactName: s.contact_name, createdAt: s.created_at, expiresAt: s.expires_at, revokedAt: s.revoked_at })) };
  });

  app.post('/api/shares', { preHandler: auth, ...RL(30, 60) }, async req => {
    requireVerified(req);
    const b = req.body || {};
    const minutes = Number(b.minutes);
    if (![15, 60, 240].includes(minutes)) throw new HttpError(400, 'bad_duration', 'Durée possible : 15 min, 1 h ou 4 h.');
    const pos = parsePosition(b.position);
    if (!pos) throw new HttpError(400, 'bad_position', 'Position manquante.');
    const c = (await db.query(`SELECT * FROM contacts WHERE id::text=$1 AND owner_id=$2 AND status='active'`, [String(b.contactId || ''), req.user.id])).rows[0];
    if (!c) throw new HttpError(400, 'bad_contact', 'Contact actif introuvable.');
    const token = newToken();
    const s = (await db.query(`INSERT INTO shares (user_id, contact_id, token_hash, lat, lng, accuracy, measured_at, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7, now() + ($8 || ' minutes')::interval) RETURNING *`,
      [req.user.id, c.id, hashToken(token), pos.lat, pos.lng, pos.accuracy, pos.measuredAt, String(minutes)])).rows[0];
    await S.audit(db.pool, req.user.id, 'utilisateur', 'partage.cree', `${c.name} ${minutes} min`);
    // Le lien est renvoyé une seule fois : seul son hash est conservé.
    return { share: { id: s.id, contactId: c.id, contactName: c.name, expiresAt: s.expires_at, url: `${config.publicUrl}/p/${token}` } };
  });

  app.delete('/api/shares/:id', { preHandler: auth, ...uuidParam }, async req => {
    const r = await db.query('UPDATE shares SET revoked_at=coalesce(revoked_at, now()) WHERE id=$1 AND user_id=$2 RETURNING id', [req.params.id, req.user.id]);
    if (!r.rows.length) throw new HttpError(404, 'not_found', 'Partage introuvable.');
    await S.audit(db.pool, req.user.id, 'utilisateur', 'partage.revoque');
    return { ok: true };
  });

  // ---------- Pages publiques des contacts (sans compte, accès par jeton) ----------
  const tokenParam = { schema: { params: { type: 'object', properties: { token: { type: 'string', minLength: 20, maxLength: 100 } }, required: ['token'] } } };
  const PUB = { ...tokenParam, ...RL(60, 10) };

  async function inviteByToken(token) {
    return (await db.query(`SELECT c.*, u.display_name FROM contacts c JOIN users u ON u.id=c.owner_id WHERE c.invite_token_hash=$1`, [hashToken(token)])).rows[0];
  }
  app.get('/api/public/invite/:token', PUB, async req => {
    const c = await inviteByToken(req.params.token);
    if (!c || new Date(c.invite_expires_at) < new Date()) throw new HttpError(404, 'invalid', 'Invitation invalide ou expirée. Demandez à la personne de vous la renvoyer.');
    return { ownerName: c.display_name, contactName: c.name, status: c.status };
  });
  app.post('/api/public/invite/:token/:answer', { ...PUB, schema: { params: { type: 'object', properties: { token: { type: 'string', minLength: 20, maxLength: 100 }, answer: { type: 'string', enum: ['accept', 'refuse', 'optout'] } }, required: ['token', 'answer'] } } }, async req => {
    const c = await inviteByToken(req.params.token);
    if (!c || new Date(c.invite_expires_at) < new Date()) throw new HttpError(404, 'invalid', 'Invitation invalide ou expirée.');
    const ans = req.params.answer;
    if (ans === 'accept' && c.status === 'pending') {
      await db.query(`UPDATE contacts SET status='active', accepted_at=now() WHERE id=$1`, [c.id]);
      await S.audit(db.pool, c.owner_id, 'contact', 'contact.accepte', c.name);
    } else if ((ans === 'refuse' && c.status === 'pending') || (ans === 'optout' && c.status === 'active')) {
      await db.tx(async t => {
        await t.query(`UPDATE contacts SET status=$2, ended_at=now(), invite_token_hash=NULL WHERE id=$1`, [c.id, ans === 'refuse' ? 'refused' : 'removed']);
        await t.query('DELETE FROM push_subscriptions WHERE contact_id=$1', [c.id]);
        await t.query('UPDATE shares SET revoked_at=now() WHERE contact_id=$1 AND revoked_at IS NULL', [c.id]);
        await S.audit(t, c.owner_id, 'contact', ans === 'refuse' ? 'contact.refuse' : 'contact.desinscrit', c.name);
      });
    }
    return { status: (await db.query('SELECT status FROM contacts WHERE id=$1', [c.id])).rows[0].status };
  });
  app.post('/api/public/invite/:token/push', PUB, async req => {
    const c = await inviteByToken(req.params.token);
    if (!c || c.status !== 'active') throw new HttpError(404, 'invalid', 'Invitation invalide ou non acceptée.');
    const s = parseSub(req.body);
    await db.query(`INSERT INTO push_subscriptions (contact_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)
      ON CONFLICT (contact_id, endpoint) WHERE contact_id IS NOT NULL DO UPDATE SET p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth`, [c.id, s.endpoint, s.p256dh, s.auth]);
    await S.audit(db.pool, c.owner_id, 'contact', 'contact.notifications_activees', c.name);
    return { ok: true };
  });

  async function recipientByToken(token) {
    const r = (await db.query(`SELECT r.*, a.ref, a.type, a.comment, a.status, a.created_at, a.closed_at, a.user_id, a.origin, u.display_name
      FROM alert_recipients r JOIN alerts a ON a.id=r.alert_id JOIN users u ON u.id=a.user_id WHERE r.view_token_hash=$1`, [hashToken(token)])).rows[0];
    if (!r) return null;
    if (r.closed_at && Date.now() - new Date(r.closed_at).getTime() > config.alertLinkHoursAfterClose * 3600000) return null;
    return r;
  }
  app.get('/api/public/alert/:token', PUB, async req => {
    const r = await recipientByToken(req.params.token);
    if (!r) throw new HttpError(404, 'invalid', 'Lien invalide ou expiré.');
    if (!r.first_viewed_at) {
      await db.query('UPDATE alert_recipients SET first_viewed_at=now() WHERE id=$1', [r.id]);
      await S.audit(db.pool, r.user_id, 'contact', 'alerte.consultee', `${r.ref} ${r.contact_name}`);
    }
    const positions = (await db.query('SELECT lat, lng, accuracy, measured_at, stale FROM alert_positions WHERE alert_id=$1 ORDER BY measured_at DESC LIMIT 20', [r.alert_id])).rows;
    return { ownerName: r.display_name, ref: r.ref, type: r.type, comment: r.comment, origin: r.origin, status: r.status, createdAt: r.created_at, closedAt: r.closed_at,
      ackedAt: r.acked_at, contactName: r.contact_name, positions, serverNow: Date.now(), canSubscribe: !!r.contact_id && r.status !== 'cloturee' };
  });
  app.post('/api/public/alert/:token/ack', PUB, async req => {
    const r = await recipientByToken(req.params.token);
    if (!r) throw new HttpError(404, 'invalid', 'Lien invalide ou expiré.');
    if (!r.acked_at) {
      await db.tx(async c => {
        await c.query('UPDATE alert_recipients SET acked_at=now() WHERE id=$1', [r.id]);
        await S.audit(c, r.user_id, 'contact', 'alerte.accusee', `${r.ref} ${r.contact_name}`);
        await S.recomputeAlertStatus(c, r.alert_id);
      });
    }
    return { ok: true };
  });
  app.post('/api/public/alert/:token/push', PUB, async req => {
    const r = await recipientByToken(req.params.token);
    if (!r || !r.contact_id) throw new HttpError(404, 'invalid', 'Lien invalide ou expiré.');
    const s = parseSub(req.body);
    await db.query(`INSERT INTO push_subscriptions (contact_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)
      ON CONFLICT (contact_id, endpoint) WHERE contact_id IS NOT NULL DO UPDATE SET p256dh=EXCLUDED.p256dh, auth=EXCLUDED.auth`, [r.contact_id, s.endpoint, s.p256dh, s.auth]);
    return { ok: true };
  });
  app.post('/api/public/alert/:token/optout', PUB, async req => {
    const r = await recipientByToken(req.params.token);
    if (!r || !r.contact_id) throw new HttpError(404, 'invalid', 'Lien invalide ou expiré.');
    await db.tx(async t => {
      await t.query(`UPDATE contacts SET status='removed', ended_at=now(), invite_token_hash=NULL WHERE id=$1 AND status='active'`, [r.contact_id]);
      await t.query('DELETE FROM push_subscriptions WHERE contact_id=$1', [r.contact_id]);
      await t.query('UPDATE shares SET revoked_at=now() WHERE contact_id=$1 AND revoked_at IS NULL', [r.contact_id]);
      await S.audit(t, r.user_id, 'contact', 'contact.desinscrit', r.contact_name);
    });
    return { ok: true };
  });

  app.get('/api/public/share/:token', PUB, async req => {
    const s = (await db.query(`SELECT s.*, u.display_name FROM shares s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1`, [hashToken(req.params.token)])).rows[0];
    if (!s || s.revoked_at || new Date(s.expires_at) < new Date()) throw new HttpError(404, 'invalid', 'Ce partage a expiré ou a été révoqué.');
    return { ownerName: s.display_name, position: { lat: s.lat, lng: s.lng, accuracy: s.accuracy, measured_at: s.measured_at }, expiresAt: s.expires_at, serverNow: Date.now() };
  });

  return app;
}

module.exports = { build };

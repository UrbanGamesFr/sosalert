'use strict';
// Traitements du worker : file d'envoi, échéances de trajet, rétention.
// Chaque fonction est sûre en exécution concurrente (FOR UPDATE SKIP LOCKED).
const config = require('./config');
const db = require('./db');
const mailer = require('./mailer');
const push = require('./push');
const T = require('./templates');
const S = require('./services');

const MAX_ATTEMPTS = 5;
const backoffMs = attempts => Math.min(600000, 10000 * Math.pow(2, attempts - 1)); // 10 s, 20 s, 40 s, 80 s...

async function render(n) {
  const q = (sql, p) => db.query(sql, p).then(r => r.rows[0]);
  switch (n.kind) {
    case 'verify':
    case 'reset': {
      const u = await q('SELECT display_name FROM users WHERE id=$1', [n.user_id]);
      return u && T[n.kind]({ name: u.display_name, link: n.payload.link });
    }
    case 'invite': {
      const c = await q('SELECT c.name, u.display_name FROM contacts c JOIN users u ON u.id=c.owner_id WHERE c.id=$1', [n.contact_id]);
      return c && T.invite({ ownerName: c.display_name, contactName: c.name, link: n.payload.link });
    }
    case 'alert':
    case 'alert_closed': {
      const a = await q('SELECT a.*, u.display_name FROM alerts a JOIN users u ON u.id=a.user_id WHERE a.id=$1', [n.alert_id]);
      if (!a) return null;
      if (n.kind === 'alert') {
        const pos = await q('SELECT * FROM alert_positions WHERE alert_id=$1 ORDER BY measured_at DESC LIMIT 1', [a.id]);
        return T.alert({ ownerName: a.display_name, alert: a, pos, link: n.payload.link });
      }
      return T.alertClosed({ ownerName: a.display_name, alert: a });
    }
    case 'trip_reminder':
    case 'trip_deadline': {
      const t = await q('SELECT t.*, u.display_name FROM trips t JOIN users u ON u.id=t.user_id WHERE t.id=$1', [n.payload.tripId]);
      if (!t) return null;
      const fn = n.kind === 'trip_reminder' ? T.tripReminder : T.tripDeadline;
      return fn({ name: t.display_name, trip: t, link: `${config.publicUrl}/#trajet` });
    }
    default: return null;
  }
}

async function processNotifications(limit = 20) {
  await db.query(`UPDATE notifications SET state='queued' WHERE state='sending' AND locked_at < now() - interval '2 minutes'`);
  const claimed = (await db.query(
    `UPDATE notifications SET state='sending', attempts=attempts+1, locked_at=now()
     WHERE id IN (SELECT id FROM notifications WHERE state='queued' AND next_attempt_at<=now()
                  ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED)
     RETURNING *`, [limit])).rows;

  for (const n of claimed) {
    try {
      const msg = await render(n);
      if (!msg) throw Object.assign(new Error('Contexte introuvable (supprimé ?)'), { final: true });
      let res;
      if (n.channel === 'email') {
        res = await mailer.send({ to: n.address, subject: msg.subject, text: msg.text, html: msg.html });
      } else {
        const sub = (await db.query('SELECT * FROM push_subscriptions WHERE id=$1', [n.push_sub_id])).rows[0];
        if (!sub) throw Object.assign(new Error('Abonnement push supprimé'), { final: true });
        if (!msg.push) throw Object.assign(new Error('Pas de version push pour ce message'), { final: true });
        const { urgent, ...payload } = msg.push;
        res = await push.send(sub, payload, { urgent: !!urgent });
        await db.query('UPDATE push_subscriptions SET last_ok_at=now() WHERE id=$1', [sub.id]);
      }
      // Envoyé : on purge le contenu (jeton du lien) qui n'a plus à être conservé.
      await db.query(`UPDATE notifications SET state='sent', sent_at=now(), provider_id=$2, last_error=NULL, payload='{}'::jsonb WHERE id=$1`,
        [n.id, res && res.providerId ? String(res.providerId).slice(0, 200) : null]);
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 300);
      if (e instanceof push.PushGone) {
        await db.query('DELETE FROM push_subscriptions WHERE id=$1', [n.push_sub_id]);
      }
      const final = e instanceof push.PushGone || (e && e.final) || n.attempts >= MAX_ATTEMPTS;
      if (final) {
        await db.query(`UPDATE notifications SET state='failed', last_error=$2, payload='{}'::jsonb WHERE id=$1`, [n.id, msg]);
      } else {
        await db.query(`UPDATE notifications SET state='queued', last_error=$2, next_attempt_at=now() + ($3 || ' milliseconds')::interval WHERE id=$1`,
          [n.id, msg, String(backoffMs(n.attempts))]);
      }
    }
    if (n.alert_id) await S.recomputeAlertStatus(db.pool, n.alert_id);
  }
  return claimed.length;
}

// Échéances de trajet : vérifiées ici, côté serveur, indépendamment du téléphone (F-051).
async function processTrips() {
  return db.tx(async client => {
    const trips = (await client.query(
      `SELECT * FROM trips WHERE status IN ('actif','grace') AND deadline_at - interval '5 minutes' <= now()
       ORDER BY deadline_at LIMIT 50 FOR UPDATE SKIP LOCKED`)).rows;
    const now = Date.now();
    let acted = 0;
    for (const t of trips) {
      const deadline = new Date(t.deadline_at).getTime();
      const total = deadline - new Date(t.started_at).getTime();
      const lead = Math.min(300000, Math.max(20000, total * 0.25));

      if (t.status === 'actif' && !t.reminded_at && now >= deadline - lead && now < deadline) {
        await client.query('UPDATE trips SET reminded_at=now() WHERE id=$1', [t.id]);
        await S.notifyUser(client, t.user_id, 'trip_reminder', { tripId: t.id });
        await S.audit(client, t.user_id, 'systeme', 'trajet.rappel', t.ref);
        acted++;
      }
      if (t.status === 'actif' && now >= deadline) {
        await client.query(`UPDATE trips SET status='grace' WHERE id=$1`, [t.id]);
        await S.notifyUser(client, t.user_id, 'trip_deadline', { tripId: t.id });
        await S.audit(client, t.user_id, 'systeme', 'trajet.echeance_atteinte', t.ref);
        t.status = 'grace';
        acted++;
      }
      if (t.status === 'grace' && now >= deadline + t.grace_seconds * 1000) {
        const last = (await client.query('SELECT * FROM location_points WHERE trip_id=$1 ORDER BY measured_at DESC LIMIT 1', [t.id])).rows[0];
        const pos = last ? { lat: last.lat, lng: last.lng, accuracy: last.accuracy, measuredAt: last.measured_at, stale: false } : null;
        const ids = (await client.query('SELECT contact_id FROM trip_contacts WHERE trip_id=$1', [t.id])).rows.map(r => r.contact_id);
        const hm = new Date(t.deadline_at).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });
        const { alert } = await S.createAlert(client, {
          userId: t.user_id, idemKey: 'trip:' + t.id, type: 'Arrivée non confirmée', origin: 'tracking', tripId: t.id, pos, contactIds: ids,
          comment: `Échéance de ${hm} dépassée, délai de grâce de ${Math.round(t.grace_seconds / 60)} min écoulé sans confirmation.${t.label ? ' Trajet : ' + t.label + '.' : ''}`,
        });
        await client.query(`UPDATE trips SET status='alerte', alert_id=$2, ended_at=now() WHERE id=$1`, [t.id, alert.id]);
        await S.audit(client, t.user_id, 'systeme', 'trajet.alerte_declenchee', `${t.ref} ${alert.ref}`);
        acted++;
      }
    }
    return acted;
  });
}

async function retention() {
  const r = config.retention;
  const run = (sql, days) => db.query(sql, [String(days)]);
  await run(`DELETE FROM location_points WHERE received_at < now() - ($1 || ' days')::interval`, r.tripPointsDays);
  await run(`DELETE FROM alerts WHERE created_at < now() - ($1 || ' days')::interval`, r.alertsDays);
  await run(`DELETE FROM notifications WHERE created_at < now() - ($1 || ' days')::interval AND state IN ('sent','failed')`, r.notificationsDays);
  await run(`DELETE FROM audit_logs WHERE at < now() - ($1 || ' days')::interval`, r.auditDays);
  await run(`DELETE FROM shares WHERE expires_at < now() - ($1 || ' days')::interval`, r.sharesDays);
  await db.query(`DELETE FROM sessions WHERE expires_at < now()`);
  await db.query(`DELETE FROM email_tokens WHERE expires_at < now() - interval '1 day'`);
  // Invitations sans réponse : expirées depuis plus de 30 jours, on efface la ligne
  await db.query(`DELETE FROM contacts WHERE status='pending' AND invite_expires_at < now() - interval '30 days'`);
  // Comptes jamais vérifiés depuis 30 jours
  await db.query(`DELETE FROM users WHERE email_verified_at IS NULL AND created_at < now() - interval '30 days'`);
}

module.exports = { processNotifications, processTrips, retention, render };

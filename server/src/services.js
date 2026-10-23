'use strict';
// Logique métier partagée par l'API et le worker.
const config = require('./config');
const { newToken, hashToken, newRef } = require('./util');

async function audit(client, userId, actor, action, ref) {
  await client.query('INSERT INTO audit_logs (user_id, actor, action, ref) VALUES ($1,$2,$3,$4)', [userId || null, actor, action, ref || null]);
}

async function enqueue(client, n) {
  await client.query(
    `INSERT INTO notifications (kind, channel, alert_id, recipient_id, user_id, contact_id, push_sub_id, address, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [n.kind, n.channel, n.alertId || null, n.recipientId || null, n.userId || null, n.contactId || null, n.pushSubId || null, n.address || null, JSON.stringify(n.payload || {})]
  );
}

// E-mail + push vers tous les appareils de l'utilisateur
async function notifyUser(client, userId, kind, payload) {
  const u = (await client.query('SELECT email FROM users WHERE id=$1', [userId])).rows[0];
  if (!u) return;
  await enqueue(client, { kind, channel: 'email', userId, address: u.email, payload });
  const subs = await client.query('SELECT id FROM push_subscriptions WHERE user_id=$1', [userId]);
  for (const s of subs.rows) await enqueue(client, { kind, channel: 'push', userId, pushSubId: s.id, payload });
}

/*
 * Crée une alerte. Idempotent : même (user, idemKey) => même alerte, aucun envoi en double.
 * L'alerte et sa file d'envoi sont écrites dans la même transaction : aucun envoi ne part
 * pour une alerte qui ne serait pas enregistrée (F-023).
 */
async function createAlert(client, { userId, idemKey, type, comment, origin, tripId = null, pos = null, contactIds = null }) {
  const ins = await client.query(
    `INSERT INTO alerts (ref, user_id, idem_key, type, comment, origin, trip_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'creee') ON CONFLICT (user_id, idem_key) DO NOTHING RETURNING *`,
    [newRef('A'), userId, idemKey, type, comment, origin, tripId]
  );
  if (!ins.rows.length) {
    const ex = await client.query('SELECT * FROM alerts WHERE user_id=$1 AND idem_key=$2', [userId, idemKey]);
    return { alert: ex.rows[0], created: false };
  }
  const alert = ins.rows[0];
  if (pos) {
    await client.query('INSERT INTO alert_positions (alert_id, lat, lng, accuracy, measured_at, stale) VALUES ($1,$2,$3,$4,$5,$6)',
      [alert.id, pos.lat, pos.lng, pos.accuracy, pos.measuredAt, !!pos.stale]);
  }
  const params = [userId];
  let filter = '';
  if (contactIds) { params.push(contactIds); filter = 'AND id = ANY($2::uuid[])'; }
  const contacts = (await client.query(
    `SELECT id, name, email FROM contacts WHERE owner_id=$1 AND status='active' AND receives_alerts ${filter}`, params)).rows;

  for (const c of contacts) {
    const token = newToken();
    const r = await client.query('INSERT INTO alert_recipients (alert_id, contact_id, contact_name, view_token_hash) VALUES ($1,$2,$3,$4) RETURNING id',
      [alert.id, c.id, c.name, hashToken(token)]);
    const link = `${config.publicUrl}/a/${token}`;
    await enqueue(client, { kind: 'alert', channel: 'email', alertId: alert.id, recipientId: r.rows[0].id, contactId: c.id, address: c.email, payload: { link } });
    const subs = await client.query('SELECT id FROM push_subscriptions WHERE contact_id=$1', [c.id]);
    for (const s of subs.rows) {
      await enqueue(client, { kind: 'alert', channel: 'push', alertId: alert.id, recipientId: r.rows[0].id, contactId: c.id, pushSubId: s.id, payload: { link } });
    }
  }
  const status = contacts.length ? 'en_traitement' : 'sans_destinataire';
  await client.query('UPDATE alerts SET status=$2 WHERE id=$1', [alert.id, status]);
  alert.status = status;
  await audit(client, userId, origin === 'tracking' ? 'systeme' : 'utilisateur', 'alerte.creee', `${alert.ref} ${type} (${contacts.length} destinataire(s))`);
  return { alert, created: true };
}

async function recomputeAlertStatus(client, alertId) {
  const r = (await client.query(
    `SELECT a.status,
       (SELECT count(*) FROM alert_recipients WHERE alert_id=a.id)::int AS recips,
       (SELECT count(*) FROM alert_recipients WHERE alert_id=a.id AND acked_at IS NOT NULL)::int AS acks,
       count(n.id) FILTER (WHERE n.state='sent')::int AS ok,
       count(n.id) FILTER (WHERE n.state='failed')::int AS ko,
       count(n.id) FILTER (WHERE n.state IN ('queued','sending'))::int AS pending
     FROM alerts a LEFT JOIN notifications n ON n.alert_id=a.id AND n.kind='alert'
     WHERE a.id=$1 GROUP BY a.id`, [alertId])).rows[0];
  if (!r || r.status === 'cloturee') return;
  let s;
  if (!r.recips) s = 'sans_destinataire';
  else if (r.acks) s = 'accusee';
  else if (r.pending) s = 'en_traitement';
  else if (r.ko && r.ok) s = 'echec_partiel';
  else if (r.ko) s = 'echec';
  else s = 'envoyee';
  if (s !== r.status) await client.query('UPDATE alerts SET status=$2 WHERE id=$1', [alertId, s]);
}

async function closeAlert(client, alert, actor) {
  const up = await client.query(`UPDATE alerts SET status='cloturee', closed_at=now() WHERE id=$1 AND status<>'cloturee' RETURNING *`, [alert.id]);
  if (!up.rows.length) return false;
  // Prévenir les destinataires. Pas de nouveau lien : le lien de l'alerte d'origine reste valable
  // et affiche désormais « clôturée » (on ne stocke que le hash du jeton, impossible de le renvoyer).
  // Fausse alerte clôturée avant envoi : on annule ce qui n'est pas encore parti.
  await client.query(`UPDATE notifications SET state='failed', last_error='Annulée : alerte clôturée avant envoi', payload='{}'::jsonb
                      WHERE alert_id=$1 AND kind='alert' AND state='queued'`, [alert.id]);
  const recips = await client.query(
    `SELECT r.id, r.contact_id FROM alert_recipients r
     WHERE r.alert_id=$1 AND r.contact_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM notifications n WHERE n.recipient_id=r.id AND n.kind='alert' AND n.state IN ('sent','sending'))`, [alert.id]);
  for (const r of recips.rows) {
    const c = (await client.query('SELECT email FROM contacts WHERE id=$1', [r.contact_id])).rows[0];
    if (c) await enqueue(client, { kind: 'alert_closed', channel: 'email', alertId: alert.id, recipientId: r.id, contactId: r.contact_id, address: c.email });
    const subs = await client.query('SELECT id FROM push_subscriptions WHERE contact_id=$1', [r.contact_id]);
    for (const s of subs.rows) await enqueue(client, { kind: 'alert_closed', channel: 'push', alertId: alert.id, recipientId: r.id, contactId: r.contact_id, pushSubId: s.id });
  }
  await audit(client, alert.user_id, actor, 'alerte.cloturee', alert.ref);
  return true;
}

module.exports = { audit, enqueue, notifyUser, createAlert, recomputeAlertStatus, closeAlert };

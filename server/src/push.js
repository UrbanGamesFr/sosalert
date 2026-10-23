'use strict';
// Notifications Web Push (VAPID). Fonctionne pour la PWA sur Android, ordinateur,
// et sur iPhone uniquement si l'app est installée sur l'écran d'accueil.
const webpush = require('web-push');
const config = require('./config');

const sentInMemory = []; // test
let configured = false;
function ensure() {
  if (configured) return true;
  if (!config.push.publicKey || !config.push.privateKey) return false;
  webpush.setVapidDetails(config.push.subject, config.push.publicKey, config.push.privateKey);
  configured = true;
  return true;
}

class PushGone extends Error {}

// sub = {endpoint, p256dh, auth}; payload = {title, body, url, tag}
async function send(sub, payload, { urgent = false } = {}) {
  if (config.mail.transport === 'memory') { sentInMemory.push({ endpoint: sub.endpoint, payload }); return { providerId: 'push-mem-' + sentInMemory.length }; }
  if (!ensure()) throw new Error('Push non configuré (clés VAPID absentes)');
  try {
    const res = await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: urgent ? 3600 : 86400, urgency: urgent ? 'high' : 'normal', timeout: 15000 }
    );
    return { providerId: (res && res.headers && (res.headers.location || res.headers['location'])) || null };
  } catch (e) {
    if (e && (e.statusCode === 404 || e.statusCode === 410)) throw new PushGone('Abonnement push expiré');
    throw e;
  }
}

module.exports = { send, PushGone, sentInMemory };

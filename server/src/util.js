'use strict';
const crypto = require('crypto');

// Jeton aléatoire non devinable (base64url, 32 octets par défaut) et son hash stocké en base.
function newToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest();
}

// Référence courte lisible par un humain : A-7K2Q9X
function newRef(prefix) {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const b = crypto.randomBytes(6);
  let s = '';
  for (const x of b) s += alphabet[x % alphabet.length];
  return `${prefix}-${s}`;
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.statusCode = status;
    this.code = code;
  }
}

const isEmail = s => typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);

function cleanText(s, max) {
  if (s == null) return null;
  const t = String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  return t ? t.slice(0, max) : null;
}

// Valide une position envoyée par un appareil. Renvoie null si absente, lève une erreur si invalide.
function parsePosition(p, { maxAgeMs = 24 * 3600 * 1000 } = {}) {
  if (p == null) return null;
  const lat = Number(p.lat), lng = Number(p.lng), acc = Math.round(Number(p.accuracy));
  const measuredAt = Number(p.measuredAt);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new HttpError(400, 'bad_position', 'Latitude invalide');
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new HttpError(400, 'bad_position', 'Longitude invalide');
  if (!Number.isFinite(acc) || acc < 0 || acc > 100000) throw new HttpError(400, 'bad_position', 'Précision invalide');
  const now = Date.now();
  if (!Number.isFinite(measuredAt) || measuredAt > now + 60000 || measuredAt < now - maxAgeMs) {
    throw new HttpError(400, 'bad_position', 'Heure de mesure invalide');
  }
  return { lat, lng, accuracy: acc, measuredAt: new Date(measuredAt), stale: !!p.stale };
}

module.exports = { newToken, hashToken, newRef, HttpError, isEmail, cleanText, parsePosition };

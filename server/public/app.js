(function () {
'use strict';

/* ================= Utilitaires ================= */
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ts = d => (d == null ? null : (typeof d === 'number' ? d : new Date(d).getTime()));
const fmtT = d => new Date(ts(d)).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtHM = d => new Date(ts(d)).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const fmtD = d => new Date(ts(d)).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
let clockSkew = 0; // serveur - appareil, pour des comptes à rebours justes
const now = () => Date.now() + clockSkew;
function remain(ms) { ms = Math.max(0, ms); const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m).padStart(2, '0')) + ':' + String(r).padStart(2, '0'); }
function ago(ms) { const s = Math.round(ms / 1000); if (s < 60) return 'il y a ' + s + ' s'; const m = Math.round(s / 60); if (m < 60) return 'il y a ' + m + ' min'; const h = Math.round(m / 60); return h < 48 ? 'il y a ' + h + ' h' : 'il y a ' + Math.round(h / 24) + ' j'; }
function newKey() { const b = new Uint8Array(18); crypto.getRandomValues(b); return Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); }
const store = {
  get(k, d) { try { const v = localStorage.getItem('sosalert.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('sosalert.' + k, JSON.stringify(v)); } catch (e) { /* stockage indisponible */ } },
  del(k) { try { localStorage.removeItem('sosalert.' + k); } catch (e) { /* ignore */ } },
};

/* ================= API ================= */
class ApiError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
async function api(method, path, body, headers) {
  let res;
  try {
    res = await fetch(path, { method, credentials: 'same-origin', headers: Object.assign(body === undefined ? {} : { 'Content-Type': 'application/json' }, headers || {}), body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) { throw new ApiError(0, 'network', 'Pas de connexion au serveur.'); }
  let data = null; try { data = await res.json(); } catch (e) { /* vide */ }
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/auth/login' && path !== '/api/me' && !path.startsWith('/api/me')) { onLoggedOut(); }
    throw new ApiError(res.status, data && data.error, (data && data.message) || 'Erreur ' + res.status);
  }
  if (data && data.serverNow) clockSkew = data.serverNow - Date.now();
  return data;
}

/* ================= État ================= */
const S = { me: null, cfg: null, contacts: [], alerts: [], trip: null, recent: [], shares: [], activity: [], lastPos: store.get('lastPos', null), gps: 'unknown' };
let tab = (location.hash || '').replace('#', '') === 'trajet' ? 'trip' : 'home';

/* ================= Géolocalisation ================= */
function fromCoords(p) { return { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy), measuredAt: p.timestamp || Date.now() }; }
function locate(timeout = 9000) {
  return new Promise(res => {
    if (!('geolocation' in navigator)) { S.gps = 'none'; return res(null); }
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; res(null); } }, timeout + 500);
    navigator.geolocation.getCurrentPosition(p => {
      if (done) return; done = true; clearTimeout(t);
      const pos = fromCoords(p); S.lastPos = pos; S.gps = 'ok'; store.set('lastPos', pos); renderHeader(); res(pos);
    }, err => { if (done) return; done = true; clearTimeout(t); S.gps = err.code === 1 ? 'denied' : 'error'; renderHeader(); res(null); },
    { enableHighAccuracy: true, timeout, maximumAge: 0 });
  });
}
function freshness(p, at) {
  if (!p) return { cls: 'bad', label: 'Position indisponible' };
  const age = (at || now()) - ts(p.measuredAt || p.measured_at);
  const acc = p.accuracy;
  if (age > 600000) return { cls: 'bad', label: 'Ancienne, mesurée ' + ago(age) };
  if (acc > 100) return { cls: 'warn', label: 'Imprécise ±' + acc + ' m' };
  if (age < 60000) return { cls: 'ok', label: 'Fraîche ±' + acc + ' m' };
  return { cls: 'warn', label: 'Récente, ' + ago(age) };
}
function posBlock(p, at, suffix) {
  if (!p) return '<div class="pos"><span class="pill bad">Position indisponible</span><p class="small muted">Autorisez la localisation ou décrivez le lieu dans le message.</p></div>';
  const f = freshness(p, at), m = ts(p.measuredAt || p.measured_at);
  const map = 'https://www.openstreetmap.org/?mlat=' + p.lat.toFixed(6) + '&mlon=' + p.lng.toFixed(6) + '#map=17/' + p.lat.toFixed(6) + '/' + p.lng.toFixed(6);
  return '<div class="pos"><div class="coords mono">' + p.lat.toFixed(5) + ', ' + p.lng.toFixed(5) + '</div><div class="pos-meta"><span class="pill ' + f.cls + '">' + esc(f.label) + (suffix ? ' ' + esc(suffix) : '') + '</span><span>Mesure ' + fmtT(m) + '</span>' + (p.stale ? '<span>(dernière position connue)</span>' : '') + '</div><a class="link" href="' + map + '" target="_blank" rel="noopener">Ouvrir sur une carte</a></div>';
}

/* ================= Rendu commun ================= */
const AS = { creee: ['Créée', 'info'], en_traitement: ['Envoi en cours', 'info'], envoyee: ['Envoyée', 'ok'], echec_partiel: ['Échec partiel', 'warn'], echec: ['Échec d’envoi', 'bad'], accusee: ['Vue par un contact', 'ok'], cloturee: ['Clôturée', 'off'], sans_destinataire: ['Aucun contact actif', 'bad'] };
const RS = { queued: ['En file', 'off'], sending: ['Envoi en cours', 'info'], sent: ['Envoyé', 'ok'], failed: ['Échec', 'bad'] };
const CH = { email: 'E-mail', push: 'Notification' };
const TYPES = ['Urgence', 'Agression', 'Malaise', 'Accident', 'Je suis suivi(e)', 'Autre'];

function numbersHtml() {
  const n = [['17', 'Police'], ['15', 'SAMU'], ['18', 'Pompiers'], ['112', 'Europe'], ['114', 'SMS']];
  return '<div class="card"><div class="row between"><h3>Danger immédiat</h3><span class="small muted">Appel direct</span></div><div class="numbers">' +
    n.map(x => '<a class="num" href="' + (x[0] === '114' ? 'sms:114' : 'tel:' + x[0]) + '"><b>' + x[0] + '</b><span>' + x[1] + '</span></a>').join('') + '</div></div>';
}
function recipientsHtml(a) {
  if (!a.recipients.length) return '<p class="err-box">Aucun contact actif n’a reçu cette alerte. Appelez un numéro d’urgence si nécessaire.</p>';
  return '<h3>Destinataires</h3>' + a.recipients.map(r => '<div class="rec"><div class="rec-line"><b>' + esc(r.name) + '</b>' +
    (r.ackedAt ? '<span class="pill ok">Vue à ' + fmtHM(r.ackedAt) + '</span>' : r.firstViewedAt ? '<span class="pill info">Lien ouvert à ' + fmtHM(r.firstViewedAt) + '</span>' : '<span class="pill off">Pas encore vue</span>') + '</div>' +
    r.deliveries.map(d => '<div class="rec-line"><span>' + CH[d.channel] + '</span><span class="pill ' + RS[d.state][1] + '">' + RS[d.state][0] + (d.attempts > 1 ? ' (' + d.attempts + ' essais)' : '') + '</span></div>' +
      (d.error && d.state !== 'sent' ? '<div class="err">' + esc(d.error) + '</div>' : '')).join('') + '</div>').join('') +
    '<p class="note">« Envoyé » signifie que le message a quitté nos serveurs. La lecture n’est confirmée que lorsque le contact ouvre le lien ou indique avoir vu l’alerte.</p>';
}
let toastT = 0;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3500); }
function tickLabels() { document.querySelectorAll('[data-until]').forEach(e => { e.textContent = remain(+e.dataset.until - now()); }); }
function openSheet(html) { $('#sheetBody').innerHTML = html; $('#sheetWrap').hidden = false; }
function closeSheet() { $('#sheetWrap').hidden = true; sheetAlertId = null; }
function busy(btn, on) { if (!btn) return; btn.disabled = on; if (on) { btn.dataset.label = btn.innerHTML; btn.innerHTML = '<span class="spin"></span>'; } else if (btn.dataset.label) btn.innerHTML = btn.dataset.label; }
const val = id => { const e = document.getElementById(id); return e ? e.value.trim() : ''; };

/* ================= Authentification ================= */
function showAuth(mode, extra) {
  $('#topbar').hidden = true; $('#tabs').hidden = true;
  const v = $('#view');
  const head = '<div class="brand" style="font-size:1.6rem"><span class="mark"></span>SOSAlert</div>';
  const msg = extra && extra.error ? '<p class="err-box">' + esc(extra.error) + '</p>' : extra && extra.ok ? '<p class="ok-box">' + esc(extra.ok) + '</p>' : '';
  let h = '';
  if (mode === 'login') {
    h = head + '<h1 style="font-size:1.6rem">Connexion</h1>' + msg +
      '<form class="stack" id="fLogin"><label class="f">E-mail<input type="email" id="lEmail" autocomplete="email" required></label>' +
      '<label class="f">Mot de passe<input type="password" id="lPass" autocomplete="current-password" required style="width:100%;border:1px solid var(--line);background:var(--bg);border-radius:10px;padding:10px 12px;min-height:44px"></label>' +
      '<button class="btn primary block" type="submit">Se connecter</button></form>' +
      '<div class="btns"><button class="btn ghost" type="button" data-act="auth" data-v="register">Créer un compte</button><button class="btn ghost" type="button" data-act="auth" data-v="forgot">Mot de passe oublié</button></div>' + numbersHtml();
  } else if (mode === 'register') {
    h = head + '<h1 style="font-size:1.6rem">Prévenir vos proches en un geste</h1>' +
      '<div class="card"><p class="small"><b>SOSAlert ne remplace pas les secours.</b> En danger immédiat, appelez le 17, le 15, le 18 ou le 112. La réception d’une alerte n’est jamais garantie : réseau, batterie et réglages des téléphones peuvent l’empêcher.</p></div>' + msg +
      '<form class="stack" id="fRegister"><label class="f">Votre prénom, tel que vos contacts le verront<input type="text" id="rName" maxlength="60" autocomplete="given-name" required></label>' +
      '<label class="f">E-mail<input type="email" id="rEmail" autocomplete="email" required></label>' +
      '<label class="f">Mot de passe (10 caractères minimum)<input type="password" id="rPass" autocomplete="new-password" minlength="10" required style="width:100%;border:1px solid var(--line);background:var(--bg);border-radius:10px;padding:10px 12px;min-height:44px"></label>' +
      '<label class="check"><input type="checkbox" id="rTerms" required>J’ai compris ces limites et j’accepte les <a class="link" href="/conditions.html" target="_blank">conditions d’utilisation</a> et la <a class="link" href="/confidentialite.html" target="_blank">politique de confidentialité</a>.</label>' +
      '<button class="btn primary block" type="submit">Créer mon compte</button></form>' +
      '<button class="btn ghost" type="button" data-act="auth" data-v="login">J’ai déjà un compte</button>';
  } else if (mode === 'forgot') {
    h = head + '<h1 style="font-size:1.6rem">Mot de passe oublié</h1>' + msg +
      '<form class="stack" id="fForgot"><label class="f">E-mail du compte<input type="email" id="fEmail" autocomplete="email" required></label><button class="btn primary block" type="submit">Recevoir un lien</button></form>' +
      '<button class="btn ghost" type="button" data-act="auth" data-v="login">Retour à la connexion</button>';
  } else if (mode === 'reset') {
    h = head + '<h1 style="font-size:1.6rem">Nouveau mot de passe</h1>' + msg +
      '<form class="stack" id="fReset"><label class="f">Nouveau mot de passe (10 caractères minimum)<input type="password" id="pPass" autocomplete="new-password" minlength="10" required style="width:100%;border:1px solid var(--line);background:var(--bg);border-radius:10px;padding:10px 12px;min-height:44px"></label><button class="btn primary block" type="submit">Enregistrer</button></form>';
  }
  v.className = 'auth'; v.innerHTML = h;
  const first = v.querySelector('input'); if (first) first.focus();
}
document.addEventListener('submit', async e => {
  const f = e.target; if (!f.id) return; e.preventDefault();
  const btn = f.querySelector('button[type=submit]'); busy(btn, true);
  try {
    if (f.id === 'fLogin') { const r = await api('POST', '/api/auth/login', { email: val('lEmail'), password: $('#lPass').value }); S.me = r.me; await startApp(); }
    else if (f.id === 'fRegister') {
      if (!$('#rTerms').checked) throw new ApiError(400, 'terms', 'Cochez la case pour continuer.');
      const r = await api('POST', '/api/auth/register', { name: val('rName'), email: val('rEmail'), password: $('#rPass').value, acceptTerms: S.cfg.termsVersion });
      S.me = r.me; await startApp(); toast('Compte créé. Confirmez votre adresse via l’e-mail reçu.');
    }
    else if (f.id === 'fForgot') { await api('POST', '/api/auth/forgot', { email: val('fEmail') }); showAuth('login', { ok: 'Si un compte existe pour cette adresse, un lien vient d’être envoyé. Il expire dans 1 heure.' }); }
    else if (f.id === 'fReset') { await api('POST', '/api/auth/reset', { token: resetToken, password: $('#pPass').value }); history.replaceState(null, '', '/'); await boot(); toast('Mot de passe modifié. Vos autres appareils ont été déconnectés.'); }
    else if (f.id === 'fInvite') { await actions.invite(btn); }
    else if (f.id === 'fTrip') { await actions.startTrip(btn); }
    else if (f.id === 'fDelete') { await actions.deleteAccount(btn); }
  } catch (err) {
    if (f.id.startsWith('fLogin') || f.id === 'fRegister' || f.id === 'fForgot' || f.id === 'fReset') showAuth({ fLogin: 'login', fRegister: 'register', fForgot: 'forgot', fReset: 'reset' }[f.id], { error: err.message });
    else toast(err.message);
  } finally { busy(btn, false); }
});
function onLoggedOut() { S.me = null; stopAllTimers(); showAuth('login', { error: 'Session expirée. Reconnectez-vous.' }); }

/* ================= Chargement des données ================= */
async function loadAll() {
  const [c, a, t, s] = await Promise.all([api('GET', '/api/contacts'), api('GET', '/api/alerts'), api('GET', '/api/trips'), api('GET', '/api/shares')]);
  S.contacts = c.contacts; S.alerts = a.alerts; S.trip = t.active; S.recent = t.recent; S.shares = s.shares;
}
async function refreshTrip() { const t = await api('GET', '/api/trips'); S.trip = t.active; S.recent = t.recent; syncTripWatch(); }
const openAlerts = () => S.alerts.filter(a => a.status !== 'cloturee');

/* ================= En-tête et vues ================= */
function renderHeader() {
  const p = $('#gpsPill'); if (!p) return;
  const t = S.trip;
  const m = { ok: ['GPS actif', 'ok'], denied: ['GPS refusé', 'bad'], error: ['GPS indisponible', 'warn'], none: ['GPS absent', 'bad'], unknown: ['GPS', 'off'] }[S.gps];
  p.className = 'pill ' + (t && t.status === 'grace' ? 'bad' : t ? 'info' : m[1]);
  p.textContent = t ? (t.status === 'grace' ? 'Échéance dépassée' : 'Trajet suivi') : m[0];
  document.querySelectorAll('.tab').forEach(b => b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'));
  const vb = $('#verifyBand');
  if (S.me && !S.me.emailVerified) { vb.hidden = false; vb.innerHTML = 'Confirmez votre adresse (lien envoyé à ' + esc(S.me.email) + ') pour inviter des contacts. <button type="button" class="btn ghost" style="min-height:0;padding:0 4px" data-act="resendVerify">Renvoyer</button>'; }
  else vb.hidden = true;
  $('#offlineBand').hidden = navigator.onLine !== false;
}
function render() {
  if (!S.me) return;
  renderHeader();
  const v = $('#view'); v.className = '';
  const ae = document.activeElement;
  if (ae && /INPUT|SELECT|TEXTAREA/.test(ae.tagName) && v.contains(ae) && v.dataset.tab === tab) { tickLabels(); return; } // ne pas effacer une saisie en cours
  v.dataset.tab = tab;
  v.innerHTML = ({ home: viewHome, trip: viewTrip, contacts: viewContacts, history: viewHistory, settings: viewSettings })[tab]();
  if (tab === 'home') { const b = $('#sosBtn'); if (b) bindSos(b); }
  if (tab === 'trip' && S.trip) requestAnimationFrame(drawTrack);
  tickLabels();
}

function viewHome() {
  const active = S.contacts.filter(c => c.status === 'active' && c.receivesAlerts);
  const open = openAlerts(), t = S.trip;
  let h = '';
  if (pendingSos()) h += '<div class="banner"><div><b>Alerte non confirmée par le serveur</b><br><span class="small">Nouvel essai automatique. En danger, appelez le 112.</span></div></div>';
  if (open.length) h += '<button type="button" class="banner" data-act="openAlert" data-id="' + open[0].id + '"><div><b>Alerte ' + esc(open[0].ref) + ' en cours</b><br><span class="small">' + esc(AS[open[0].status][0]) + ' · ' + fmtHM(open[0].createdAt) + '</span></div><span>Voir</span></button>';
  if (t) h += '<button type="button" class="banner warn" data-act="tab" data-v="trip"><div><b>' + (t.status === 'grace' ? 'Échéance dépassée' : 'Trajet en cours') + '</b><br><span class="small">' + (t.status === 'grace' ? 'Alerte dans ' : 'Échéance dans ') + '<span class="mono" data-until="' + tripLimit(t) + '"></span></span></div><span>Ouvrir</span></button>';
  h += '<section class="sos-zone"><button type="button" class="sos-btn" id="sosBtn" aria-label="Déclencher une alerte : maintenir appuyé"><span class="core"><span class="big">SOS</span><span class="sub">Maintenir appuyé</span></span></button>' +
    (active.length ? '<p class="reach"><b>' + active.length + ' contact' + (active.length > 1 ? 's' : '') + '</b> recevr' + (active.length > 1 ? 'ont' : 'a') + ' l’alerte : ' + active.map(c => esc(c.name)).join(', ') + '</p>'
      : '<p class="reach" style="color:var(--bad)"><b>Aucun contact actif.</b> Une alerte ne partirait vers personne. <button type="button" class="btn ghost" data-act="tab" data-v="contacts">Ajouter un contact</button></p>') +
    '<p class="small muted">5 secondes pour annuler après le déclenchement.</p></section>';
  h += numbersHtml();
  h += '<div class="card"><div class="row between"><h3>Ma position</h3><button type="button" class="btn ghost" data-act="locate">Actualiser</button></div>' + posBlock(S.lastPos) + '</div>';
  const cs = S.contacts.filter(c => c.status === 'active');
  const live = S.shares.filter(s => !s.revokedAt && ts(s.expiresAt) > now());
  h += '<div class="card"><h3>Partager ma position une fois</h3><p class="small muted">Lien privé envoyé par vous, révocable, qui expire. Le contact voit la position du moment, pas un suivi continu.</p>' +
    (cs.length ? '<div class="grid2"><label class="f">Avec<select id="shC">' + cs.map(c => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('') + '</select></label>' +
      '<label class="f">Valable<select id="shM"><option value="15">15 min</option><option value="60" selected>1 h</option><option value="240">4 h</option></select></label></div>' +
      '<button type="button" class="btn" data-act="share">Créer le lien</button>' : '<p class="small">Il faut un contact actif pour partager.</p>') +
    (lastShareUrl ? '<div class="rec"><span class="small">Lien à transmettre (affiché une seule fois) :</span><span class="mono small" style="overflow-wrap:anywhere">' + esc(lastShareUrl) + '</span><button type="button" class="btn" data-act="copy" data-v="' + esc(lastShareUrl) + '">Copier le lien</button></div>' : '') +
    (live.length ? '<div class="list">' + live.map(s => '<div class="item"><div class="grow"><div class="t">' + esc(s.contactName || 'Contact') + '</div><div class="small muted">Expire dans <span class="mono" data-until="' + ts(s.expiresAt) + '"></span></div></div><button type="button" class="btn ghost" data-act="revokeShare" data-id="' + s.id + '">Révoquer</button></div>').join('') + '</div>' : '') + '</div>';
  return h;
}

function tripLimit(t) { return t.status === 'grace' ? ts(t.deadlineAt) + t.graceSeconds * 1000 : ts(t.deadlineAt); }
function viewTrip() {
  const t = S.trip;
  let h = '';
  if (t) {
    const grace = t.status === 'grace', names = t.contacts.map(c => esc(c.name)).join(', ') || '<span style="color:var(--bad)">aucun contact</span>';
    h += '<div class="card ' + (grace ? 'trip-grace' : '') + '"><div class="trip-head"><p class="eyebrow">' + (grace ? 'Échéance dépassée' : 'Trajet ' + esc(t.ref) + ' en cours') + '</p><div class="count" data-until="' + tripLimit(t) + '"></div>' +
      '<p class="small">' + (grace ? 'Sans confirmation, <b>' + names + '</b> recevr' + (t.contacts.length > 1 ? 'ont' : 'a') + ' une alerte avec votre dernière position.' : 'Échéance à <b>' + fmtHM(t.deadlineAt) + '</b>, puis ' + Math.round(t.graceSeconds / 60) + ' min de délai de grâce. Contacts : ' + names) + '</p>' + (t.label ? '<p class="small muted">' + esc(t.label) + '</p>' : '') + '</div>' +
      '<button type="button" class="btn primary block" data-act="arrived" style="min-height:52px;font-size:1.05rem">Je suis arrivé(e)</button>' +
      '<div class="btns"><button type="button" class="btn" data-act="extend" data-v="15">+15 min</button><button type="button" class="btn" data-act="extend" data-v="30">+30 min</button><button type="button" class="btn" data-act="stopTrip">Arrêter le suivi</button></div></div>';
    const q = pointQueue().length;
    h += '<div class="card"><div class="row between"><h3>Positions transmises</h3><span class="pill ' + (S.gps === 'ok' ? 'ok' : 'warn') + '">' + (S.gps === 'ok' ? 'GPS actif' : 'GPS en attente') + '</span></div>' +
      '<canvas class="track" id="trackCanvas" aria-label="Tracé du trajet"></canvas>' +
      '<div class="stats"><div class="stat"><b>' + t.points.length + '</b><span>reçues par le serveur</span></div><div class="stat"><b id="stLast">' + (t.points.length ? ago(now() - t.points[t.points.length - 1].t).replace('il y a ', '') : '–') + '</b><span>dernier point</span></div><div class="stat"><b>' + q + '</b><span>en attente d’envoi</span></div></div>' +
      '<p class="note">Un tracé rouge pointillé signale un trou de plus de 90 s : téléphone en veille, réseau absent ou économie d’énergie. Gardez l’application ouverte pendant le trajet.</p></div>';
    h += '<p class="note">L’échéance est surveillée par le serveur : l’alerte part même si votre téléphone s’éteint.</p>';
    return h;
  }
  const last = S.recent[0];
  if (last && now() - ts(last.endedAt) < 3600000) {
    h += '<div class="card"><div class="row between"><h3>Dernier trajet ' + esc(last.ref) + '</h3><span class="pill ' + (last.status === 'alerte' ? 'bad' : 'ok') + '">' + ({ termine: 'Arrivée confirmée', arrete: 'Arrêté', alerte: 'Alerte déclenchée' })[last.status] + '</span></div>' +
      (last.alertId ? '<button type="button" class="btn" data-act="openAlert" data-id="' + last.alertId + '">Voir l’alerte</button>' : '<p class="small muted">' + last.points + ' positions reçues, collecte arrêtée.</p>') + '</div>';
  }
  const cs = S.contacts.filter(c => c.status === 'active' && c.receivesAlerts);
  h += '<form class="card" id="fTrip"><h2>Nouveau trajet suivi</h2><p class="small muted">Si vous ne confirmez pas votre arrivée avant l’échéance, vos contacts sont alertés avec votre dernière position.</p>' +
    '<label class="f">Destination ou description (facultatif)<input type="text" id="tLabel" maxlength="120" placeholder="Retour à pied depuis la gare"></label>' +
    '<div class="grid2"><label class="f">Durée<select id="tMin"><option value="1">1 min (test)</option><option value="15">15 min</option><option value="30" selected>30 min</option><option value="45">45 min</option><option value="60">1 h</option><option value="90">1 h 30</option><option value="120">2 h</option><option value="240">4 h</option></select></label>' +
    '<label class="f">Délai de grâce<select id="tGrace"><option value="1">1 min (test)</option><option value="2">2 min</option><option value="5" selected>5 min</option><option value="10">10 min</option></select></label></div>' +
    '<fieldset style="border:0;padding:0;margin:0" class="stack"><legend style="font-weight:700;font-size:.88rem;margin-bottom:6px">Contacts prévenus en cas de dépassement</legend>' +
    (cs.length ? cs.map(c => '<label class="check"><input type="checkbox" class="tC" value="' + c.id + '" checked>' + esc(c.name) + '</label>').join('') : '<p class="small" style="color:var(--bad)">Aucun contact actif. Ajoutez-en un d’abord.</p>') + '</fieldset>' +
    '<label class="check"><input type="checkbox" id="tOk">J’accepte que ma position soit collectée pendant ce trajet uniquement (conservée 30 jours).</label>' +
    '<button type="submit" class="btn primary"' + (cs.length && S.me.emailVerified ? '' : ' disabled') + '>Démarrer le suivi</button></form>';
  if (S.recent.length) h += '<div class="card"><h3>Trajets précédents</h3><div class="list">' + S.recent.map(x => '<div class="item"><div class="grow"><div class="t">' + esc(x.label || x.ref) + '</div><div class="small muted">' + fmtD(x.startedAt) + ' · ' + x.points + ' positions</div></div><span class="pill ' + (x.status === 'alerte' ? 'bad' : 'off') + '">' + ({ termine: 'Arrivé', arrete: 'Arrêté', alerte: 'Alerte' })[x.status] + '</span></div>').join('') + '</div></div>';
  return h;
}

function contactPill(c) { return ({ active: ['Actif', 'ok'], pending: ['En attente', 'warn'], expired: ['Invitation expirée', 'bad'], refused: ['Refusée', 'off'], removed: ['Retiré', 'off'] })[c.status]; }
function viewContacts() {
  let h = '<form class="card" id="fInvite"><h2>Inviter un contact de confiance</h2><p class="small muted">Il reçoit un e-mail et doit accepter. Rien n’est partagé avant. Il n’a pas besoin d’installer l’application.</p>' +
    '<label class="f">Nom<input type="text" id="cName" maxlength="60" autocomplete="off" required placeholder="Prénom Nom"></label>' +
    '<label class="f">E-mail<input type="email" id="cMail" maxlength="254" required placeholder="nom@exemple.fr"></label>' +
    '<button type="submit" class="btn primary"' + (S.me.emailVerified ? '' : ' disabled') + '>Envoyer l’invitation</button>' + (S.me.emailVerified ? '' : '<p class="small" style="color:var(--bad)">Confirmez d’abord votre adresse e-mail.</p>') + '</form>';
  h += '<div class="card"><h2>Mes contacts</h2><div class="list">' + (S.contacts.length ? S.contacts.map(c => {
    const st = contactPill(c), dim = c.status === 'removed' || c.status === 'refused';
    let body = '<div class="t">' + esc(c.name) + '</div><div class="small muted" style="overflow-wrap:anywhere">' + esc(c.email) + '</div>';
    if (c.status === 'active') body += '<div class="stack" style="margin-top:8px"><label class="toggle"><span>Reçoit mes alertes</span><input type="checkbox" data-act="perm" data-id="' + c.id + '"' + (c.receivesAlerts ? ' checked' : '') + '></label>' +
      '<div class="small muted">Canaux : e-mail' + (c.pushDevices ? ' + notifications (' + c.pushDevices + ' appareil' + (c.pushDevices > 1 ? 's' : '') + ')' : ' seulement. Il peut activer les notifications depuis l’e-mail d’invitation.') + '</div>' +
      '<button type="button" class="btn ghost" style="align-self:flex-start;padding-left:0" data-act="removeAsk" data-id="' + c.id + '">Retirer ce contact</button></div>';
    else if (c.status === 'pending' || c.status === 'expired') body += '<div class="small muted">Invité ' + ago(now() - ts(c.invitedAt)) + '</div><div class="btns" style="margin-top:8px"><button type="button" class="btn" data-act="resend" data-id="' + c.id + '">Renvoyer l’invitation</button><button type="button" class="btn ghost" data-act="remove" data-id="' + c.id + '">Annuler</button></div>';
    else body += '<button type="button" class="btn ghost" style="align-self:flex-start;padding-left:0" data-act="remove" data-id="' + c.id + '">Effacer de la liste</button>';
    return '<div class="item' + (dim ? ' dim' : '') + '"><div class="grow stack" style="gap:2px">' + body + '</div><span class="pill ' + st[1] + '">' + st[0] + '</span></div>';
  }).join('') : '<p class="muted">Aucun contact pour l’instant.</p>') + '</div></div>';
  return h;
}

function viewHistory() {
  let h = '<div class="card"><h2>Alertes</h2>' + (S.alerts.length ? '<div class="list">' + S.alerts.map(a => '<button type="button" class="item" data-act="openAlert" data-id="' + a.id + '"><div class="grow"><div class="t">' + esc(a.type) + ' <span class="mono small muted">' + esc(a.ref) + '</span></div><div class="small muted">' + fmtD(a.createdAt) + ' · ' + a.recipients + ' destinataire' + (a.recipients > 1 ? 's' : '') + (a.origin === 'tracking' ? ' · depuis un trajet' : '') + '</div></div><span class="pill ' + AS[a.status][1] + '">' + esc(AS[a.status][0]) + '</span></button>').join('') + '</div>' : '<p class="muted">Aucune alerte. Elles apparaîtront ici avec le détail de chaque envoi.</p>') + '</div>';
  h += '<details class="card" id="actDetails"><summary style="cursor:pointer;font-weight:700">Journal d’activité du compte</summary><div class="list" id="actList" style="margin-top:10px"><p class="muted small">Ouvrez pour charger.</p></div></details>';
  return h;
}

function viewSettings() {
  const perm = ('Notification' in window) ? Notification.permission : 'unsupported';
  const pushOk = 'serviceWorker' in navigator && 'PushManager' in window && S.cfg.vapidPublicKey;
  const pl = { granted: ['Activées', 'ok'], denied: ['Bloquées dans le navigateur', 'bad'], default: ['Non activées', 'warn'], unsupported: ['Non disponibles', 'off'] }[perm];
  const ios = /iPhone|iPad/.test(navigator.userAgent) && !window.navigator.standalone;
  let h = '<div class="card"><h2>Profil</h2><p class="small muted">' + esc(S.me.email) + (S.me.emailVerified ? ' · vérifiée' : ' · non vérifiée') + '</p><label class="f">Nom affiché à vos contacts<input type="text" id="pName" maxlength="60" value="' + esc(S.me.name) + '"></label><button type="button" class="btn" data-act="saveProfile">Enregistrer</button></div>';
  h += '<div class="card"><h2>Notifications de cet appareil</h2><div class="row between"><span>Rappels de trajet</span><span class="pill ' + pl[1] + '">' + pl[0] + '</span></div>' +
    (pushOk && perm !== 'denied' ? '<button type="button" class="btn" data-act="enablePush">' + (perm === 'granted' ? 'Réenregistrer cet appareil' : 'Activer les notifications') + '</button>' : '') +
    (ios ? '<p class="note">Sur iPhone, installez d’abord l’app : Partager puis « Sur l’écran d’accueil ». Les notifications ne fonctionnent qu’ensuite.</p>' : '') +
    '<p class="note">Les rappels arrivent aussi par e-mail. Le mode silencieux et l’économie d’énergie peuvent retarder une notification.</p></div>';
  h += '<div class="card"><h2>Mes données</h2><p class="small muted">Conditions acceptées : version ' + esc(S.me.termsVersion) + ' le ' + fmtD(S.me.termsAcceptedAt) + '.</p><p class="small muted">Conservation : positions de trajet 30 jours, alertes 12 mois, journal 12 mois.</p>' +
    '<div class="btns"><button type="button" class="btn" data-act="export">Télécharger mes données</button><button type="button" class="btn" data-act="deleteAsk">Supprimer mon compte</button></div>' +
    '<p class="small"><a class="link" href="/confidentialite.html" target="_blank">Politique de confidentialité</a> · <a class="link" href="/conditions.html" target="_blank">Conditions d’utilisation</a></p></div>';
  h += '<div class="card"><h2>Limites du service</h2><p class="small">SOSAlert ne remplace pas les services d’urgence. La réception d’une alerte dépend du réseau, de la batterie, des réglages du téléphone de chaque contact et des prestataires d’envoi. Une position peut être ancienne ou imprécise : son heure de mesure et sa précision sont toujours affichées.</p></div>';
  h += '<button type="button" class="btn block" data-act="logout">Se déconnecter</button>';
  return h;
}

/* ================= SOS : maintien + compte à rebours + envoi fiable ================= */
let sos = null, sentAlertId = null, alertPoll = 0, alertWatch = null, alertPosLast = 0;
const pendingSos = () => store.get('pendingSos', null);

function bindSos(btn) {
  let start = 0, raf = 0; const HOLD = 1500;
  const reset = () => { cancelAnimationFrame(raf); start = 0; btn.style.setProperty('--p', 0); };
  const down = e => {
    e.preventDefault(); if (start) return;
    if (e.pointerId != null && btn.setPointerCapture) { try { btn.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ } }
    start = performance.now();
    const step = () => { const p = Math.min(1, (performance.now() - start) / HOLD); btn.style.setProperty('--p', p); if (p >= 1) { reset(); openCountdown(); return; } raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
  };
  btn.addEventListener('pointerdown', down);
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => btn.addEventListener(ev, () => { if (start) reset(); }));
  btn.addEventListener('keydown', e => { if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) down(e); });
  btn.addEventListener('keyup', e => { if (e.key === ' ' || e.key === 'Enter') reset(); });
  btn.addEventListener('contextmenu', e => e.preventDefault());
}
function openCountdown() {
  if (sos) return;
  try { navigator.vibrate && navigator.vibrate(80); } catch (e) { /* ignore */ }
  sos = { key: newKey(), type: 'Urgence', sendAt: Date.now() + 5000 };
  sos.posPromise = locate(8000);
  const ov = $('#overlay'); ov.className = ''; ov.hidden = false;
  ov.innerHTML = '<div class="ov"><p class="eyebrow" style="color:inherit;opacity:.85">Alerte en préparation</p><div class="cd-num" id="cdNum" aria-live="assertive">5</div>' +
    '<p style="text-align:center;font-weight:700">Envoi automatique à vos contacts dans quelques secondes.</p>' +
    '<div class="chips" role="group" aria-label="Type d’alerte">' + TYPES.map(t => '<button type="button" class="chip" data-act="sosType" data-v="' + esc(t) + '" aria-pressed="' + (t === 'Urgence') + '">' + esc(t) + '</button>').join('') + '</div>' +
    '<label class="f" style="color:inherit">Précision facultative<textarea id="cdComment" maxlength="500" placeholder="Lieu, situation, ce dont vous avez besoin"></textarea></label>' +
    '<div class="btns"><button type="button" class="btn white block" data-act="sosNow">Envoyer maintenant</button><button type="button" class="btn outline block" data-act="sosCancel">Annuler l’alerte</button></div>' +
    '<p class="small" style="opacity:.9">Danger immédiat : appelez le <b>17</b>, le <b>15</b> ou le <b>112</b>.</p></div>';
  ov.querySelector('[data-act="sosCancel"]').focus();
  sos.timer = setInterval(() => { if (!sos) return; const left = sos.sendAt - Date.now(); const el = $('#cdNum'); if (el) el.textContent = String(Math.max(0, Math.ceil(left / 1000))); if (left <= 0) sendSos(); }, 200);
}
function cancelSos() { if (!sos) return; clearInterval(sos.timer); sos = null; $('#overlay').hidden = true; toast('Alerte annulée. Rien n’a été envoyé.'); }
async function sendSos() {
  if (!sos || sos.sending) return;
  sos.sending = true; clearInterval(sos.timer);
  const c = $('#cdComment'); const comment = c ? c.value.trim().slice(0, 500) : '';
  const el = $('#cdNum'); if (el) { el.style.fontSize = '2rem'; el.textContent = 'Localisation…'; }
  const cur = sos; sos = null;
  let pos = await Promise.race([cur.posPromise, new Promise(r => setTimeout(() => r(null), 3000))]);
  if (!pos && S.lastPos && Date.now() - S.lastPos.measuredAt < 24 * 3600000) pos = Object.assign({}, S.lastPos, { stale: true });
  // L'alerte est mise en file locale AVANT l'appel réseau : elle survit à un rechargement ou une coupure.
  store.set('pendingSos', { key: cur.key, body: { type: cur.type, comment, position: pos }, at: Date.now() });
  await flushSos(true);
}
let sosRetry = 0;
async function flushSos(fromUser) {
  const p = pendingSos(); if (!p) return;
  if (fromUser) showSending();
  try {
    const r = await api('POST', '/api/alerts', p.body, { 'Idempotency-Key': p.key });
    store.del('pendingSos'); clearTimeout(sosRetry);
    S.alerts.unshift(r.alert); showSent(r.alert); startAlertFollow(r.alert.id);
  } catch (e) {
    if (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) { store.del('pendingSos'); toast(e.message); $('#overlay').hidden = true; return; }
    showSending(true); clearTimeout(sosRetry); sosRetry = setTimeout(() => flushSos(false), 4000);
  }
}
function showSending(failed) {
  const ov = $('#overlay'); ov.className = ''; ov.hidden = false;
  ov.innerHTML = '<div class="ov"><p class="eyebrow" style="color:inherit">Alerte</p><h1 style="font-size:1.8rem">' + (failed ? 'Pas de réseau : nouvel essai automatique' : 'Envoi en cours…') + '</h1>' +
    (failed ? '<p>L’alerte est gardée sur ce téléphone et partira dès que le serveur répond. Ne fermez pas l’application.</p>' : '') +
    '<div class="numbers">' + [['17', 'Police'], ['15', 'SAMU'], ['112', 'Europe']].map(x => '<a class="num" style="background:transparent;border-color:rgba(255,255,255,.6);color:inherit" href="tel:' + x[0] + '"><b>' + x[0] + '</b><span style="color:inherit">' + x[1] + '</span></a>').join('') + '</div>' +
    (failed ? '<button type="button" class="btn outline" data-act="abandonSos">Abandonner cette alerte</button>' : '') + '</div>';
}
function showSent(a) {
  sentAlertId = a.id;
  const ov = $('#overlay'); ov.className = 'calm'; ov.hidden = false;
  const st = AS[a.status];
  ov.innerHTML = '<div class="ov"><div class="stack"><p class="eyebrow">Alerte ' + esc(a.ref) + ' enregistrée à ' + fmtT(a.createdAt) + '</p><h1 style="font-size:1.6rem">' + esc(a.type) + '</h1><div><span class="pill ' + st[1] + '">' + esc(st[0]) + '</span></div></div>' +
    '<div class="card">' + recipientsHtml(a) + '</div><div class="card"><h3>Position transmise</h3>' + posBlock(a.position, ts(a.createdAt), 'à l’envoi') + '<p class="small muted">Tant que l’alerte est ouverte et l’application affichée, votre position est mise à jour pour vos contacts.</p></div>' + numbersHtml() +
    '<div class="btns"><button type="button" class="btn danger" data-act="closeAlertAsk" data-id="' + a.id + '">Je suis en sécurité</button><button type="button" class="btn" data-act="closeOverlay">Fermer</button></div></div>';
}
// Suivi d'une alerte ouverte : statut des envois + position mise à jour
function startAlertFollow(id) {
  clearInterval(alertPoll);
  alertPoll = setInterval(async () => {
    try {
      const r = await api('GET', '/api/alerts/' + id);
      const i = S.alerts.findIndex(a => a.id === id); if (i >= 0) Object.assign(S.alerts[i], { status: r.alert.status });
      if (sentAlertId === id && !$('#overlay').hidden) showSent(r.alert);
      if (sheetAlertId === id && !$('#sheetWrap').hidden) renderAlertSheet(r.alert);
      if (r.alert.status === 'cloturee') stopAlertFollow();
    } catch (e) { /* réessai au prochain tour */ }
  }, 4000);
  if ('geolocation' in navigator && alertWatch === null) {
    alertWatch = navigator.geolocation.watchPosition(p => {
      const pos = fromCoords(p); S.lastPos = pos; store.set('lastPos', pos); S.gps = 'ok';
      if (Date.now() - alertPosLast < 30000) return; alertPosLast = Date.now();
      api('POST', '/api/alerts/' + id + '/positions', { position: pos }).catch(e => { if (e.status === 409) stopAlertFollow(); });
    }, () => { /* sans GPS : rien à envoyer */ }, { enableHighAccuracy: true, maximumAge: 15000, timeout: 30000 });
  }
}
function stopAlertFollow() { clearInterval(alertPoll); alertPoll = 0; if (alertWatch !== null) { try { navigator.geolocation.clearWatch(alertWatch); } catch (e) { /* ignore */ } alertWatch = null; } }

/* ================= Détail d'alerte ================= */
let sheetAlertId = null;
async function openAlert(id) {
  sheetAlertId = id; openSheet('<p class="muted">Chargement…</p>');
  try { const r = await api('GET', '/api/alerts/' + id); renderAlertSheet(r.alert); if (r.alert.status !== 'cloturee') startAlertFollow(id); }
  catch (e) { openSheet('<p class="err-box">' + esc(e.message) + '</p>'); }
}
function renderAlertSheet(a) {
  const st = AS[a.status];
  openSheet('<p class="eyebrow">' + esc(a.ref) + ' · ' + fmtD(a.createdAt) + '</p><h2 id="sheetTitle">' + esc(a.type) + '</h2><div class="row"><span class="pill ' + st[1] + '">' + esc(st[0]) + '</span>' + (a.origin === 'tracking' ? '<span class="pill info">Déclenchée par un trajet</span>' : '') + '</div>' +
    (a.comment ? '<p>' + esc(a.comment) + '</p>' : '') + '<div class="card">' + posBlock(a.position, null, 'dernière connue') + '</div>' + recipientsHtml(a) +
    (a.status !== 'cloturee' ? '<button type="button" class="btn danger" data-act="closeAlertAsk" data-id="' + a.id + '">Je suis en sécurité, clôturer l’alerte</button>' : '<p class="small muted">Clôturée le ' + fmtD(a.closedAt) + '. Vos contacts ont été prévenus.</p>'));
}

/* ================= Trajet : collecte GPS et file d'envoi ================= */
let tripWatch = null, tripFlushT = 0, tripPollT = 0;
const pointQueue = () => store.get('pointQueue', []);
function syncTripWatch() {
  const t = S.trip;
  if (t && tripWatch === null && 'geolocation' in navigator) {
    tripWatch = navigator.geolocation.watchPosition(p => {
      const pos = fromCoords(p); S.lastPos = pos; S.gps = 'ok'; store.set('lastPos', pos);
      const q = pointQueue(); const last = q[q.length - 1];
      if (!last || pos.measuredAt - last.measuredAt >= 15000) { q.push(Object.assign({ tripId: t.id }, pos)); store.set('pointQueue', q.slice(-500)); if (!t.points.length && q.length === 1) flushPoints(); }
      renderHeader();
    }, err => { S.gps = err.code === 1 ? 'denied' : 'error'; renderHeader(); }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
    clearInterval(tripFlushT); tripFlushT = setInterval(flushPoints, 20000);
    clearInterval(tripPollT); tripPollT = setInterval(async () => { try { const prev = S.trip && S.trip.status; await refreshTrip(); if ((S.trip && S.trip.status) !== prev || tab === 'trip') render(); } catch (e) { /* hors ligne */ } }, 15000);
  }
  if (!t) { if (tripWatch !== null) { try { navigator.geolocation.clearWatch(tripWatch); } catch (e) { /* ignore */ } tripWatch = null; } clearInterval(tripFlushT); clearInterval(tripPollT); store.del('pointQueue'); }
}
async function flushPoints() {
  const q = pointQueue(); if (!q.length || !S.trip) return;
  const batch = q.filter(p => p.tripId === S.trip.id).slice(0, 200);
  try {
    const r = await api('POST', '/api/trips/' + S.trip.id + '/points', { points: batch });
    const sent = new Set(batch.map(p => p.measuredAt));
    store.set('pointQueue', pointQueue().filter(p => !sent.has(p.measuredAt) && p.tripId === S.trip.id));
    if (r.status && !['actif', 'grace'].includes(r.status)) { await refreshTrip(); render(); }
  } catch (e) { /* on garde la file, nouvel essai plus tard */ }
}
function drawTrack() {
  const cv = $('#trackCanvas'), t = S.trip; if (!cv || !t) return;
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; if (!w) return;
  cv.width = w * dpr; cv.height = h * dpr; const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const cs = getComputedStyle(document.documentElement), col = n => cs.getPropertyValue(n).trim();
  const pts = t.points.concat(pointQueue().filter(p => p.tripId === t.id).map(p => ({ lat: p.lat, lng: p.lng, t: p.measuredAt })));
  g.fillStyle = col('--muted'); g.font = '12px system-ui, sans-serif';
  if (pts.length < 2) { g.fillText(pts.length ? '1 position, en attente de la suivante' : 'En attente de la première position GPS', 12, h / 2); return; }
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  pts.forEach(p => { a = Math.min(a, p.lat); b = Math.max(b, p.lat); c = Math.min(c, p.lng); d = Math.max(d, p.lng); });
  const k = Math.cos((a + b) / 2 * Math.PI / 180), sx = Math.max((d - c) * k, 1e-5), sy = Math.max(b - a, 1e-5), pad = 18, sc = Math.min((w - 2 * pad) / sx, (h - 2 * pad) / sy);
  const ox = (w - sx * sc) / 2, oy = (h - sy * sc) / 2, X = p => ox + (p.lng - c) * k * sc, Y = p => h - oy - (p.lat - a) * sc;
  g.lineWidth = 3; g.lineCap = 'round';
  for (let i = 1; i < pts.length; i++) { const gap = pts[i].t - pts[i - 1].t > 90000; g.strokeStyle = gap ? col('--bad') : col('--accent'); g.setLineDash(gap ? [5, 5] : []); g.beginPath(); g.moveTo(X(pts[i - 1]), Y(pts[i - 1])); g.lineTo(X(pts[i]), Y(pts[i])); g.stroke(); }
  g.setLineDash([]); g.fillStyle = col('--sos'); const L = pts[pts.length - 1]; g.beginPath(); g.arc(X(L), Y(L), 6, 0, 7); g.fill();
}

/* ================= Notifications push ================= */
function b64ToBytes(s) { const p = '='.repeat((4 - s.length % 4) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, ch => ch.charCodeAt(0)); }
async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Notifications non disponibles sur ce navigateur.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications refusées. Modifiez l’autorisation dans les réglages du navigateur.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(S.cfg.vapidPublicKey) });
  await api('POST', '/api/me/push', { subscription: sub.toJSON() });
}

/* ================= Actions ================= */
let lastShareUrl = null, resetToken = null;
const actions = {
  auth: el => showAuth(el.dataset.v),
  tab: el => { tab = el.dataset.v; render(); window.scrollTo(0, 0); },
  sosType: el => { if (!sos) return; sos.type = el.dataset.v; document.querySelectorAll('[data-act="sosType"]').forEach(b => b.setAttribute('aria-pressed', String(b === el))); },
  sosNow: () => sendSos(),
  sosCancel: () => cancelSos(),
  abandonSos: () => { store.del('pendingSos'); clearTimeout(sosRetry); $('#overlay').hidden = true; toast('Alerte abandonnée sur ce téléphone.'); render(); },
  closeOverlay: () => { $('#overlay').hidden = true; sentAlertId = null; render(); },
  closeSheet: () => closeSheet(),
  openAlert: el => { $('#overlay').hidden = true; sentAlertId = null; openAlert(el.dataset.id); },
  closeAlertAsk: el => openSheet('<h2 id="sheetTitle">Clôturer l’alerte ?</h2><p>Vos contacts seront prévenus que vous êtes en sécurité et votre position ne sera plus partagée.</p><div class="btns"><button type="button" class="btn danger" data-act="closeAlert" data-id="' + el.dataset.id + '">Oui, je suis en sécurité</button><button type="button" class="btn" data-act="closeSheet">Non, garder l’alerte</button></div>'),
  closeAlert: async el => { busy(el, true); try { await api('POST', '/api/alerts/' + el.dataset.id + '/close'); stopAlertFollow(); closeSheet(); $('#overlay').hidden = true; await loadAll(); render(); toast('Alerte clôturée. Vos contacts sont prévenus.'); } catch (e) { toast(e.message); busy(el, false); } },
  locate: async () => { toast('Localisation en cours…'); const p = await locate(); if (!p) toast(S.gps === 'denied' ? 'Localisation refusée : autorisez-la dans les réglages du navigateur.' : 'Position indisponible pour le moment.'); render(); },
  share: async el => {
    busy(el, true);
    try {
      const pos = await locate(); if (!pos) throw new Error('Position indisponible : impossible de partager.');
      const r = await api('POST', '/api/shares', { contactId: val('shC'), minutes: Number(val('shM')), position: pos });
      lastShareUrl = r.share.url; S.shares = (await api('GET', '/api/shares')).shares; render(); toast('Lien créé : copiez-le et envoyez-le à ' + r.share.contactName);
    } catch (e) { toast(e.message); busy(el, false); }
  },
  copy: el => { const v = el.dataset.v; const ok = () => toast('Lien copié'); try { navigator.clipboard.writeText(v).then(ok, () => toast('Copie impossible : sélectionnez le lien')); } catch (e) { toast('Copie impossible : sélectionnez le lien'); } },
  revokeShare: async el => { try { await api('DELETE', '/api/shares/' + el.dataset.id); lastShareUrl = null; S.shares = (await api('GET', '/api/shares')).shares; render(); toast('Lien révoqué.'); } catch (e) { toast(e.message); } },
  startTrip: async btn => {
    const ids = Array.from(document.querySelectorAll('.tC:checked')).map(i => i.value);
    if (!ids.length) throw new Error('Choisissez au moins un contact.');
    if (!$('#tOk').checked) throw new Error('Acceptez la collecte de position pour démarrer.');
    const r = await api('POST', '/api/trips', { label: val('tLabel'), minutes: Number(val('tMin')), graceMinutes: Number(val('tGrace')), contactIds: ids, consent: true });
    S.trip = r.trip; syncTripWatch(); render();
    // Premier point envoyé tout de suite : si le téléphone s'éteint ensuite, l'alerte aura au moins cette position.
    locate().then(p => { if (p && S.trip) { const q = pointQueue(); q.push(Object.assign({ tripId: S.trip.id }, p)); store.set('pointQueue', q); flushPoints().then(() => refreshTrip()).then(() => { if (tab === 'trip') render(); }); } }); toast('Suivi démarré. Échéance à ' + fmtHM(r.trip.deadlineAt));
    if ('Notification' in window && Notification.permission === 'default' && S.cfg.vapidPublicKey) enablePush().catch(() => {});
  },
  arrived: async el => { busy(el, true); try { await flushPoints(); await api('POST', '/api/trips/' + S.trip.id + '/finish', { kind: 'termine' }); await refreshTrip(); render(); toast('Arrivée confirmée. Suivi arrêté, aucune alerte envoyée.'); } catch (e) { toast(e.message); await refreshTrip(); render(); } },
  stopTrip: async el => { busy(el, true); try { await api('POST', '/api/trips/' + S.trip.id + '/finish', { kind: 'arrete' }); await refreshTrip(); render(); toast('Suivi arrêté. La collecte GPS est coupée.'); } catch (e) { toast(e.message); await refreshTrip(); render(); } },
  extend: async el => { busy(el, true); try { const r = await api('POST', '/api/trips/' + S.trip.id + '/extend', { minutes: Number(el.dataset.v) }); S.trip = r.trip; render(); toast('Échéance repoussée à ' + fmtHM(r.trip.deadlineAt)); } catch (e) { toast(e.message); busy(el, false); } },
  invite: async () => { await api('POST', '/api/contacts', { name: val('cName'), email: val('cMail') }); S.contacts = (await api('GET', '/api/contacts')).contacts; $('#view').dataset.tab = ''; document.activeElement.blur(); render(); toast('Invitation envoyée par e-mail.'); },
  resend: async el => { busy(el, true); try { await api('POST', '/api/contacts/' + el.dataset.id + '/resend'); S.contacts = (await api('GET', '/api/contacts')).contacts; render(); toast('Invitation renvoyée, valable 72 h.'); } catch (e) { toast(e.message); busy(el, false); } },
  removeAsk: el => { const c = S.contacts.find(x => x.id === el.dataset.id); openSheet('<h2 id="sheetTitle">Retirer ' + esc(c ? c.name : 'ce contact') + ' ?</h2><p>Il ne recevra plus vos alertes et ses liens de partage actifs sont révoqués immédiatement.</p><div class="btns"><button type="button" class="btn danger" data-act="remove" data-id="' + el.dataset.id + '">Retirer</button><button type="button" class="btn" data-act="closeSheet">Annuler</button></div>'); },
  remove: async el => { try { await api('DELETE', '/api/contacts/' + el.dataset.id); closeSheet(); S.contacts = (await api('GET', '/api/contacts')).contacts; render(); toast('Contact retiré.'); } catch (e) { toast(e.message); } },
  resendVerify: async () => { try { await api('POST', '/api/auth/resend-verification'); toast('E-mail de confirmation renvoyé.'); } catch (e) { toast(e.message); } },
  saveProfile: async el => { busy(el, true); try { await api('PATCH', '/api/me', { name: val('pName') }); S.me = (await api('GET', '/api/me')).me; toast('Profil enregistré.'); } catch (e) { toast(e.message); } busy(el, false); },
  enablePush: async el => { busy(el, true); try { await enablePush(); toast('Notifications activées sur cet appareil.'); } catch (e) { toast(e.message); } busy(el, false); render(); },
  export: async el => {
    busy(el, true);
    try {
      const data = await api('GET', '/api/me/export');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      a.download = 'sosalert-mes-donnees-' + new Date().toISOString().slice(0, 10) + '.json'; document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { toast(e.message); }
    busy(el, false);
  },
  deleteAsk: () => openSheet('<h2 id="sheetTitle">Supprimer mon compte</h2><p>Alertes, trajets, positions, contacts et partages seront effacés définitivement. Vos contacts ne recevront plus rien.</p><form class="stack" id="fDelete"><label class="f">Mot de passe pour confirmer<input type="password" id="dPass" autocomplete="current-password" required style="width:100%;border:1px solid var(--line);background:var(--bg);border-radius:10px;padding:10px 12px;min-height:44px"></label><button type="submit" class="btn danger">Supprimer définitivement</button></form>'),
  deleteAccount: async () => { await api('DELETE', '/api/me', { password: $('#dPass').value }); closeSheet(); store.del('lastPos'); store.del('pointQueue'); S.me = null; stopAllTimers(); showAuth('login', { ok: 'Compte supprimé. Toutes vos données ont été effacées.' }); },
  logout: async () => { try { await api('POST', '/api/auth/logout'); } catch (e) { /* ignore */ } S.me = null; stopAllTimers(); showAuth('login'); },
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el || el.tagName === 'INPUT') return;
  const fn = actions[el.dataset.act]; if (fn) fn(el);
});
document.addEventListener('change', async e => {
  const el = e.target;
  if (el.dataset.act === 'perm') { try { await api('PATCH', '/api/contacts/' + el.dataset.id, { receivesAlerts: el.checked }); const c = S.contacts.find(x => x.id === el.dataset.id); if (c) c.receivesAlerts = el.checked; } catch (err) { el.checked = !el.checked; toast(err.message); } }
});
document.addEventListener('toggle', async e => {
  if (e.target.id !== 'actDetails' || !e.target.open) return;
  try { const r = await api('GET', '/api/me/activity'); $('#actList').innerHTML = r.activity.map(x => '<div class="item"><div class="grow"><div class="mono small">' + esc(x.action) + '</div><div class="small muted" style="overflow-wrap:anywhere">' + esc(x.ref || '') + (x.actor !== 'utilisateur' ? ' · ' + esc(x.actor) : '') + '</div></div><span class="small muted mono">' + fmtD(x.at) + '</span></div>').join('') || '<p class="muted">Aucune activité.</p>'; } catch (err) { toast(err.message); }
}, true);
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => { tab = b.dataset.tab; render(); window.scrollTo(0, 0); }));
$('#gpsPill').addEventListener('click', () => { if (S.trip) { tab = 'trip'; render(); } else actions.locate(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!$('#sheetWrap').hidden) closeSheet(); else if (sos) cancelSos(); } });
window.addEventListener('online', () => { renderHeader(); flushSos(false); flushPoints(); });
window.addEventListener('offline', renderHeader);
window.addEventListener('resize', () => { if (tab === 'trip') drawTrack(); });
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !S.me) return;
  try { await loadAll(); syncTripWatch(); flushPoints(); render(); } catch (e) { /* hors ligne */ }
});

/* ================= Démarrage ================= */
let tickT = 0, bgT = 0;
function stopAllTimers() { clearInterval(tickT); clearInterval(bgT); stopAlertFollow(); S.trip = null; syncTripWatch(); }
async function startApp() {
  $('#topbar').hidden = false; $('#tabs').hidden = false;
  await loadAll();
  syncTripWatch();
  if (pendingSos()) flushSos(true);
  const open = openAlerts()[0]; if (open) startAlertFollow(open.id);
  render();
  clearInterval(tickT); tickT = setInterval(() => { tickLabels(); const e = $('#stLast'); if (e && S.trip && S.trip.points.length) e.textContent = ago(now() - S.trip.points[S.trip.points.length - 1].t).replace('il y a ', ''); }, 1000);
  clearInterval(bgT); bgT = setInterval(async () => { if (document.visibilityState !== 'visible') return; try { await loadAll(); render(); } catch (e) { /* ignore */ } }, 60000);
  if (S.gps === 'unknown' && navigator.permissions) { try { const st = await navigator.permissions.query({ name: 'geolocation' }); if (st.state === 'granted') locate(); else if (st.state === 'denied') { S.gps = 'denied'; renderHeader(); } } catch (e) { /* ignore */ } }
}
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  try { S.cfg = await api('GET', '/api/config'); } catch (e) { $('#view').innerHTML = '<div class="auth"><p class="err-box">Serveur injoignable. Vérifiez votre connexion.</p>' + numbersHtml() + '</div>'; setTimeout(boot, 5000); return; }
  const m = /^\/(v|r)\/([A-Za-z0-9_-]{20,100})$/.exec(location.pathname);
  if (m && m[1] === 'v') {
    try { await api('POST', '/api/auth/verify', { token: m[2] }); history.replaceState(null, '', '/'); toast('Adresse confirmée. Vous pouvez inviter vos contacts.'); }
    catch (e) { history.replaceState(null, '', '/'); toast(e.message); }
  }
  if (m && m[1] === 'r') { resetToken = m[2]; showAuth('reset'); return; }
  try { S.me = (await api('GET', '/api/me')).me; await startApp(); }
  catch (e) { if (e.status === 401) showAuth(pendingSos() ? 'login' : 'register'); else { $('#view').innerHTML = '<div class="auth"><p class="err-box">' + esc(e.message) + '</p></div>'; setTimeout(boot, 5000); } }
}
boot();
})();

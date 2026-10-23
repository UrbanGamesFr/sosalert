(function () {
'use strict';
// Pages des contacts de confiance : invitation (/i/), alerte (/a/), partage de position (/p/). Aucun compte requis.
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const t = d => new Date(d).getTime();
const fmtT = d => new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtD = d => new Date(d).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
function ago(ms) { const s = Math.round(ms / 1000); if (s < 60) return 'il y a ' + s + ' s'; const m = Math.round(s / 60); if (m < 60) return 'il y a ' + m + ' min'; return 'il y a ' + Math.round(m / 60) + ' h'; }
let skew = 0; const now = () => Date.now() + skew;
let toastT = 0; function toast(m) { const e = $('#toast'); e.textContent = m; e.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => e.classList.remove('show'), 3500); }

const m = /^\/([aip])\/([A-Za-z0-9_-]{20,100})$/.exec(location.pathname);
const kind = m && m[1], token = m && m[2];

async function api(method, path, body) {
  let res;
  try { res = await fetch(path, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch (e) { throw new Error('Pas de connexion. Nouvel essai automatique.'); }
  let data = null; try { data = await res.json(); } catch (e) { /* vide */ }
  if (!res.ok) { const err = new Error((data && data.message) || 'Erreur ' + res.status); err.status = res.status; throw err; }
  if (data && data.serverNow) skew = data.serverNow - Date.now();
  return data;
}
function numbers() {
  const n = [['17', 'Police'], ['15', 'SAMU'], ['18', 'Pompiers'], ['112', 'Europe'], ['114', 'SMS']];
  return '<div class="card"><h3>Si la personne est en danger</h3><p class="small">Appelez les secours et donnez-leur la position ci-dessus.</p><div class="numbers">' + n.map(x => '<a class="num" href="' + (x[0] === '114' ? 'sms:114' : 'tel:' + x[0]) + '"><b>' + x[0] + '</b><span>' + x[1] + '</span></a>').join('') + '</div></div>';
}
function posHtml(p, title) {
  if (!p) return '<div class="card"><h3>' + title + '</h3><span class="pill bad">Position indisponible</span><p class="small muted">Le téléphone n’a pas pu se localiser au moment de l’envoi.</p></div>';
  const age = now() - t(p.measured_at);
  const cls = age > 600000 ? 'bad' : (p.accuracy > 100 || age > 60000) ? 'warn' : 'ok';
  const label = age > 600000 ? 'Mesurée ' + ago(age) + ', peut avoir changé' : 'Mesurée ' + ago(age) + ', précision ±' + p.accuracy + ' m';
  const la = p.lat.toFixed(6), lo = p.lng.toFixed(6);
  return '<div class="card"><h3>' + title + '</h3><div class="coords mono">' + p.lat.toFixed(5) + ', ' + p.lng.toFixed(5) + '</div>' +
    '<div class="pos-meta"><span class="pill ' + cls + '">' + esc(label) + '</span><span>à ' + fmtT(p.measured_at) + '</span>' + (p.stale ? '<span>(dernière position connue du téléphone)</span>' : '') + '</div>' +
    '<div class="btns"><a class="btn primary" href="https://www.openstreetmap.org/?mlat=' + la + '&mlon=' + lo + '#map=17/' + la + '/' + lo + '" target="_blank" rel="noopener">Voir sur une carte</a>' +
    '<a class="btn" href="https://www.google.com/maps/dir/?api=1&destination=' + la + ',' + lo + '" target="_blank" rel="noopener">Itinéraire</a>' +
    '<button type="button" class="btn" data-copy="' + p.lat.toFixed(6) + ', ' + p.lng.toFixed(6) + '">Copier les coordonnées</button></div></div>';
}
document.addEventListener('click', e => {
  const c = e.target.closest('[data-copy]');
  if (c) { try { navigator.clipboard.writeText(c.dataset.copy).then(() => toast('Coordonnées copiées'), () => toast('Copie impossible')); } catch (_) { toast('Copie impossible'); } }
});

/* ---------- Notifications sur ce navigateur ---------- */
function b64ToBytes(s) { const p = '='.repeat((4 - s.length % 4) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, ch => ch.charCodeAt(0)); }
const pushAvailable = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
async function subscribe(path) {
  const cfg = await api('GET', '/api/config');
  if (!cfg.vapidPublicKey) throw new Error('Notifications non configurées sur le serveur.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications refusées par le navigateur.');
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(cfg.vapidPublicKey) });
  await api('POST', path, { subscription: sub.toJSON() });
}
function pushBlock(path) {
  if (!pushAvailable()) {
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    return '<p class="note">' + (ios ? 'Sur iPhone, les notifications nécessitent d’ajouter cette page à l’écran d’accueil (Partager, puis « Sur l’écran d’accueil »). Sinon, les alertes arrivent par e-mail.' : 'Ce navigateur ne permet pas les notifications. Les alertes arrivent par e-mail.') + '</p>';
  }
  return '<button type="button" class="btn" id="btnPush" data-path="' + esc(path) + '">Recevoir aussi les alertes en notification sur ce téléphone</button>';
}
document.addEventListener('click', async e => {
  const b = e.target.closest('#btnPush'); if (!b) return;
  b.disabled = true;
  try { await subscribe(b.dataset.path); b.outerHTML = '<p class="ok-box">Notifications activées sur ce navigateur.</p>'; }
  catch (err) { toast(err.message); b.disabled = false; }
});

/* ---------- Invitation ---------- */
async function invite() {
  let d;
  try { d = await api('GET', '/api/public/invite/' + token); }
  catch (e) { return fail(e.message); }
  const v = $('#view');
  if (d.status === 'pending') {
    v.innerHTML = '<div class="card"><p class="eyebrow">Invitation</p><h1 style="font-size:1.5rem">' + esc(d.ownerName) + ' vous choisit comme contact de confiance</h1>' +
      '<p>Si vous acceptez, ' + esc(d.ownerName) + ' pourra vous envoyer une alerte avec sa position en cas de danger, ou s’il n’arrive pas à destination à l’heure prévue.</p>' +
      '<ul class="small" style="margin:0;padding-left:20px"><li>Aucune application à installer : les alertes arrivent par e-mail.</li><li>Vous ne voyez jamais sa position en dehors d’une alerte ou d’un partage qu’il décide.</li><li>Vous pouvez vous désinscrire à tout moment.</li></ul>' +
      '<p class="small muted">Votre nom et votre adresse e-mail sont conservés tant que vous restez son contact. Détails : <a class="link" href="/confidentialite.html" target="_blank">politique de confidentialité</a>.</p>' +
      '<div class="btns"><button type="button" class="btn primary" data-ans="accept">J’accepte</button><button type="button" class="btn" data-ans="refuse">Je refuse</button></div></div>';
  } else if (d.status === 'active') {
    v.innerHTML = '<div class="hero calm"><h1>Vous êtes contact de confiance de ' + esc(d.ownerName) + '</h1><p>Vous recevrez ses alertes par e-mail.</p></div>' +
      '<div class="card"><h3>Être prévenu plus vite</h3><p class="small">Un e-mail peut passer inaperçu. Une notification s’affiche directement sur l’écran.</p>' + pushBlock('/api/public/invite/' + token + '/push') + '</div>' +
      '<div class="card"><p class="small">Vous ne voulez plus recevoir ses alertes ?</p><button type="button" class="btn ghost" style="align-self:flex-start;padding-left:0" data-ans="optout">Me désinscrire</button></div>';
  } else {
    v.innerHTML = '<div class="card"><h1 style="font-size:1.4rem">Réponse enregistrée</h1><p>Vous ne recevrez aucune alerte de ' + esc(d.ownerName) + '.</p></div>';
  }
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-ans]'); if (!b) return;
  if (b.dataset.ans === 'optout' && b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Confirmer la désinscription'; b.classList.add('danger'); b.classList.remove('ghost'); return; }
  b.disabled = true;
  try { await api('POST', '/api/public/invite/' + token + '/' + b.dataset.ans); await invite(); window.scrollTo(0, 0); }
  catch (err) { toast(err.message); b.disabled = false; }
});

/* ---------- Alerte ---------- */
let pollT = 0, lastData = null;
async function alertPage(first) {
  let d;
  try { d = await api('GET', '/api/public/alert/' + token); }
  catch (e) { if (first || e.status === 404) { clearInterval(pollT); return fail(e.message); } toast(e.message); return; }
  lastData = d;
  const closed = d.status === 'cloturee', p = d.positions[0];
  document.title = closed ? 'Alerte clôturée' : 'ALERTE ' + d.ownerName;
  let h = closed
    ? '<div class="hero calm"><p class="eyebrow" style="color:inherit">Alerte ' + esc(d.ref) + ' clôturée</p><h1>' + esc(d.ownerName) + ' indique être en sécurité</h1><p>Clôturée ' + esc(fmtD(d.closedAt)) + '.</p></div>'
    : '<div class="hero"><p class="eyebrow" style="color:inherit;opacity:.9">' + (d.origin === 'tracking' ? 'Trajet non confirmé' : 'Alerte SOS') + ' · ' + esc(d.ref) + '</p><h1>' + esc(d.ownerName) + ' a besoin d’aide</h1><p><b>' + esc(d.type) + '</b>, ' + esc(fmtD(d.createdAt)) + '</p>' + (d.comment ? '<p>« ' + esc(d.comment) + ' »</p>' : '') + '</div>';
  if (!closed) {
    h += d.ackedAt ? '<p class="ok-box">Vous avez indiqué avoir vu l’alerte à ' + fmtT(d.ackedAt) + '. ' + esc(d.ownerName) + ' le voit.</p>'
      : '<button type="button" class="btn danger block" id="btnAck" style="min-height:56px;font-size:1.1rem">J’ai vu l’alerte, je m’en occupe</button>';
  }
  h += posHtml(p, closed ? 'Dernière position connue' : 'Position');
  if (d.positions.length > 1) h += '<details class="card"><summary style="cursor:pointer;font-weight:700">Positions précédentes (' + (d.positions.length - 1) + ')</summary><div class="list hist" style="margin-top:8px">' + d.positions.slice(1).map(x => '<div class="item"><span class="mono small">' + x.lat.toFixed(5) + ', ' + x.lng.toFixed(5) + '</span><span class="small muted">' + fmtT(x.measured_at) + ' · ±' + x.accuracy + ' m</span></div>').join('') + '</div></details>';
  if (!closed) h += numbers() + '<p class="small muted center">Page mise à jour automatiquement toutes les 15 secondes.</p>';
  if (d.canSubscribe) h += '<div class="card"><h3>Notifications</h3>' + pushBlock('/api/public/alert/' + token + '/push') + '</div>';
  h += '<div class="card"><p class="small">Ne plus recevoir les alertes de ' + esc(d.ownerName) + ' :</p><button type="button" class="btn ghost" style="align-self:flex-start;padding-left:0" id="btnOptout">Me désinscrire</button></div>';
  const v = $('#view'); const y = window.scrollY; v.innerHTML = h; window.scrollTo(0, y);
  if (closed) clearInterval(pollT);
}
document.addEventListener('click', async e => {
  if (e.target.closest('#btnAck')) {
    const b = e.target.closest('#btnAck'); b.disabled = true;
    try { await api('POST', '/api/public/alert/' + token + '/ack'); await alertPage(); } catch (err) { toast(err.message); b.disabled = false; }
  }
  if (e.target.closest('#btnOptout')) {
    const b = e.target.closest('#btnOptout');
    if (b.dataset.confirm !== '1') { b.dataset.confirm = '1'; b.textContent = 'Confirmer : je ne recevrai plus aucune alerte'; b.classList.add('danger'); b.classList.remove('ghost'); return; }
    try { await api('POST', '/api/public/alert/' + token + '/optout'); toast('Désinscription enregistrée.'); b.outerHTML = '<p class="ok-box">Vous ne recevrez plus d’alertes de cette personne.</p>'; } catch (err) { toast(err.message); }
  }
});

/* ---------- Partage ponctuel ---------- */
async function sharePage() {
  let d;
  try { d = await api('GET', '/api/public/share/' + token); } catch (e) { return fail(e.message); }
  $('#view').innerHTML = '<div class="card"><p class="eyebrow">Position partagée</p><h1 style="font-size:1.4rem">' + esc(d.ownerName) + ' vous partage sa position</h1><p class="small muted">Position ponctuelle, pas un suivi en direct. Le lien expire ' + esc(fmtD(d.expiresAt)) + '.</p></div>' + posHtml(d.position, 'Position');
}

function fail(msg) {
  $('#view').innerHTML = '<div class="card"><h1 style="font-size:1.3rem">Lien indisponible</h1><p>' + esc(msg) + '</p></div>' + numbers().replace('ci-dessus', 'que vous connaissez');
}

if (!kind) fail('Adresse incomplète.');
else if (kind === 'i') invite();
else if (kind === 'p') sharePage();
else { alertPage(true); pollT = setInterval(() => { if (document.visibilityState === 'visible') alertPage(); }, 15000); document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && lastData && lastData.status !== 'cloturee') alertPage(); }); }
})();

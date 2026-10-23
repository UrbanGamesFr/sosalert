'use strict';
// Textes des e-mails et notifications push. Texte brut + HTML minimal (lisible partout).

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = d => new Date(d).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fmtHM = d => new Date(d).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });

const FOOT = 'SOSAlert ne remplace pas les services d’urgence. En cas de danger immédiat : 17 (police), 15 (SAMU), 18 (pompiers), 112 (urgence européenne), 114 (SMS).';

function html(title, lines, button, accent = '#d6331f') {
  const body = lines.map(l => `<p style="margin:0 0 12px;font-size:16px;line-height:1.5">${l}</p>`).join('');
  const btn = button ? `<p style="margin:20px 0"><a href="${esc(button.url)}" style="display:inline-block;background:${accent};color:#fff;text-decoration:none;font-weight:bold;padding:14px 22px;border-radius:10px;font-size:16px">${esc(button.label)}</a></p><p style="font-size:13px;color:#586073;word-break:break-all">${esc(button.url)}</p>` : '';
  return `<!doctype html><html lang="fr"><body style="margin:0;padding:24px;background:#f2f3f6;font-family:Arial,Helvetica,sans-serif;color:#141722"><div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;padding:24px"><h1 style="font-size:22px;margin:0 0 16px">${esc(title)}</h1>${body}${btn}<p style="font-size:12px;color:#586073;margin-top:24px;border-top:1px solid #dde1ea;padding-top:12px">${esc(FOOT)}</p></div></body></html>`;
}

function mapsUrl(p) {
  return `https://www.openstreetmap.org/?mlat=${p.lat.toFixed(6)}&mlon=${p.lng.toFixed(6)}#map=17/${p.lat.toFixed(6)}/${p.lng.toFixed(6)}`;
}

function posLines(p) {
  if (!p) return ['Position : indisponible au moment de l’envoi.'];
  const age = Math.round((Date.now() - new Date(p.measured_at).getTime()) / 60000);
  return [`Position (précision ±${p.accuracy} m), mesurée le ${fmt(p.measured_at)}${age > 10 ? ` (il y a ${age} min, peut avoir changé)` : ''}.`,
    `Carte : ${mapsUrl(p)}`];
}

module.exports = {
  verify({ name, link }) {
    return {
      subject: 'Confirmez votre adresse e-mail SOSAlert',
      text: `Bonjour ${name},\n\nConfirmez votre adresse pour activer l'envoi d'alertes :\n${link}\n\nCe lien expire dans 48 heures. Si vous n'êtes pas à l'origine de cette inscription, ignorez ce message.\n\n${FOOT}`,
      html: html('Confirmez votre adresse', [`Bonjour ${esc(name)},`, 'Confirmez votre adresse pour pouvoir inviter vos contacts et envoyer des alertes. Ce lien expire dans 48 heures.'], { url: link, label: 'Confirmer mon adresse' }, '#1e4fd4'),
    };
  },
  reset({ name, link }) {
    return {
      subject: 'Réinitialisation de votre mot de passe SOSAlert',
      text: `Bonjour ${name},\n\nPour choisir un nouveau mot de passe :\n${link}\n\nCe lien expire dans 1 heure. Si vous n'avez rien demandé, ignorez ce message : votre mot de passe reste inchangé.`,
      html: html('Nouveau mot de passe', [`Bonjour ${esc(name)},`, 'Ce lien expire dans 1 heure. Si vous n’avez rien demandé, ignorez ce message.'], { url: link, label: 'Choisir un nouveau mot de passe' }, '#1e4fd4'),
    };
  },
  invite({ ownerName, contactName, link }) {
    return {
      subject: `${ownerName} vous choisit comme contact de confiance sur SOSAlert`,
      text: `Bonjour ${contactName},\n\n${ownerName} souhaite pouvoir vous prévenir en cas de danger, avec sa position. Vous n'avez pas besoin d'installer d'application : les alertes arrivent par e-mail et, si vous l'activez, par notification sur votre navigateur.\n\nAccepter ou refuser :\n${link}\n\nSans réponse, l'invitation expire dans 72 heures et aucune alerte ne vous sera envoyée.\n\n${FOOT}`,
      html: html(`${ownerName} vous choisit comme contact de confiance`, [`Bonjour ${esc(contactName)},`, `${esc(ownerName)} souhaite pouvoir vous prévenir en cas de danger, avec sa position.`, 'Aucune application à installer. Sans réponse, l’invitation expire dans 72 heures.'], { url: link, label: 'Répondre à l’invitation' }, '#1e4fd4'),
    };
  },
  alert({ ownerName, alert, pos, link }) {
    const comment = alert.comment ? `Message : « ${alert.comment} »` : null;
    const lines = [`ALERTE ${alert.type.toUpperCase()} envoyée par ${ownerName} le ${fmt(alert.created_at)}.`, comment, ...posLines(pos), '', `Suivre l'alerte et indiquer que vous l'avez vue :\n${link}`].filter(l => l !== null);
    return {
      subject: `ALERTE : ${ownerName} a besoin d'aide (${alert.type})`,
      text: lines.join('\n') + `\n\nSi vous pensez que ${ownerName} est en danger, appelez le 17 ou le 112 en donnant cette position.\n\n${FOOT}`,
      html: html(`${ownerName} a déclenché une alerte`, [
        `<b>${esc(alert.type)}</b>, le ${esc(fmt(alert.created_at))}.`,
        comment ? esc(comment) : null,
        ...posLines(pos).map(esc),
        `Si vous pensez que ${esc(ownerName)} est en danger, appelez le <b>17</b> ou le <b>112</b> en donnant cette position.`,
      ].filter(Boolean), { url: link, label: 'Voir l’alerte et confirmer la lecture' }),
      push: { title: `ALERTE : ${ownerName}`, body: `${alert.type}${alert.comment ? ' : ' + alert.comment.slice(0, 80) : ''}. Touchez pour voir la position.`, url: link, tag: 'alert-' + alert.id, urgent: true },
    };
  },
  alertClosed({ ownerName, alert }) {
    return {
      subject: `${ownerName} a clôturé son alerte`,
      text: `${ownerName} a clôturé l'alerte ${alert.ref} (${alert.type}) le ${fmt(alert.closed_at)} et indique être en sécurité.\n\nLe lien reçu avec l'alerte reste consultable 24 heures.`,
      html: html(`${ownerName} a clôturé son alerte`, [`L’alerte ${esc(alert.ref)} (${esc(alert.type)}) a été clôturée le ${esc(fmt(alert.closed_at))}. ${esc(ownerName)} indique être en sécurité.`, 'Le lien reçu avec l’alerte reste consultable 24 heures.'], null, '#17784a'),
      push: { title: `${ownerName} est en sécurité`, body: `Alerte ${alert.ref} clôturée.`, tag: 'alert-' + alert.id },
    };
  },
  tripReminder({ name, trip, link }) {
    return {
      subject: `Votre trajet se termine à ${fmtHM(trip.deadline_at)}`,
      text: `Bonjour ${name},\n\nVotre trajet suivi arrive à échéance à ${fmtHM(trip.deadline_at)}. Confirmez votre arrivée ou prolongez, sinon vos contacts seront alertés après le délai de grâce.\n\n${link}`,
      html: html('Votre trajet se termine bientôt', [`Échéance à <b>${esc(fmtHM(trip.deadline_at))}</b>. Confirmez votre arrivée ou prolongez, sinon vos contacts seront alertés après le délai de grâce.`], { url: link, label: 'Confirmer ou prolonger' }, '#1e4fd4'),
      push: { title: 'Trajet bientôt terminé', body: `Échéance à ${fmtHM(trip.deadline_at)}. Confirmez votre arrivée ou prolongez.`, url: link, tag: 'trip-' + trip.id, urgent: true },
    };
  },
  tripDeadline({ name, trip, link }) {
    const alertAt = new Date(new Date(trip.deadline_at).getTime() + trip.grace_seconds * 1000);
    return {
      subject: 'Échéance dépassée : confirmez votre arrivée',
      text: `Bonjour ${name},\n\nL'échéance de votre trajet est dépassée. Sans confirmation avant ${fmtHM(alertAt)}, vos contacts recevront une alerte avec votre dernière position.\n\n${link}`,
      html: html('Échéance dépassée', [`Sans confirmation avant <b>${esc(fmtHM(alertAt))}</b>, vos contacts recevront une alerte avec votre dernière position.`], { url: link, label: 'Je suis arrivé(e)' }),
      push: { title: 'Échéance dépassée', body: `Alerte à vos contacts à ${fmtHM(alertAt)} sans confirmation.`, url: link, tag: 'trip-' + trip.id, urgent: true },
    };
  },
};

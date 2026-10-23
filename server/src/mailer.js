'use strict';
// Envoi d'e-mails derrière une interface unique : send({to, subject, text, html}) -> {providerId}
// Passer à un autre prestataire (Brevo, etc.) = remplacer ce fichier.
const nodemailer = require('nodemailer');
const config = require('./config');

const outbox = []; // utilisé en test (MAIL_TRANSPORT=memory)
let transporter = null;

function getTransport() {
  if (transporter) return transporter;
  const m = config.mail;
  if (m.transport === 'smtp') {
    transporter = nodemailer.createTransport({
      host: m.host, port: m.port, secure: m.secure,
      auth: { user: m.user, pass: m.pass },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    });
  } else {
    transporter = nodemailer.createTransport({ jsonTransport: true });
  }
  return transporter;
}

async function send({ to, subject, text, html }) {
  const m = config.mail;
  if (m.transport === 'memory') {
    if (/echec/i.test(to)) throw new Error('Adresse refusée (simulation de test)');
    outbox.push({ to, subject, text, html });
    return { providerId: 'mem-' + outbox.length };
  }
  const info = await getTransport().sendMail({ from: m.from, to, subject, text, html });
  if (m.transport === 'log') console.log(`[e-mail] à ${to} : ${subject}\n${text}\n`);
  return { providerId: info.messageId || null };
}

module.exports = { send, outbox };

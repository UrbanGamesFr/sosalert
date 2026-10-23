'use strict';
// Configuration lue depuis l'environnement. Aucune valeur secrète par défaut en production.

const env = process.env;
const isProd = env.NODE_ENV === 'production';

function required(name) {
  const v = env[name];
  if (!v) throw new Error(`Variable d'environnement manquante : ${name}`);
  return v;
}

const config = {
  isProd,
  port: Number(env.PORT || 3000),
  host: env.HOST || '0.0.0.0',
  publicUrl: (env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
  databaseUrl: isProd ? required('DATABASE_URL') : (env.DATABASE_URL || 'postgres://localhost/sosalert'),
  termsVersion: env.TERMS_VERSION || '2026-10',

  mail: {
    // MAIL_TRANSPORT=smtp en production ; 'log' en dev (affiche les e-mails) ; 'memory' en test
    transport: env.MAIL_TRANSPORT || (isProd ? 'smtp' : 'log'),
    host: env.SMTP_HOST || 'smtp.ionos.fr',
    port: Number(env.SMTP_PORT || 465),
    secure: (env.SMTP_SECURE || 'true') === 'true',
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || 'SOSAlert <alerte@alert.escapegameurbain.com>',
  },

  push: {
    publicKey: env.VAPID_PUBLIC_KEY || '',
    privateKey: env.VAPID_PRIVATE_KEY || '',
    subject: env.VAPID_SUBJECT || 'mailto:alerte@alert.escapegameurbain.com',
  },

  // Durées métier
  sessionDays: 180,
  inviteHours: 72,
  verifyHours: 48,
  resetMinutes: 60,
  alertLinkHoursAfterClose: 24,

  // Conservation (propositions du CDC, à valider juridiquement)
  retention: {
    tripPointsDays: 30,
    alertsDays: 365,
    notificationsDays: 90,
    auditDays: 365,
    sharesDays: 30,
  },
};

module.exports = config;

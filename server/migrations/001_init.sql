-- SOSAlert : schéma initial (phase A)
-- Conventions : horodatages en timestamptz (UTC), jetons stockés uniquement sous forme de hash SHA-256.

CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  password_hash   text NOT NULL,
  display_name    text NOT NULL,
  email_verified_at timestamptz,
  terms_version   text NOT NULL,
  terms_accepted_at timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_uq ON users (lower(email));

CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   bytea NOT NULL UNIQUE,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE email_tokens (
  token_hash  bytea PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('verify','reset')),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);

-- Un contact est une personne invitée par un utilisateur. Elle n'a pas besoin de compte.
CREATE TABLE contacts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id           uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               text NOT NULL,
  email              text NOT NULL,
  status             text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','refused','removed')),
  receives_alerts    boolean NOT NULL DEFAULT true,
  invite_token_hash  bytea UNIQUE,
  invite_expires_at  timestamptz,
  invited_at         timestamptz NOT NULL DEFAULT now(),
  accepted_at        timestamptz,
  ended_at           timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contacts_owner_idx ON contacts (owner_id);
CREATE UNIQUE INDEX contacts_live_uq ON contacts (owner_id, lower(email)) WHERE status IN ('pending','active');

CREATE TABLE push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  contact_id  uuid REFERENCES contacts(id) ON DELETE CASCADE,
  endpoint    text NOT NULL,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz,
  CHECK ((user_id IS NULL) <> (contact_id IS NULL))
);
CREATE UNIQUE INDEX push_user_uq ON push_subscriptions (user_id, endpoint) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX push_contact_uq ON push_subscriptions (contact_id, endpoint) WHERE contact_id IS NOT NULL;

CREATE TABLE trips (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref                   text NOT NULL UNIQUE,
  user_id               uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label                 text,
  status                text NOT NULL DEFAULT 'actif' CHECK (status IN ('actif','grace','termine','arrete','alerte')),
  started_at            timestamptz NOT NULL DEFAULT now(),
  deadline_at           timestamptz NOT NULL,
  grace_seconds         integer NOT NULL CHECK (grace_seconds BETWEEN 60 AND 3600),
  expected_interval_s   integer NOT NULL DEFAULT 30,
  reminded_at           timestamptz,
  alert_id              uuid,
  ended_at              timestamptz
);
CREATE INDEX trips_user_idx ON trips (user_id, started_at DESC);
CREATE INDEX trips_due_idx ON trips (deadline_at) WHERE status IN ('actif','grace');
CREATE UNIQUE INDEX trips_one_active_uq ON trips (user_id) WHERE status IN ('actif','grace');

CREATE TABLE trip_contacts (
  trip_id    uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  PRIMARY KEY (trip_id, contact_id)
);

CREATE TABLE location_points (
  id          bigserial PRIMARY KEY,
  trip_id     uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  accuracy    integer NOT NULL,
  measured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX location_points_trip_idx ON location_points (trip_id, measured_at);
CREATE INDEX location_points_received_idx ON location_points (received_at);

CREATE TABLE alerts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref         text NOT NULL UNIQUE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idem_key    text NOT NULL,
  type        text NOT NULL,
  comment     text,
  origin      text NOT NULL CHECK (origin IN ('sos','tracking')),
  trip_id     uuid REFERENCES trips(id) ON DELETE SET NULL,
  status      text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,
  UNIQUE (user_id, idem_key)
);
CREATE INDEX alerts_user_idx ON alerts (user_id, created_at DESC);

-- Positions associées à une alerte (initiale puis mises à jour tant que l'alerte est ouverte)
CREATE TABLE alert_positions (
  id          bigserial PRIMARY KEY,
  alert_id    uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  accuracy    integer NOT NULL,
  measured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  stale       boolean NOT NULL DEFAULT false
);
CREATE INDEX alert_positions_alert_idx ON alert_positions (alert_id, measured_at DESC);

CREATE TABLE alert_recipients (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id         uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  contact_id       uuid REFERENCES contacts(id) ON DELETE SET NULL,
  contact_name     text NOT NULL,
  view_token_hash  bytea NOT NULL UNIQUE,
  first_viewed_at  timestamptz,
  acked_at         timestamptz
);
CREATE INDEX alert_recipients_alert_idx ON alert_recipients (alert_id);

-- File d'envoi. Le contenu n'est pas stocké : seules les références nécessaires au rendu.
CREATE TABLE notifications (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL,
  channel         text NOT NULL CHECK (channel IN ('email','push')),
  alert_id        uuid REFERENCES alerts(id) ON DELETE CASCADE,
  recipient_id    uuid REFERENCES alert_recipients(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE CASCADE,
  contact_id      uuid REFERENCES contacts(id) ON DELETE CASCADE,
  push_sub_id     uuid REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  address         text,
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  state           text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','sending','sent','failed')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at       timestamptz,
  provider_id     text,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX notifications_due_idx ON notifications (next_attempt_at) WHERE state = 'queued';
CREATE INDEX notifications_alert_idx ON notifications (alert_id);

CREATE TABLE shares (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_id  uuid REFERENCES contacts(id) ON DELETE CASCADE,
  token_hash  bytea NOT NULL UNIQUE,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  accuracy    integer NOT NULL,
  measured_at timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz
);
CREATE INDEX shares_user_idx ON shares (user_id, created_at DESC);

CREATE TABLE audit_logs (
  id       bigserial PRIMARY KEY,
  user_id  uuid REFERENCES users(id) ON DELETE CASCADE,
  actor    text NOT NULL,
  action   text NOT NULL,
  ref      text,
  at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_user_idx ON audit_logs (user_id, at DESC);

// Postgres connection + schema. Works with Neon, Supabase, Render Postgres or local Postgres.
const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 10,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS slots (
  id         TEXT PRIMARY KEY,
  provider   TEXT NOT NULL,
  start_text TEXT NOT NULL,          -- exactly what the client sent, returned unchanged
  end_text   TEXT NOT NULL,
  start_at   TIMESTAMPTZ NOT NULL,   -- parsed, used for sorting and "already started"
  end_at     TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS bookings (
  seq        BIGSERIAL UNIQUE,       -- insertion order, used for "oldest first" + cursors
  id         TEXT PRIMARY KEY,
  slot_id    TEXT NOT NULL,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Level 3 safety net: the database itself refuses a second confirmed booking for one slot.
CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
  ON bookings (slot_id) WHERE status = 'confirmed';

CREATE INDEX IF NOT EXISTS bookings_email_seq ON bookings (email, seq);

-- Level 4: remembers the response for each Idempotency-Key.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT PRIMARY KEY,
  body_hash   TEXT NOT NULL,
  status_code INT  NOT NULL,
  response    JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Level 5: one row per booking attempt, per email.
CREATE TABLE IF NOT EXISTS booking_attempts (
  email        TEXT NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS booking_attempts_email_time ON booking_attempts (email, attempted_at);
`;

async function init() {
  await pool.query(SCHEMA);
}

module.exports = { pool, init };

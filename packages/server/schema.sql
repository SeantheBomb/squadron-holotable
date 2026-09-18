-- Squadron Holotable accounts and match index.
-- Apply:  npx wrangler d1 execute holotable --remote --file schema.sql

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL,
  username_key  TEXT NOT NULL UNIQUE,   -- lowercased, for case-insensitive uniqueness
  -- The browser stretches the password (PBKDF2, 600k iterations) and sends only the derived key.
  -- We store a salted hash of that, so a database leak yields nothing directly usable.
  pw_hash       TEXT NOT NULL,
  pw_salt       TEXT NOT NULL,
  -- Optional. Blank for most accounts: only ever used for password reset and turn alerts.
  email         TEXT,
  created_at    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,         -- SHA-256 of the bearer token; the token itself is never stored
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- Durable Objects cannot be listed or queried, so matches are indexed here.
CREATE TABLE IF NOT EXISTS matches (
  code        TEXT PRIMARY KEY,         -- also the Durable Object name
  mode        TEXT NOT NULL,            -- 'live' | 'correspondence'
  status      TEXT NOT NULL,            -- 'lobby' | 'active' | 'over'
  p0_user     TEXT REFERENCES users(id) ON DELETE SET NULL,
  p1_user     TEXT REFERENCES users(id) ON DELETE SET NULL,
  p0_name     TEXT,
  p1_name     TEXT,
  turn_user   TEXT,                     -- whose input is awaited; NULL when nobody is blocked
  round       INTEGER NOT NULL DEFAULT 0,
  winner      TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS matches_p0 ON matches(p0_user, updated_at DESC);
CREATE INDEX IF NOT EXISTS matches_p1 ON matches(p1_user, updated_at DESC);
CREATE INDEX IF NOT EXISTS matches_turn ON matches(turn_user);

-- Web Push endpoints, one row per device a player opts in from.
CREATE TABLE IF NOT EXISTS push_subs (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_user ON push_subs(user_id);

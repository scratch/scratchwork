-- Canonical Scratchwork database schema (SQLite / Cloudflare D1).
--
-- This is the SOURCE OF TRUTH for a fresh database. Every statement is
-- idempotent (IF NOT EXISTS), so applying it to an existing database only fills
-- in anything missing — it never destroys data. The same file is applied to D1
-- in production (via deploy.sh / wrangler) and to bun:sqlite locally (via
-- src/db/migrate.js). Incremental, non-idempotent changes (column adds, data
-- backfills) go in src/db/migrations/ and run BEFORE this file; see migrate.js.
--
-- Conventions:
--   * snake_case columns, TEXT primary keys (app-generated ids, see util.js).
--   * Timestamps are ISO-8601 TEXT (datetime('now') gives "YYYY-MM-DD HH:MM:SS").
--   * Foreign keys cascade from user → everything the user owns.
--
-- Foreign-key enforcement is OFF by default in SQLite; the bun:sqlite adapter
-- turns it on per-connection (PRAGMA foreign_keys = ON). D1 enforces the
-- declared constraints itself.

-- Users. The slug is the URL-facing identity (email local-part, e.g.
-- pete@ycombinator.com → "pete"), unique across all users with a numeric
-- suffix on collision (resolved in the auth layer, not here).
CREATE TABLE IF NOT EXISTS user (
    id         TEXT PRIMARY KEY,
    email      TEXT UNIQUE NOT NULL,
    slug       TEXT UNIQUE NOT NULL,
    name       TEXT,
    image      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- OAuth account linkage (one row per external identity). For the
-- cloudflare-access auth mode the provider is "cloudflare-access"; for local
-- mode it is "google". provider_account_id is the provider's stable subject.
CREATE TABLE IF NOT EXISTS account (
    id                  TEXT PRIMARY KEY,
    user_id             TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    provider            TEXT NOT NULL,
    provider_account_id TEXT NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (provider, provider_account_id)
);
CREATE INDEX IF NOT EXISTS idx_account_user ON account(user_id);

-- Browser/CLI sessions. The token is an opaque, unguessable secret stored
-- as-is (transport is HTTPS; the DB is the trust boundary). Looked up by token
-- on every authenticated request, so it is indexed and unique.
CREATE TABLE IF NOT EXISTS session (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    token      TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    user_agent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_session_user ON session(user_id);
CREATE INDEX IF NOT EXISTS idx_session_token ON session(token);

-- API keys for CI / non-interactive deploys. Only a hash of the key is stored;
-- the plaintext is shown to the user exactly once at creation. prefix is the
-- short, plaintext leading segment used to identify a key in listings.
CREATE TABLE IF NOT EXISTS apikey (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    name       TEXT,
    prefix     TEXT NOT NULL,
    key_hash   TEXT UNIQUE NOT NULL,
    expires_at TEXT,
    last_used  TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_apikey_user ON apikey(user_id);
CREATE INDEX IF NOT EXISTS idx_apikey_key_hash ON apikey(key_hash);

-- CLI device-login handshake (RFC 8628 style). A pending row is created when
-- the CLI starts login; the browser flow marks it approved and attaches the
-- user; the CLI polls device_code until status flips, then exchanges it for a
-- session. Short-lived; expired rows are swept lazily.
CREATE TABLE IF NOT EXISTS device_code (
    id          TEXT PRIMARY KEY,
    device_code TEXT UNIQUE NOT NULL,
    user_code   TEXT UNIQUE NOT NULL,
    user_id     TEXT REFERENCES user(id) ON DELETE SET NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_device_code_device ON device_code(device_code);
CREATE INDEX IF NOT EXISTS idx_device_code_user_code ON device_code(user_code);

-- Projects. Public identity is owner.slug + name (unique per owner); the
-- internal id is retained because it is what content-tokens and share-tokens
-- bind to, and what survives a project rename. Deploy blobs stay in R2 / the
-- filesystem under deploys/<live_deploy_id>/; only the metadata lives here.
-- last_deploy is a JSON snapshot ({id, fileCount, totalBytes, createdAt}).
CREATE TABLE IF NOT EXISTS project (
    id             TEXT PRIMARY KEY,
    owner_id       TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    name           TEXT NOT NULL,
    visibility     TEXT NOT NULL DEFAULT 'private',
    live_deploy_id TEXT,
    version        INTEGER NOT NULL DEFAULT 0,
    last_deploy    TEXT,
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (owner_id, name)
);
CREATE INDEX IF NOT EXISTS idx_project_owner ON project(owner_id);

-- Revocable share-link tokens. A non-expired, non-revoked token grants access
-- to its project regardless of the project's visibility (the share-link path).
CREATE TABLE IF NOT EXISTS share_token (
    id         TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
    token      TEXT UNIQUE NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_share_token_project ON share_token(project_id);
CREATE INDEX IF NOT EXISTS idx_share_token_token ON share_token(token);

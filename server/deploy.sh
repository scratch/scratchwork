#!/usr/bin/env bash
# Deterministic Cloudflare deploy. Safe to run repeatedly — every step is
# idempotent, and it fails fast (before touching anything) if the result
# would be a server with no deploy token.
#
#   ./deploy.sh                          redeploy (keeps the existing token)
#   SCRATCHWORK_TOKEN=... ./deploy.sh    deploy and (re)set the deploy token
#
# Everything is read from wrangler.toml; there is no other configuration. The
# stateful resources are an R2 bucket (deploy blobs) and a D1 database (metadata,
# schema in src/db/schema.sql); both are created on first run.
set -euo pipefail
cd "$(dirname "$0")"

field() { grep -m1 -E "^[[:space:]]*$1[[:space:]]*=" wrangler.toml | sed 's/.*"\([^"]*\)".*/\1/'; }
NAME=$(field name)
BUCKET=$(field bucket_name)
DB_NAME=$(field database_name)
URL="https://$(sed -n 's/.*pattern = "\([^"]*\)".*/\1/p' wrangler.toml | head -1 | sed 's|/\*$||')"

# Preflight: refuse to deploy a tokenless server. (secret list errors on the
# very first deploy, when the Worker doesn't exist yet — treat as "no secret".)
if [ -z "${SCRATCHWORK_TOKEN:-}" ] &&
   ! wrangler secret list 2>/dev/null | grep -q '"SCRATCHWORK_TOKEN"'; then
  echo "error: no deploy token is set on the Worker and SCRATCHWORK_TOKEN is not in the environment." >&2
  echo "       run: SCRATCHWORK_TOKEN=\$(openssl rand -hex 24) ./deploy.sh   (and save the token)" >&2
  exit 1
fi

# R2 bucket: create only if missing (create is not idempotent).
if ! wrangler r2 bucket list | grep -qE "^name:[[:space:]]+$BUCKET\$"; then
  echo "creating R2 bucket $BUCKET"
  wrangler r2 bucket create "$BUCKET"
fi

# D1 database: create only if missing, then make sure wrangler.toml carries its
# id (the binding needs it before `wrangler deploy`). `d1 info --json` prints
# {"uuid":"…"}; we extract that without depending on jq.
if ! wrangler d1 list --json 2>/dev/null | grep -q "\"name\": *\"$DB_NAME\""; then
  echo "creating D1 database $DB_NAME"
  wrangler d1 create "$DB_NAME"
fi
DB_ID=$(wrangler d1 info "$DB_NAME" --json 2>/dev/null \
  | grep -oE '"uuid"[[:space:]]*:[[:space:]]*"[^"]+"' | head -1 | sed -E 's/.*"([^"]+)"$/\1/')
if [ -z "$DB_ID" ]; then
  echo "error: could not determine the id of D1 database '$DB_NAME'." >&2
  exit 1
fi
if [ "$(field database_id)" != "$DB_ID" ]; then
  echo "writing database_id $DB_ID into wrangler.toml"
  sed -i.bak -E "s|^database_id = .*|database_id = \"$DB_ID\"|" wrangler.toml && rm -f wrangler.toml.bak
fi

# Apply migrations (ordered deltas) then the canonical schema, against the
# remote D1. schema.sql is idempotent; the migration deltas tolerate being
# re-run, so this whole block is safe on every deploy. Mirrors migrate.js.
for f in $(ls src/db/migrations/*.sql 2>/dev/null | sort); do
  echo "applying migration $f"
  wrangler d1 execute "$DB_NAME" --remote --file "$f" --yes \
    || echo "  (skipped: $f looks already applied)"
done
echo "applying schema src/db/schema.sql"
wrangler d1 execute "$DB_NAME" --remote --file src/db/schema.sql --yes

wrangler deploy

# Secret last: putting it on a fresh Worker requires the Worker to exist,
# and uploading a secret activates a new version on its own.
if [ -n "${SCRATCHWORK_TOKEN:-}" ]; then
  printf '%s' "$SCRATCHWORK_TOKEN" | wrangler secret put SCRATCHWORK_TOKEN
fi

sleep 2
curl -fsS --max-time 15 "$URL/api/health" >/dev/null
echo "deployed: $URL ($(curl -fsS --max-time 15 "$URL/api/whoami"))"

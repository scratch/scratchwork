#!/usr/bin/env bash
# Deterministic Cloudflare deploy. Safe to run repeatedly — every step is
# idempotent, and it fails fast (before touching anything) if the result
# would be a server with no deploy token.
#
#   ./deploy.sh                          redeploy (keeps the existing token)
#   SCRATCHWORK_TOKEN=... ./deploy.sh    deploy and (re)set the deploy token
#
# Everything is read from wrangler.toml; there is no other configuration.
set -euo pipefail
cd "$(dirname "$0")"

field() { grep -m1 -E "^[[:space:]]*$1[[:space:]]*=" wrangler.toml | sed 's/.*"\([^"]*\)".*/\1/'; }
NAME=$(field name)
BUCKET=$(field bucket_name)
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

wrangler deploy

# Secret last: putting it on a fresh Worker requires the Worker to exist,
# and uploading a secret activates a new version on its own.
if [ -n "${SCRATCHWORK_TOKEN:-}" ]; then
  printf '%s' "$SCRATCHWORK_TOKEN" | wrangler secret put SCRATCHWORK_TOKEN
fi

sleep 2
curl -fsS --max-time 15 "$URL/api/health" >/dev/null
echo "deployed: $URL ($(curl -fsS --max-time 15 "$URL/api/whoami"))"

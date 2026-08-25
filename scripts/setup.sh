#!/usr/bin/env bash
#
# One-command deploy for AI Builder Day.
#
#   ./scripts/setup.sh
#
# Creates the D1 database (or reuses an existing one), writes its id into
# wrangler.jsonc, applies migrations, and deploys. Safe to run more than once.
#
# It does NOT touch secrets — those go in with `wrangler secret put` so they never
# end up in a file, a shell history, or a chat transcript. The script tells you which
# ones are missing at the end.

set -euo pipefail

DB_NAME="secc-builder-day"
CONFIG="wrangler.jsonc"

cd "$(dirname "$0")/.."

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✕ %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$CONFIG" ] || die "Run this from the repository root (no $CONFIG here)."

# ---------------------------------------------------------------- 1. prerequisites
say "1/5  Checking prerequisites"

# Wrangler 4 needs Node 20 or newer.
command -v node >/dev/null || die "Node is not installed.

  On a Mac, either:
    brew install node                       (if you have Homebrew)
    https://nodejs.org  -> download the LTS installer and run it

  Then open a NEW terminal window and run this script again."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $NODE_MAJOR is too old — Wrangler needs 20 or newer.

  brew upgrade node    or    https://nodejs.org -> download the LTS installer

  Then open a NEW terminal window and run this script again."
ok "node $(node -v)"

[ -d node_modules ] || { warn "Installing dependencies (one minute or so)"; npm install; }
ok "dependencies installed"

if ! npx wrangler whoami >/dev/null 2>&1; then
  say "You are not logged in to Cloudflare. A browser window will open."
  npx wrangler login || die "Login failed. Run 'npx wrangler login' yourself, then re-run this script."
fi
ok "logged in as $(npx wrangler whoami 2>/dev/null | grep -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+' | head -1 || echo 'your Cloudflare account')"

# ---------------------------------------------------------------- 2. the database
say "2/5  Database"

# Same script the GitHub Actions deploy uses, so the two routes cannot drift.
node scripts/provision-d1.mjs "$DB_NAME" \
  || die "Could not set up the database. Run 'npx wrangler d1 create $DB_NAME' and paste the printed database_id into $CONFIG yourself."

# ---------------------------------------------------------------- 3. migrations
say "3/5  Schema"
npx wrangler d1 migrations apply "$DB_NAME" --remote
ok "migrations applied"

# ---------------------------------------------------------------- 4. deploy
say "4/5  Deploy"
DEPLOY_LOG="$(mktemp)"
npm run deploy 2>&1 | tee "$DEPLOY_LOG"
URL="$(grep -oE 'https://[A-Za-z0-9.-]+\.workers\.dev' "$DEPLOY_LOG" | head -1 || true)"
rm -f "$DEPLOY_LOG"
ok "deployed"

# PUBLIC_ORIGIN is what every personal link in every email is built from. Getting this
# wrong sends everyone a link to localhost, so set it automatically.
if [ -n "$URL" ] && grep -q '"PUBLIC_ORIGIN": "http://localhost:8787"' "$CONFIG"; then
  node - "$CONFIG" "$URL" <<'NODE'
const fs = require('fs');
const [file, url] = process.argv.slice(2);
fs.writeFileSync(file, fs.readFileSync(file, 'utf8')
  .replace('"PUBLIC_ORIGIN": "http://localhost:8787"', `"PUBLIC_ORIGIN": "${url}"`));
NODE
  warn "PUBLIC_ORIGIN set to $URL — re-deploying so links point at the right place"
  npm run deploy >/dev/null
  ok "re-deployed"
fi

# ---------------------------------------------------------------- 5. what is left
say "5/5  What is still needed"

MISSING=""
SECRETS="$(npx wrangler secret list 2>/dev/null || echo '[]')"
for s in ANTHROPIC_API_KEY RESEND_API_KEY TURNSTILE_SECRET_KEY; do
  case "$SECRETS" in
    *"$s"*) ok "$s is set" ;;
    *) MISSING="$MISSING $s"; warn "$s is not set" ;;
  esac
done

cat <<EOF

────────────────────────────────────────────────────────────────────────
The app is live${URL:+ at $URL}.

It works right now with no secrets at all:
  · the participant form and every admin screen
  · grouping (falls back to grouping by project kind without an Anthropic key)
  · CSV export — the escape hatch, always available

Still to do, in the order that matters:

  1. PUT CLOUDFLARE ACCESS IN FRONT OF /admin — do this before you share
     anything. Zero Trust dashboard -> Access -> Applications -> Add ->
     Self-hosted. Domain: your worker's hostname, path: admin. Policy:
     Allow -> Emails -> the organizers. Leave /r/* and /teams open.

  2. Upload the invite list at /admin/invites (CSV of name + email).
EOF

if [ -n "$MISSING" ]; then
  cat <<EOF

  3. Add the secrets you want, then re-deploy:
EOF
  for s in $MISSING; do echo "       npx wrangler secret put $s"; done
  cat <<EOF

     None of them are required. Without RESEND_API_KEY you hand out personal
     links from the participants table or a CSV mail-merge instead.
EOF
fi

cat <<EOF

  Check the event dates in $CONFIG (EVENT_DATE, FORM_DEADLINE) before
  inviting anyone — the defaults are placeholders.
────────────────────────────────────────────────────────────────────────
EOF

#!/usr/bin/env bash
# Run the faucet locally against the production wallet, with the rate limits off.
#
# BUILD AND START, NOT `next dev`, and that is not a preference. Neither dev mode can
# bundle this app today:
#
#   next dev (turbopack)  workers/t2z-worker.mjs does `await import(<absolute path>)`,
#                         which turbopack rewrites to /ROOT/... and cannot resolve.
#                         Every route 500s, and /api/ready answers HTML instead of JSON.
#   next dev --webpack    @grpc/grpc-js pulls in node's `stream`, which dev-mode webpack
#                         does not resolve even though serverExternalPackages lists it.
#
# `next build --webpack` (what package.json's build already does, and what ships) has
# neither problem. So local work costs a rebuild instead of hot reload. Worth knowing
# before spending an hour deciding your machine is broken.
#
# Prerequisites, in order:
#   scripts/dev-pull-env.sh     once, to write .env.local with the live credentials
#   scripts/dev-tunnels.sh      in another terminal, and left running
#
# EVERY DRIP FROM HERE SPENDS REAL TESTNET FUNDS. The tunnels point at the box's own
# zallet and Crosslink node. There is no local pot; the gates are off, the money is not.
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-3111}"

for port in 28232 19232; do
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1 || {
    echo "no tunnel on $port - run scripts/dev-tunnels.sh in another terminal first" >&2
    exit 1
  }
done

[ -f .env.local ] || { echo "no .env.local - run scripts/dev-pull-env.sh first" >&2; exit 1; }

# Belt and braces on top of .env.local. A drip against production caps and a real
# cooldown is not a test, and finding that out costs a 24 hour wait.
export FAUCET_COOLDOWN_SECONDS=0
export FAUCET_DAILY_CAP_TAZ=100000
export FAUCET_CTAZ_DAILY_CAP=100000
export FAUCET_SUBNET_DAILY_MAX=100000
export FAUCET_CHALLENGE=none
export TURNSTILE_SECRET_KEY=
export NEXT_PUBLIC_TURNSTILE_SITE_KEY=

echo "building (webpack; ~1 min)"
npm run build

echo
echo "starting on http://127.0.0.1:$PORT"
echo "  cooldown 0, no captcha, no proof-of-work, caps effectively removed"
echo "  drips spend REAL testnet funds from the production wallet"
echo
# -H 127.0.0.1 so a machine on your wifi cannot reach an ungated faucet wired to the
# production wallet. The production start script binds 0.0.0.0; this one must not.
exec npx next start -H 127.0.0.1 -p "$PORT"

#!/usr/bin/env bash
# Build .env.local for local development against the production wallet.
#
# Copies the template, then appends the live connection values from the box. The values
# are never printed: they go straight from ssh into the file, and only the KEY NAMES are
# echoed. Re-runnable - it rewrites .env.local from scratch each time rather than
# appending duplicates, because a second ZALLET_RPC_PASSWORD line silently wins over the
# first and that is a miserable thing to debug.
#
# WHY THIS EXISTS AT ALL: the repo's .env carries zallet credentials that no longer match
# the box (different account, password and address). Local runs against it fail to
# authenticate, or worse, authenticate against something that is not the faucet wallet.
set -euo pipefail

# THE BOX IS NOT IN THIS FILE. It was, twice, and was removed twice (#95, #250): this repo
# is public, and while DNS already resolves the faucet hostname to the address, a committed
# "root@<ip>" also publishes the user it is reached as, permanently, in history.
# Set it in your shell: export FAUCET_BOX=root@your-box
BOX="${FAUCET_BOX:?set FAUCET_BOX first, e.g. export FAUCET_BOX=root@your-box}"
CONTAINER="${FAUCET_CONTAINER:-zcash-faucet-faucet-1}"
cd "$(dirname "$0")/.."

[ -f .env.local.template ] || { echo "missing .env.local.template - run from the repo" >&2; exit 1; }

# Keys worth pulling: connection and identity only. Anything that decides POLICY
# (cooldown, caps, challenge) stays in the template, or the box's production values
# would override the dev overrides that are the whole point of the file.
KEYS='ZALLET_ACCOUNT|ZALLET_ADDRESS|ZALLET_RPC_USER|ZALLET_RPC_PASSWORD|ZALLET_MIN_CONF|ZALLET_PASSPHRASE|FAUCET_SENDER|FAUCET_DRIP_TAZ|FAUCET_MIN_RESERVE_TAZ|RATE_LIMIT_SALT|LIGHTWALLETD_ENDPOINT|FAUCET_EXPLORER_TX_URL|FAUCET_DONATION_ADDRESS'

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
chmod 600 "$tmp"

# shellcheck disable=SC2029  # $KEYS is meant to expand locally into the remote command
ssh -o ConnectTimeout=25 "$BOX" \
  "docker inspect $CONTAINER --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^($KEYS)='" \
  > "$tmp"

[ -s "$tmp" ] || { echo "pulled nothing - is $CONTAINER running on $BOX?" >&2; exit 1; }

umask 077
cp .env.local.template .env.local
cat "$tmp" >> .env.local
chmod 600 .env.local

echo "wrote .env.local with $(grep -cE '^[A-Z]' .env.local) settings"
echo "pulled from the box (values hidden):"
sed -E 's/=.*//; s/^/  /' "$tmp"
echo
echo "next: scripts/dev-tunnels.sh   (then: npm run dev)"

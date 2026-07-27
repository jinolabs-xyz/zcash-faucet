#!/usr/bin/env bash
# One-command deploy for the shielded faucet on a fresh VM (DigitalOcean Droplet,
# Linode, Vultr, Hetzner — any Ubuntu box with Docker).
#
# It stands the whole thing up as containers:
#   zebra + zallet   ← the z3 stack (official, maintained Docker Compose)
#   faucet + caddy   ← this repo's overlay (deploy/z3/)
#
# Everything is `restart: unless-stopped`, so once it's up it survives reboots
# and crashes on its own — no babysitting.
#
# Usage:   NETWORK=testnet FAUCET_DOMAIN=faucet.example.org ./deploy.sh
#          (FAUCET_DOMAIN optional; omit for a plain-HTTP :80 smoke test)
#
# Safe to re-run: it skips steps already done. The one unavoidable pauses are the
# initial chain sync (hours, one time) and funding the faucet address.
set -euo pipefail

NETWORK="${NETWORK:-testnet}"
FAUCET_DOMAIN="${FAUCET_DOMAIN:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"       # deploy/
REPO="$(cd "$HERE/.." && pwd)"                             # repo root
Z3="$HERE/z3-stack"                                        # where we clone z3
ENVF="--env-file .env.$NETWORK"
NETNAME="z3-$NETWORK"
say(){ printf '\n\033[1m==> %s\033[0m\n' "$*"; }

command -v docker >/dev/null || { echo "Install Docker first."; exit 1; }
docker compose version >/dev/null || { echo "Need Docker Compose v2 (the 'docker compose' plugin)."; exit 1; }

# 1. z3 stack (node + wallet) ------------------------------------------------
if [ ! -d "$Z3" ]; then
  say "Cloning the z3 stack"
  git clone --depth 1 https://github.com/ZcashFoundation/z3 "$Z3"
fi
cd "$Z3"
[ -f "config/$NETWORK/zebra.toml" ] || { say "Configuring z3 for $NETWORK"; ./scripts/setup-network.sh "$NETWORK"; }

# Authorize the faucet on Zallet's RPC (idempotent): add an [[rpc.auth]] user
# with a generated password, and stash the password for the faucet env.
ZCFG="config/$NETWORK/zallet.toml"
PWFILE="$HERE/.zallet-rpc-password"
if ! grep -q 'user = "faucet"' "$ZCFG"; then
  say "Authorizing the faucet on Zallet's RPC"
  RPCPW="$(openssl rand -hex 24)"; echo "$RPCPW" > "$PWFILE"; chmod 600 "$PWFILE"
  printf '\n[[rpc.auth]]\nuser = "faucet"\npassword = "%s"\n' "$RPCPW" >> "$ZCFG"
fi
RPCPW="$(cat "$PWFILE")"

say "Starting Zebra (the node) — first sync takes hours, one time"
docker compose $ENVF up -d zebra
say "Waiting for Zebra to finish syncing (Ctrl-C is safe; re-run to resume)"
./scripts/check-zebra-readiness.sh "$([ "$NETWORK" = testnet ] && echo 18080 || echo 8080)"

say "Starting Zallet (the wallet)"
docker compose $ENVF up -d zallet
sleep 5

# 2. Faucet's shielded account ----------------------------------------------
# Created AFTER sync so its birthday = chain tip → no historical rescan.
zrpc(){ docker compose $ENVF exec -T zallet zallet-zaino -d /var/lib/zallet rpc "$@"; }
ACCTFILE="$HERE/.faucet-account"
if [ ! -f "$ACCTFILE" ]; then
  say "Creating the faucet's shielded account"
  UUID="$(zrpc z_getnewaccount '"faucet"' | python3 -c 'import sys,json;print(json.load(sys.stdin)["account_uuid"])')"
  ADDR="$(zrpc z_getaddressforaccount "\"$UUID\"" | python3 -c 'import sys,json;print(json.load(sys.stdin)["address"])')"
  printf 'UUID=%s\nADDR=%s\n' "$UUID" "$ADDR" > "$ACCTFILE"
fi
# shellcheck disable=SC1090
source "$ACCTFILE"

# 3. Fund it -----------------------------------------------------------------
# The faucet comes up fine unfunded (it reports "empty" until coins arrive), so
# only pause for funding in an interactive shell — never under cloud-init.
BAL="$(zrpc z_getbalanceforaccount "\"$UUID\"" 1 | python3 -c 'import sys,json;p=json.load(sys.stdin).get("pools",{});print(sum(int(v.get("valueZat",0)) for v in p.values()))' 2>/dev/null || echo 0)"
if [ "${BAL:-0}" -eq 0 ] && [ -t 0 ] && [ "${NONINTERACTIVE:-0}" != "1" ]; then
  say "Fund the faucet, then press Enter (or Ctrl-C — it also runs fine unfunded)"
  echo "    Send $NETWORK ZEC to:  $ADDR"
  read -r _ || true
fi

# 4. Faucet + Caddy overlay --------------------------------------------------
say "Writing faucet.env"
ENVOUT="$HERE/z3/faucet.env"
if [ ! -f "$ENVOUT" ]; then cp "$HERE/z3/faucet.env.example" "$ENVOUT"; fi
python3 - "$ENVOUT" "$RPCPW" "$UUID" "$ADDR" <<'PY'
import re,sys
f,pw,uuid,addr=sys.argv[1:5]; s=open(f).read()
vals={"ZALLET_RPC_USER":"faucet","ZALLET_RPC_PASSWORD":pw,"ZALLET_ACCOUNT":uuid,"ZALLET_ADDRESS":addr}
for k,v in vals.items(): s=re.sub(rf'(?m)^{k}=.*$', f'{k}={v}', s)
if "RATE_LIMIT_SALT=change" in s: s=s.replace("RATE_LIMIT_SALT=change-me-to-a-long-random-secret", "RATE_LIMIT_SALT=__FILL_ME__")
open(f,"w").write(s)
PY
grep -q "__FILL_ME__" "$ENVOUT" && say "NOTE: set a real RATE_LIMIT_SALT in $ENVOUT before going live"

say "Starting the faucet + Caddy"
cd "$HERE/z3"
Z3_NETWORK_NAME="$NETNAME" FAUCET_DOMAIN="$FAUCET_DOMAIN" \
  docker compose -f docker-compose.faucet.yml up -d --build

say "Done. The faucet is live${FAUCET_DOMAIN:+ at https://$FAUCET_DOMAIN}."
echo "   Check:   curl -s ${FAUCET_DOMAIN:+https://$FAUCET_DOMAIN}${FAUCET_DOMAIN:-http://localhost}/api/status"
echo "   Fund it: send $NETWORK ZEC to  $ADDR"
echo "            (until funded, claims answer 'faucet empty' — everything else works)"

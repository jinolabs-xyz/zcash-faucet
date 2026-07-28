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
# Usage:   NETWORK=testnet FAUCET_DOMAIN=faucet.example.org \
#            FAUCET_MINER_ADDRESS=tm... ./deploy.sh
#          (FAUCET_DOMAIN optional; omit for a plain-HTTP :80 smoke test)
#          (FAUCET_MINER_ADDRESS is where mining rewards go, so it is what funds
#           the faucet. Omit it and the site serves but mines nothing.)
#
# Safe to re-run: it skips steps already done. The one unavoidable pauses are the
# initial chain sync (hours, one time) and funding the faucet address. The site
# itself is served from the start: the overlay goes up before the sync wait and
# shows an honest syncing state until the chain and account are ready.
set -euo pipefail

NETWORK="${NETWORK:-testnet}"
FAUCET_DOMAIN="${FAUCET_DOMAIN:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"       # deploy/
Z3="$HERE/z3-stack"                                        # where we clone z3
ENVF="--env-file .env.$NETWORK"

# Bind the node and wallet RPC to loopback on the HOST. Docker publishes ports
# by writing its own iptables chain, which bypasses ufw entirely, so a firewall
# rule cannot close these: the binding is the only control. Shell values win
# over --env-file, so this needs no edit to z3's files.
#
# P2P stays on all interfaces because inbound peers are the point. Zaino is
# only published under the indexer profile we do not run, covered in case
# someone enables it.
Z3_LOOPBACK_BINDINGS=(
  "Z3_ZEBRA_HOST_RPC_PORT=127.0.0.1:$([ "$NETWORK" = testnet ] && echo 18232 || echo 8232)"
  "Z3_ZEBRA_HOST_HEALTH_PORT=127.0.0.1:$([ "$NETWORK" = testnet ] && echo 18080 || echo 8080)"
  "Z3_ZALLET_HOST_RPC_PORT=127.0.0.1:$([ "$NETWORK" = testnet ] && echo 40232 || echo 28232)"
  "Z3_ZAINO_HOST_GRPC_PORT=127.0.0.1:$([ "$NETWORK" = testnet ] && echo 18137 || echo 8137)"
  "Z3_ZAINO_HOST_JSON_RPC_PORT=127.0.0.1:$([ "$NETWORK" = testnet ] && echo 18237 || echo 8237)"
)
# Where zebra sends mining rewards. This is the faucet's funding source, and it
# used to exist only as a hand-written docker-compose.override.yml inside the
# gitignored z3 clone, plus a hand edit to z3's own .env.testnet to load it.
# Neither survives a rebuild, so a rebuilt box came up mining to nothing and
# nothing in the repo said why. Generated below instead.
MINER_ADDRESS="${FAUCET_MINER_ADDRESS:-}"
OVERRIDE="$Z3/docker-compose.override.yml"

# COMPOSE_FILE goes through the shell rather than editing z3's tracked
# .env.$NETWORK, for the same reason the bindings do: shell values win, and the
# clone stays pristine so a rebuild is reproducible.
# Absolute paths on purpose: COMPOSE_FILE entries resolve against the current
# directory, and this function must not depend on the caller's cwd.
z3(){
  local overlay=()
  [ -f "$OVERRIDE" ] && overlay=(COMPOSE_FILE="$Z3/docker-compose.yml:$OVERRIDE")
  env "${Z3_LOOPBACK_BINDINGS[@]}" ${overlay[@]+"${overlay[@]}"} docker compose $ENVF "$@"
}
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

# Mining rewards need a destination before zebra starts, or the node comes up
# with no miner address and the faucet has no funding source. Rewritten every
# run so the repo, not the box, is the source of truth for where funds go.
# A wrong address here fails SILENTLY, which is why it gets checked instead of
# trusted: the node mines, blocks are found, and the reward is either unspendable
# or belongs to a stranger. Nothing errors, and the only signal is money that
# never arrives. Same shape as a bad digest, so refuse before writing.
#
# Rules taken from src/lib/zcash/address.ts, which already validates these
# byte-accurately for the app: testnet transparent is tm (P2PKH, version 1d25)
# or t2 (P2SH, 1cba), mainnet is t1 or t3. Cheapest checks first so the message
# names the actual mistake rather than "invalid".
validate_miner_address() {
  local addr="$1" ok_prefix ok_desc bad_net
  if [ "$NETWORK" = testnet ]; then
    ok_prefix='^(tm|t2)'; ok_desc="tm... (P2PKH) or t2... (P2SH)"; bad_net='^(t1|t3|u1|zs)'
  else
    ok_prefix='^(t1|t3)'; ok_desc="t1... (P2PKH) or t3... (P2SH)"; bad_net='^(tm|t2|utest1|ztestsapling1)'
  fi

  # Checked before the character set, because the likeliest mistake is pasting
  # the faucet's OWN unified address, and telling someone that "utest1..." is
  # not valid base58 sends them to debug the wrong thing entirely.
  if printf '%s' "$addr" | grep -qE '^(utest1|uregtest1|u1|ztestsapling1|zregtestsapling1|zs)'; then
    echo "FAUCET_MINER_ADDRESS is a shielded or unified address: $addr" >&2
    echo "A coinbase can only pay a TRANSPARENT address, so zebra cannot mine to this." >&2
    echo "Expected $ok_desc. This is probably the faucet's own address rather than the miner's." >&2
    exit 1
  fi

  if printf '%s' "$addr" | grep -qE "$bad_net"; then
    echo "FAUCET_MINER_ADDRESS looks like the WRONG NETWORK for NETWORK=$NETWORK." >&2
    echo "Expected $ok_desc. Got: $addr" >&2
    echo "Mining to another network's address means every reward is unspendable here," >&2
    echo "and nothing would report an error. Refusing." >&2
    exit 1
  fi

  if ! printf '%s' "$addr" | grep -qE "$ok_prefix"; then
    echo "FAUCET_MINER_ADDRESS does not start with $ok_desc. Got: $addr" >&2
    exit 1
  fi

  # Base58 excludes 0 O I l, so anything outside the alphabet cannot be an
  # address. This is also the injection guard: the value is written into YAML
  # inside quotes, and a quote or newline would otherwise escape into structure.
  case "$addr" in
    *[!123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]*)
      echo "FAUCET_MINER_ADDRESS contains a character that is not base58: $addr" >&2
      echo "A quote, space or newline would also escape into the generated YAML." >&2
      exit 1 ;;
  esac

  case "${#addr}" in
    34|35|36) ;;
    *) echo "FAUCET_MINER_ADDRESS is ${#addr} characters, and a transparent address is 35." >&2
       echo "This is what a truncated paste looks like. Got: $addr" >&2
       exit 1 ;;
  esac

  # The checksum is the only check that catches a typo which kept the right
  # prefix and length, which is the most likely real mistake.
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$addr" <<'PY' || exit 1
import hashlib, sys
A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
addr = sys.argv[1]
n = 0
for c in addr:
    n = n * 58 + A.index(c)
raw = n.to_bytes((n.bit_length() + 7) // 8, 'big')
raw = b'\x00' * (len(addr) - len(addr.lstrip('1'))) + raw
body, checksum = raw[:-4], raw[-4:]
if hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4] != checksum:
    sys.stderr.write(
        "FAUCET_MINER_ADDRESS failed its base58check checksum, so it is a typo.\n"
        "The prefix and length are right, which is why nothing else caught it.\n"
        "Got: %s\n" % addr)
    raise SystemExit(1)
PY
  else
    say "NOT VERIFIED: no python3, so the address checksum was not checked."
    say "              Prefix and length passed. A typo could still slip through."
  fi
}

if [ -n "$MINER_ADDRESS" ]; then
  validate_miner_address "$MINER_ADDRESS"
  say "Pointing mining rewards at $MINER_ADDRESS"
  cat > "$OVERRIDE" <<YML
# GENERATED by deploy/deploy.sh from FAUCET_MINER_ADDRESS. Do not hand-edit:
# the next deploy overwrites this file. Change the variable instead.
services:
  zebra:
    environment:
      ZEBRA_MINING__MINER_ADDRESS: "$MINER_ADDRESS"
YML
elif [ -f "$OVERRIDE" ]; then
  # An existing override with no variable set is the hand-written file this
  # replaces. Leave it alone rather than silently unfunding a running box, but
  # say so, because it means the repo still does not describe this box.
  say "WARNING: $OVERRIDE exists but FAUCET_MINER_ADDRESS is unset."
  say "         Keeping it, so mining is unchanged. It is NOT reproducible:"
  say "         a rebuild loses it. Set FAUCET_MINER_ADDRESS to fix that."
else
  say "NOTE: FAUCET_MINER_ADDRESS is unset, so zebra gets no miner address."
  say "      The faucet will serve but will not mine its own funds."
fi

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
z3 up -d zebra

# 2. Site up first, before the sync wait --------------------------------------
# The web frontend serves an honest syncing state long before the chain is
# usable, so the overlay goes up the moment Zebra is started. Anyone hitting
# the box sees live progress instead of a refused connection.

# One owner for port 80. Earlier bring-ups ran a hand-started faucet-web
# container that binds 80 and fights the overlay's Caddy for it. Retire it.
# The name filter is a substring match, so the real guard is the label:
# anything carrying a compose project label survives, only hand-started
# containers whose name contains faucet-web are removed.
for c in $(docker ps -aq --filter name=faucet-web); do
  if [ -z "$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$c")" ]; then
    cname="$(docker inspect -f '{{.Name}}' "$c" | sed 's|^/||')"
    say "Retiring hand-started container $cname (port 80 belongs to the overlay)"
    docker rm -f "$c" >/dev/null
  fi
done

ENVOUT="$HERE/z3/faucet.env"
# Fills faucet.env in place. Account args may be empty on the first pass:
# the app treats an unset account as "not ready" and reports that honestly,
# which is exactly the state we want served while the chain syncs.
write_env(){  # $1 = account uuid, $2 = address
  [ -f "$ENVOUT" ] || cp "$HERE/z3/faucet.env.example" "$ENVOUT"
  python3 - "$ENVOUT" "$RPCPW" "$1" "$2" <<'PY'
import re,sys
f,pw,uuid,addr=sys.argv[1:5]; s=open(f).read()
vals={"ZALLET_RPC_USER":"faucet","ZALLET_RPC_PASSWORD":pw}
if uuid: vals["ZALLET_ACCOUNT"]=uuid
if addr: vals["ZALLET_ADDRESS"]=addr
for k,v in vals.items(): s=re.sub(rf'(?m)^{k}=.*$', f'{k}={v}', s)
if "RATE_LIMIT_SALT=change" in s: s=s.replace("RATE_LIMIT_SALT=change-me-to-a-long-random-secret", "RATE_LIMIT_SALT=__FILL_ME__")
open(f,"w").write(s)
PY
}
overlay_up(){
  ( cd "$HERE/z3" && Z3_NETWORK_NAME="$NETNAME" FAUCET_DOMAIN="$FAUCET_DOMAIN" \
      docker compose -f docker-compose.faucet.yml up -d --build )
}

say "Writing faucet.env (RPC auth now, account wired in after sync)"
write_env "" ""
say "Starting the faucet + Caddy, the site serves its syncing state immediately"
overlay_up

say "Waiting for Zebra to finish syncing (Ctrl-C is safe; re-run to resume)"
./scripts/check-zebra-readiness.sh "$([ "$NETWORK" = testnet ] && echo 18080 || echo 8080)"

# 3. Zallet wallet init (one-time) --------------------------------------------
# A fresh zallet has no age identity and crash-loops with "Encryption identity
# file could not be located", so initialize the wallet BEFORE starting it.
# This is z3's documented flow (z3 docs/faq.md), run through one-off
# containers against the zallet volume. Idempotence is per step:
# generate-encryption-identity refuses to overwrite (so it is guarded on the
# identity file, named identity.txt by z3's shipped zallet.toml),
# init-wallet-encryption derives deterministically from the identity, but
# generate-mnemonic stores a NEW seed on every run, so the whole block is
# gated by a completion marker dropped in the volume after a full init.
ZVOL="$NETNAME-zallet"
ZIDFILE="${ZALLET_IDENTITY_FILE:-identity.txt}"
zwallet(){ z3 run --rm --no-deps zallet \
             --datadir /var/lib/zallet --config /etc/zallet/zallet.toml "$@"; }
zvol_has(){ docker run --rm -v "$ZVOL:/data" busybox test -f "/data/$1"; }
if ! zvol_has .faucet-wallet-initialized; then
  say "Initializing the Zallet wallet (one-time: identity, encryption, mnemonic)"
  # Docker creates the volume root-owned on first use; zallet runs as uid
  # 1000 and must be able to write into it.
  docker run --rm -v "$ZVOL:/data" busybox chown 1000:1000 /data
  zvol_has "$ZIDFILE" || zwallet generate-encryption-identity
  zwallet init-wallet-encryption
  zwallet generate-mnemonic
  docker run --rm -v "$ZVOL:/data" busybox touch /data/.faucet-wallet-initialized
fi

say "Starting Zallet (the wallet)"
z3 up -d zallet
sleep 5

# 4. Faucet's shielded account ----------------------------------------------
# Created AFTER sync so its birthday = chain tip → no historical rescan.
# --config is required: the RPC client reads the server port from the same
# config the server started with, and without it zallet looks for a config
# in the datadir that does not exist ("No JSON-RPC port available").
zrpc(){ z3 exec -T zallet zallet-zaino \
          --datadir /var/lib/zallet --config /etc/zallet/zallet.toml rpc "$@"; }
ACCTFILE="$HERE/.faucet-account"
if [ ! -f "$ACCTFILE" ]; then
  say "Creating the faucet's shielded account"
  UUID="$(zrpc z_getnewaccount '"faucet"' | python3 -c 'import sys,json;print(json.load(sys.stdin)["account_uuid"])')"
  ADDR="$(zrpc z_getaddressforaccount "\"$UUID\"" | python3 -c 'import sys,json;print(json.load(sys.stdin)["address"])')"
  printf 'UUID=%s\nADDR=%s\n' "$UUID" "$ADDR" > "$ACCTFILE"
fi
# shellcheck disable=SC1090
source "$ACCTFILE"

# 5. Fund it -----------------------------------------------------------------
# The faucet comes up fine unfunded (it reports "empty" until coins arrive), so
# only pause for funding in an interactive shell — never under cloud-init.
BAL="$(zrpc z_getbalanceforaccount "\"$UUID\"" 1 | python3 -c 'import sys,json;p=json.load(sys.stdin).get("pools",{});print(sum(int(v.get("valueZat",0)) for v in p.values()))' 2>/dev/null || echo 0)"
if [ "${BAL:-0}" -eq 0 ] && [ -t 0 ] && [ "${NONINTERACTIVE:-0}" != "1" ]; then
  say "Fund the faucet, then press Enter (or Ctrl-C — it also runs fine unfunded)"
  echo "    Send $NETWORK ZEC to:  $ADDR"
  read -r _ || true
fi

# 6. Wire the account into the running site -----------------------------------
say "Wiring the faucet account into faucet.env"
write_env "$UUID" "$ADDR"
# Plain `grep -q && say` would trip set -e on a re-run where the operator
# already set a real salt (grep returns 1), killing the script right here.
if grep -q "__FILL_ME__" "$ENVOUT"; then
  say "NOTE: set a real RATE_LIMIT_SALT in $ENVOUT before going live"
fi
# The env file changed, so compose recreates the app container with the
# account wired. A no-op when nothing changed, this is what makes re-runs safe.
say "Restarting the faucet with the account wired"
overlay_up

say "Done. The faucet is live${FAUCET_DOMAIN:+ at https://$FAUCET_DOMAIN}."
echo "   Check:   curl -s ${FAUCET_DOMAIN:+https://$FAUCET_DOMAIN}${FAUCET_DOMAIN:-http://localhost}/api/status"
echo "   Fund it: send $NETWORK ZEC to  $ADDR"
echo "            (until funded, claims answer 'faucet empty' — everything else works)"

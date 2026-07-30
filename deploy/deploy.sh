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
# Hard requirement, not optional. The miner-address checksum and version check is
# the only thing standing between a typo and mining to an address nobody owns, and
# it used to skip itself with a NOT VERIFIED note when python3 was absent (#165).
command -v python3 >/dev/null || { echo "Install python3 first: the miner-address validation needs it."; exit 1; }
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
    # This message has been wrong twice, in opposite directions, so the reason is
    # spelled out rather than summarised.
    #
    # It first said "a coinbase can only pay a TRANSPARENT address". False: ZIP 213
    # has allowed shielded coinbase since Heartwood.
    #
    # It then said we had not verified whether zebra pays the transparent receiver
    # of a unified address. Also false, and falsified by our own work an hour later
    # (#195): zebra v6.2.0's TransactionTemplate::new_coinbase tries orchard() then
    # sapling() and only falls back to transparent(), so a UA with a shielded
    # receiver gets a SHIELDED coinbase. Zebra's side is settled.
    #
    # What is genuinely unverified is the WALLET side: whether zallet detects a
    # shielded coinbase it did not itself create, credits it to our account, and can
    # spend it once mature. Until that is tested (#195, on the third-party build of
    # #184), pointing mining at a UA risks rewards that are real on-chain and
    # invisible to us — which is the same money-we-cannot-see failure as before,
    # arriving from the other end.
    echo "Zebra WOULD mine this shielded (it prefers a unified address's Orchard or" >&2
    echo "Sapling receiver over its transparent one), but we have not verified that" >&2
    echo "OUR wallet detects and can spend a shielded coinbase it did not create." >&2
    echo "Refusing until #195 tests that, so rewards cannot land somewhere real and" >&2
    echo "invisible to us. Not a protocol limit: shielded coinbase is legal (ZIP 213)." >&2
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
  # python3 is REQUIRED, checked at the top next to docker. It used to be optional
  # with an else branch that printed NOT VERIFIED and carried on, so the box least
  # likely to have python3 was the box that silently skipped the only check that
  # catches a typo (#165). A validator that degrades to not validating is worse
  # than no validator, because the operator reads a pass.
  python3 - "$addr" "$NETWORK" <<'PY' || exit 1
import hashlib, sys
A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
addr, network = sys.argv[1], sys.argv[2]

n = 0
for c in addr:
    n = n * 58 + A.index(c)
raw = n.to_bytes((n.bit_length() + 7) // 8, 'big')
raw = b'\x00' * (len(addr) - len(addr.lstrip('1'))) + raw
body, checksum = raw[:-4], raw[-4:]

def die(msg):
    sys.stderr.write("FAUCET_MINER_ADDRESS %s\nGot: %s\n" % (msg, addr))
    raise SystemExit(1)

# Length before indexing, so a short payload reports itself instead of raising
# an IndexError that reads like a bug in this script.
if len(body) != 22:
    die("decodes to %d bytes, and a transparent address is 22 (2 version + 20 hash)" % len(body))

if hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4] != checksum:
    die("failed its base58check checksum, so it is a typo.\n"
        "The prefix and length are right, which is why nothing else caught it.")

# The checksum only proves the string is internally consistent. It says nothing
# about WHICH network or type the payload is for, so a well-formed address for
# something else passes it. Verified reachable rather than assumed: version 0x1d26
# is one off testnet P2PKH and still renders as tm..., so it survives the prefix
# regex, the alphabet check, the length check and the checksum. Same for 0x1cbb
# rendering as t2....
VERSIONS = {
    "testnet": {b"\x1d\x25": "tm (P2PKH)", b"\x1c\xba": "t2 (P2SH)"},
    "mainnet": {b"\x1c\xb8": "t1 (P2PKH)", b"\x1c\xbd": "t3 (P2SH)"},
}
allowed = VERSIONS.get(network, VERSIONS["testnet"])
version = bytes(body[:2])
if version not in allowed:
    die("has version bytes %s, which is not a %s transparent address.\n"
        "Expected one of: %s.\n"
        "The checksum passed, so this is a valid address for something else, not a typo."
        % (version.hex(), network, ", ".join("%s=%s" % (v.hex(), n) for v, n in allowed.items())))
PY
}

# The declared image versions, which until now nothing consumed. stack-versions.env
# was read only by audit-drift.sh, so bumping a pin changed what the audit EXPECTED
# and nothing about what ran: the audit would report drift against a box that never
# moved. A pin that describes intent and cannot cause it is not a pin.
#
# Emitted into the same generated override as the miner address, for the reason that
# file exists: the z3 clone stays pristine so a rebuild is reproducible.
VERSIONS_FILE="$HERE/z3/stack-versions.env"
ZEBRA_IMG=""; ZALLET_IMG=""; ZAINO_IMG=""
if [ -f "$VERSIONS_FILE" ]; then
  # shellcheck disable=SC1090
  . "$VERSIONS_FILE"
  ZEBRA_IMG="${Z3_ZEBRA_IMAGE:-}"; ZALLET_IMG="${Z3_ZALLET_IMAGE:-}"; ZAINO_IMG="${Z3_ZAINO_IMAGE:-}"
  # Empty is deliberate, not an oversight: Z3_ZALLET_IMAGE ships unset because the
  # running tag is only knowable from the box, and a guessed version under review is
  # worse than an admitted gap. Skipping it leaves z3's own default in place.
  for pair in "zebra:$ZEBRA_IMG" "zallet:$ZALLET_IMG" "zaino:$ZAINO_IMG"; do
    [ -n "${pair#*:}" ] || say "NOTE: ${pair%%:*} has no pinned image in stack-versions.env, using z3's default"
  done
fi

if [ -n "$MINER_ADDRESS" ]; then
  validate_miner_address "$MINER_ADDRESS"
  say "Pointing mining rewards at $MINER_ADDRESS"
else
  say "NOTE: FAUCET_MINER_ADDRESS is unset, so zebra gets no miner address."
  say "      The faucet will serve but will not mine its own funds."
fi

# Whether we may WRITE the override is a separate question from whether we have
# anything to put in it, and conflating the two is how giving pins a reason to write
# this file turned the mining warnings below into dead code. stack-versions.env is
# committed, so on a real box a pin is always present: the old `elif [ -f $OVERRIDE ]`
# guard could no longer be reached, and an override holding a miner address would have
# been rewritten without one. Same silent unfunding as a duplicate YAML key, arriving
# by a different route.
#
# So: with no address of our own, an existing override decides. If we generated it we
# know every key in it and can carry the address forward. If we did not, it is the
# hand-written file this replaces and it is not ours to overwrite for a pin.
CARRY_ADDRESS=""
KEEP_REASON=""
if [ -z "$MINER_ADDRESS" ] && [ -f "$OVERRIDE" ]; then
  if grep -q '^# GENERATED by deploy/deploy.sh' "$OVERRIDE"; then
    found=$(grep -c 'ZEBRA_MINING__MINER_ADDRESS:' "$OVERRIDE" || true)
    if [ "$found" = 1 ]; then
      CARRY_ADDRESS=$(sed -n 's/.*ZEBRA_MINING__MINER_ADDRESS: *"\(.*\)".*/\1/p' "$OVERRIDE")
      # Validated even though we wrote it: the file could have been hand-edited since,
      # and a bad address there means every block reward is being lost right now. That
      # is worth stopping a deploy over, same as a bad FAUCET_MINER_ADDRESS.
      validate_miner_address "$CARRY_ADDRESS"
      say "NOTE: carrying the miner address already in $OVERRIDE forward."
      say "      Still not reproducible: a rebuild loses it, since the variable is unset."
    elif [ "$found" != 0 ]; then
      # More than one is a shape we do not emit, so we cannot say which one is live.
      KEEP_REASON="it names the miner address $found times, which is not a file we wrote"
    fi
  else
    KEEP_REASON="it was not generated by this script"
  fi
fi

EFF_ADDRESS="${MINER_ADDRESS:-$CARRY_ADDRESS}"

if [ -n "$KEEP_REASON" ]; then
  say "WARNING: keeping $OVERRIDE untouched, $KEEP_REASON."
  say "         Mining is unchanged, and the image pins were NOT applied: the stack"
  say "         keeps whatever tags it is running. It is NOT reproducible, a rebuild"
  say "         loses this file. Set FAUCET_MINER_ADDRESS to let the deploy own it."
# ONE block per service, because a service named twice in the same YAML file is not a
# merge: the later key wins and the earlier one is silently dropped. My first version
# emitted zebra twice, once for the miner address and once for the image, which would
# have quietly unfunded the box. Caught by generating the file and reading it.
elif [ -n "$MINER_ADDRESS$CARRY_ADDRESS" ] || [ -n "$ZEBRA_IMG$ZALLET_IMG$ZAINO_IMG" ]; then
  {
    echo "# GENERATED by deploy/deploy.sh from FAUCET_MINER_ADDRESS and z3/stack-versions.env."
    echo "# Do not hand-edit: the next deploy overwrites this file. Change the inputs instead."
    echo "services:"
    if [ -n "$EFF_ADDRESS" ] || [ -n "$ZEBRA_IMG" ]; then
      echo "  zebra:"
      [ -n "$ZEBRA_IMG" ] && echo "    image: \"$ZEBRA_IMG\""
      if [ -n "$EFF_ADDRESS" ]; then
        echo "    environment:"
        echo "      ZEBRA_MINING__MINER_ADDRESS: \"$EFF_ADDRESS\""
      fi
    fi
    [ -n "$ZALLET_IMG" ] && { echo "  zallet:"; echo "    image: \"$ZALLET_IMG\""; }
    [ -n "$ZAINO_IMG" ]  && { echo "  zaino:";  echo "    image: \"$ZAINO_IMG\""; }
    true
  } > "$OVERRIDE"
fi

# Authorize the faucet on Zallet's RPC. The config gets a HASH, never the password.
#
# It used to get `password = "..."` in plaintext, and #176 is what that costs: a
# routine diagnostic grep of this file for the wallet database path printed the
# credential into tooling output, a transcript and an IPC archive. Nothing was
# published, but a wallet RPC credential that has been through logs is exposed, and
# anything that can reach that port can move funds. The layout is the fix, because
# the next person debugging this file will grep it the same way.
#
# zallet supports `pwhash` instead, mutually exclusive with `password`, and warns on
# startup when you use the bare form. The scheme is Bitcoin Core's:
#
#   pwhash = "<salt>$<hex(HMAC-SHA256(key = the salt's ASCII hex, msg = password))>"
#
# Read out of zallet-core's authorization.rs rather than guessed, and confirmed
# against the wallet's own `add-rpc-user` output: for one password and salt, this
# generator and zallet produce the same hash, and keying the HMAC with the salt's raw
# bytes instead of its hex text does NOT, so that check tells the two apart.
#
# `add-rpc-user` cannot do this for us. It requires a TTY and only PRINTS a block to
# paste, leaving the config untouched, so a deploy cannot call it.
ZCFG="config/$NETWORK/zallet.toml"
PWFILE="$HERE/.zallet-rpc-password"

zallet_pwhash() { # $1 password -> salt$hash
  python3 - "$1" <<'PY'
import hmac, hashlib, os, sys
salt = os.urandom(16).hex()
print("%s$%s" % (salt, hmac.new(salt.encode(), sys.argv[1].encode(), hashlib.sha256).hexdigest()))
PY
}

# Every question below is about the FAUCET's auth block, never about the file. A box
# can carry another operator's [[rpc.auth]] entry, and my first version grepped the
# whole config: another person's plaintext password would have rotated OUR credential
# and then refused the deploy over a line that is not ours to fix.
faucet_auth_kind() { # -> plaintext | pwhash | none
  python3 - "$1" <<'PY'
import re, sys
try:
    src = open(sys.argv[1]).read()
except OSError:
    print("none"); raise SystemExit
for m in re.finditer(r'\[\[rpc\.auth\]\]\s*\n(?:[ \t]*\S+[ \t]*=.*\n?)*', src):
    b = m.group(0)
    if not re.search(r'^\s*user\s*=\s*"faucet"\s*$', b, re.MULTILINE):
        continue
    if re.search(r'^\s*password\s*=', b, re.MULTILINE):
        print("plaintext"); break
    if re.search(r'^\s*pwhash\s*=', b, re.MULTILINE):
        print("pwhash"); break
else:
    print("none")
PY
}

# PWFILE is the single source of truth, and both derived files are rewritten from it
# every run. That is deliberate: the old code wrote the config once and never looked
# again, so config and env could disagree with nothing to reconcile them. Deriving
# both means an interrupted run converges on the next one instead of leaving the
# faucet holding a password the wallet no longer accepts.
if [ "$(faucet_auth_kind "$ZCFG")" = "plaintext" ]; then
  # Plaintext in the config is the exposed credential. Hashing the SAME password
  # would hide it while leaving it valid, so this rotates as it migrates: the value
  # that leaked stops working. That is the whole point of #176.
  say "Rotating the Zallet RPC password: the config held it in plaintext (#176)"
  say "  the old value stops working, and the config gets a hash from now on"
  rm -f "$PWFILE"
fi

if [ ! -s "$PWFILE" ]; then
  say "Authorizing the faucet on Zallet's RPC"
  RPCPW="$(openssl rand -hex 24)"
  # Written 600 BEFORE the secret goes in, not after, so it is never briefly world
  # readable on a box where someone else is looking.
  ( umask 077; printf '%s\n' "$RPCPW" > "$PWFILE" )
  chmod 600 "$PWFILE"
fi
RPCPW="$(cat "$PWFILE")"

# Reconcile the config with PWFILE. Any faucet auth block is replaced wholesale
# rather than edited in place, because a partial edit is how you end up with both a
# password and a pwhash set, which zallet refuses outright.
python3 - "$ZCFG" "$(zallet_pwhash "$RPCPW")" <<'PY'
import re, sys
path, pwhash = sys.argv[1], sys.argv[2]
src = open(path).read()
# Only the block whose user is faucet. Other operators' entries are not ours to touch.
block = re.compile(
    r'\n*\[\[rpc\.auth\]\]\s*\n(?:[ \t]*[a-z_]+[ \t]*=.*\n?)*',
    re.MULTILINE)
kept = []
for m in block.finditer(src):
    if re.search(r'^\s*user\s*=\s*"faucet"\s*$', m.group(0), re.MULTILINE):
        kept.append(m.span())
for start, end in reversed(kept):
    src = src[:start] + "\n" + src[end:]
src = src.rstrip("\n") + '\n\n[[rpc.auth]]\nuser = "faucet"\npwhash = "%s"\n' % pwhash
open(path, "w").write(src)
PY
# Verified after writing, because "the code that writes it looks right" is not the same
# claim. Both failure directions are worth dying over: plaintext still present is #176
# unfixed, and a block carrying both keys makes zallet refuse to start at all.
case "$(faucet_auth_kind "$ZCFG")" in
  pwhash) : ;;
  plaintext)
    echo "REFUSING TO CONTINUE: the faucet's auth block in $ZCFG still has a plaintext" >&2
    echo "password after being rewritten. That is #176 unfixed, so this stops here" >&2
    echo "rather than deploying it." >&2
    exit 1 ;;
  *)
    echo "REFUSING TO CONTINUE: no faucet pwhash in $ZCFG after rewriting it, so the" >&2
    echo "wallet would reject the faucet and every drip would fail." >&2
    exit 1 ;;
esac

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
# A candidate RATE_LIMIT_SALT, generated the same way as the Zallet RPC password
# above. Only USED when the env has no real salt yet (see write_env): a real one
# is never overwritten, because the salt both signs PoW challenges and salts the
# ledger fingerprints, so rotating it invalidates every live challenge AND
# effectively resets every cooldown. Generating unconditionally and choosing
# later keeps that decision in one place.
SALT_CANDIDATE="$(openssl rand -hex 32)"

write_env(){  # $1 = account uuid, $2 = address
  [ -f "$ENVOUT" ] || cp "$HERE/z3/faucet.env.example" "$ENVOUT"
  python3 - "$ENVOUT" "$RPCPW" "$1" "$2" "$SALT_CANDIDATE" <<'PY'
import re,sys
f,pw,uuid,addr,salt=sys.argv[1:6]; s=open(f).read()
vals={"ZALLET_RPC_USER":"faucet","ZALLET_RPC_PASSWORD":pw}
if uuid: vals["ZALLET_ACCOUNT"]=uuid
if addr: vals["ZALLET_ADDRESS"]=addr
for k,v in vals.items(): s=re.sub(rf'(?m)^{k}=.*$', f'{k}={v}', s)
# Keys that must be PRESENT even on a box whose faucet.env predates them. The
# rewrite above only touches a line that already exists, and the example file is
# copied exactly once on a fresh box, so adding a line to faucet.env.example
# never reaches an existing deployment. Append when absent, never overwrite: an
# operator who has set a value keeps it (#172, #177).
for k,v in [("FAUCET_SHIELD_COINBASE","false")]:
    if re.search(rf'(?m)^{k}=', s) is None:
        s = s.rstrip("\n") + f"\n\n# Whether the reserve loop may sweep coinbase we already own into the wallet.\n# Separate from mining on purpose (#172). Broadcasts a transaction, so it stays\n# an explicit authorisation: set true only deliberately.\n{k}={v}\n"
# RATE_LIMIT_SALT: generate a real one rather than leaving a placeholder the app
# refuses to boot on (#173). This used to swap one placeholder for another and
# print a NOTE, so a deploy reported success for an env that crash-looped: the
# app treats a known salt as fatal, correctly, because the PoW gate is signed
# with it. Now a fresh box comes up secure without hand-holding.
#
# Markers must match PLACEHOLDER_MARKERS in src/lib/saltGuard.ts. They are
# duplicated because a shell script cannot import TypeScript, and the deploy
# suite has a check that fails if the two lists drift apart.
PLACEHOLDER_MARKERS = ("__fill_me__", "change-me", "changeme")
m = re.search(r'(?m)^RATE_LIMIT_SALT=(.*)$', s)
current = (m.group(1).strip() if m else "")
needs_salt = (
    m is None
    or not current
    or any(k in current.lower() for k in PLACEHOLDER_MARKERS)
)
if needs_salt:
    if m is None:
        s = s.rstrip("\n") + f"\n\n# Signs the anti-abuse challenges and salts the ledger fingerprints.\n# Generated by deploy.sh. Rotating it resets every cooldown.\nRATE_LIMIT_SALT={salt}\n"
    else:
        s = re.sub(r'(?m)^RATE_LIMIT_SALT=.*$', f'RATE_LIMIT_SALT={salt}', s)
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
# A successful deploy must not produce an env the app will refuse to boot on
# (#173). write_env generates a real salt, so a surviving placeholder means that
# logic did not run or did not match, and the app would crash-loop on it. Fail
# here, where the cause is, rather than one restart later in a container log.
#
# Checks every marker saltGuard.ts rejects, not just our own __FILL_ME__: a
# hand-edited env can carry change-me and the old check never looked for it.
if grep -qiE 'RATE_LIMIT_SALT=.*(__fill_me__|change-me|changeme)' "$ENVOUT"; then
  say "FATAL: $ENVOUT still holds a placeholder RATE_LIMIT_SALT."
  say "       The app signs anti-abuse challenges with it and refuses to start on a"
  say "       known value, so this deploy would crash-loop. Set a real secret:"
  say "         RATE_LIMIT_SALT=\$(openssl rand -hex 32)"
  exit 1
fi
# The env file changed, so compose recreates the app container with the
# account wired. A no-op when nothing changed, this is what makes re-runs safe.
say "Restarting the faucet with the account wired"
overlay_up

# Do not announce success without checking it. This line used to print "the
# faucet is live" for having been REACHED, and nothing looked. overlay_up happens
# before the hours-long sync wait, so a box whose app could not boot crash-looped
# through the whole sync with the last thing on screen saying it worked (#206).
# Same shape as the watchdog announcing 812 recoveries it never verified (#175):
# a report derived from control flow instead of from the thing it describes.
#
# Asked of compose by SERVICE name rather than grepped for a container name:
# compose derives the project from the directory, so the real containers are
# z3-faucet-1 while the harness models zcash-faucet-faucet-1 — a name grep would
# pass in tests and go blind in production, which is backwards for a check whose
# only job is honesty.
#
# Sampled twice, because a container in a restart loop passes through `running`
# on its way round and one look can land on the good frame.
#
# This proves the process STAYS UP. It does not prove the faucet serves correct
# responses — a container answering 500 to everything reads as running here — so
# the wording claims only what was observed.
faucet_status(){  # running | not-running | cannot-tell
  local cid s1 s2
  cid="$( cd "$HERE/z3" && docker compose -f docker-compose.faucet.yml ps -q faucet 2>/dev/null | head -n1 )"
  [ -n "$cid" ] || { printf 'cannot-tell'; return 0; }
  s1="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null)" || { printf 'cannot-tell'; return 0; }
  sleep "${DEPLOY_HEALTH_SETTLE_SECS:-5}"
  s2="$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null)" || { printf 'cannot-tell'; return 0; }
  if [ "$s1" = running ] && [ "$s2" = running ]; then printf 'running'
  else printf 'not-running'; fi
}

case "$(faucet_status)" in
  not-running)
    say "DEPLOY INCOMPLETE: everything is installed, but the faucet container is
   not staying up, so the site is NOT serving. Nothing above failed — this is the
   app refusing to boot or crashing on start, and the reason is in its log:
       cd $HERE/z3 && docker compose -f docker-compose.faucet.yml logs --tail=50 faucet
   Re-run this script once the cause is fixed; it is safe to re-run."
    exit 1
    ;;
  cannot-tell)
    say "Everything is installed, but I could not read the faucet container's
   state, so I cannot tell you whether the site is serving. Check it yourself:
       curl -s ${FAUCET_DOMAIN:+https://$FAUCET_DOMAIN}${FAUCET_DOMAIN:-http://localhost}/api/status"
    exit 1
    ;;
esac

say "Done. The faucet is live${FAUCET_DOMAIN:+ at https://$FAUCET_DOMAIN}."
echo "   Check:   curl -s ${FAUCET_DOMAIN:+https://$FAUCET_DOMAIN}${FAUCET_DOMAIN:-http://localhost}/api/status"
echo "   Fund it: send $NETWORK ZEC to  $ADDR"
echo "            (until funded, claims answer 'faucet empty' — everything else works)"

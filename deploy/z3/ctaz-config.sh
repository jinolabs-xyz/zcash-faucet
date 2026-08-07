#!/usr/bin/env bash
# BUILD THE cTAZ NODE CONFIG FROM THEIR OWN `generate`, CHANGING ONLY WHAT WE MUST.
#
# WHY THIS IS A SCRIPT AND NOT A CHECKED-IN TOML. Their config carries the whole resolved
# feature-net definition: ClT0 magic, genesis 05a60a92..., NU6 activation, funding streams,
# ten lockbox disbursements and a trusted checkpoint. Checking a copy of that into this
# repo would be checking in a snapshot of THEIR consensus parameters and pretending it is
# ours to maintain. When they move the checkpoint or add a hardfork, a stale copy does not
# fail loudly, it syncs a chain nobody else is on.
#
# So: generate it with the pinned binary, then apply our five deltas on top.
#
# WHY NOT A HAND-WRITTEN CONFIG. Because I tried that first and it cost an hour. A config
# with `network = "Testnet"` and no [network.testnet_parameters] is the real Zcash testnet,
# and their node aborts on it with `unhandled special-case genesis` at start.rs:428. The
# network parameters are not optional decoration around the keys you care about.
#
# Editing is section-aware: `listen_addr` exists under BOTH [network] and [rpc], and a
# plain sed would rewrite whichever came first and leave the other at their default.
#
# EXIT CODES, matching the other ops scripts:
#   0  config written
#   1  KNOWN-BAD, a key we must set is not in their output (renamed upstream?)
#   2  CANNOT-VERIFY, the binary is missing or `generate` failed
set -uo pipefail

BIN="${CTAZ_BIN:-/opt/faucet/ctaz-zebrad}"
OUT="${1:-/etc/faucet/ctaz-zebrad.toml}"
DATADIR="${CTAZ_DATADIR:-/mnt/ctaz-chain/node}"
BASE_PORT="${CTAZ_BASE_PORT:-19233}"

log() { echo "$(date -u +%FT%TZ) ctaz-config: $*"; }

[ -x "$BIN" ] || { log "CANNOT VERIFY: no executable at $BIN"; exit 2; }

tmp="$(mktemp -d)" || { log "CANNOT VERIFY: could not make a temp dir"; exit 2; }
trap 'rm -rf "$tmp"' EXIT

# `generate` writes relative to cwd on some paths, so run it somewhere disposable.
( cd "$tmp" && "$BIN" generate -o "$tmp/generated.toml" ) >/dev/null 2>&1
[ -s "$tmp/generated.toml" ] || { log "CANNOT VERIFY: '$BIN generate' produced nothing"; exit 2; }

# The RPC port is base-1 and that is not a preference: their embedded zaino derives it and
# will not be told otherwise.
rpc_port=$((BASE_PORT - 1))

# section<TAB>key<TAB>value. Cookie auth stays at their shipped `false` on purpose: their
# in-process zaino is built against the no-cookie path and exits with an authorisation
# error when it is on, taking zebrad down with it. The RPC is loopback-only, and our
# containers are bridged so they cannot reach the host's loopback at all.
#
# internal_miner is false because a fresh node with no peers believes it is at the tip and
# starts mining a fork of genesis within seconds. Turn it on after the sync (CTAZ.md).
#
# THE SYNC LIMITS ARE A MEMORY BOUND, NOT A SPEED SETTING, and they are here because the
# node OOM-killed four times: twice at MemoryMax=2G and twice more at 3G, with
# memory.events recording 18012 hits against the 3G ceiling. Raising the cap a third time
# was explicitly ruled out when it was raised the second time (#363): a limit that has to
# keep growing is not a limit.
#
# Their defaults (1000 / 50 / 20) are sized for a machine doing nothing else. This box
# also runs the TAZ node, the wallet and a miner, and the buffers these govern are held in
# memory per in-flight block. Lowering them trades sync throughput for a ceiling we can
# actually hold, which is the right trade now that the chain is AT TIP and there is no
# throughput left to want.
#
# If it still climbs to the cap at tip, the concurrency was never the consumer and the
# next suspect is the in-process indexer: `crosslink.disable_zaino`. Do NOT flip that
# blind, the headless wallet may source its balance through it, and that wallet is what
# `requestfaucetdonation` pays from.
edits=$(printf '%s\n' \
  "network	listen_addr	\"[::]:${BASE_PORT}\"" \
  "rpc	listen_addr	\"127.0.0.1:${rpc_port}\"" \
  "rpc	enable_cookie_auth	false" \
  "rpc	cookie_dir	\"${DATADIR}\"" \
  "state	cache_dir	\"${DATADIR}\"" \
  "sync	checkpoint_verify_concurrency_limit	250" \
  "sync	download_concurrency_limit	20" \
  "sync	full_verify_concurrency_limit	10" \
  "mining	internal_miner	false")

# KEYS THEIR GENERATED CONFIG DOES NOT CONTAIN, so they are INSERTED rather than replaced.
# The awk above deliberately fails on a key it cannot find, which is right for keys they
# ship and might rename - but miner_address is one they support and simply omit from the
# default, so a missing-key failure would be wrong here.
#
# MINING INTO THE POOL THE FAUCET SPENDS FROM, which is the whole point (#328).
#
# Measured on the live node: we mine well (93 accepted blocks in 24 hours) and every
# reward lands in a TRANSPARENT address, a fresh one per block. requestfaucetdonation
# calls send_orchard_to_orchard_zats, so it spends the ORCHARD pool, which stays empty
# forever. The faucet accepted a claim, returned its fixed {"amount": 50000000}, and
# moved nothing - exactly what #328 exists to catch.
#
# Their coinbase builder already handles this. From new_coinbase in
# zebra-rpc/src/methods/types/transaction.rs, a unified address is matched
# orchard-first: `addr.orchard().and_then(add_shielded_reward)`, falling back to
# sapling then transparent. So pointing miner_address at a UA with an Orchard receiver
# routes the reward into Orchard with no code change at all.
#
# AND IT BECOMES IRONWOOD ON ITS OWN AT NU6.3. Their comment, verbatim: "a unified miner
# address with an Orchard receiver just gets routed to the Ironwood output builder from
# NU6.3 onward". This chain is NU6 today (getblockchaininfo upgrades), and Ironwood's
# chain value pool is empty until NU6.3 transactions appear, so Orchard is correct now
# and the same config keeps working through the upgrade.
#
# THE ADDRESS IS THE NODE'S OWN WALLET AND CANNOT BE HARDCODED HERE. It is derived from
# that node's seed, so a rebuilt box has a different one. The node prints it at startup:
#
#   journalctl -u ctaz-node | grep "MINER WALLET ADDRESS"
#
# Put it in /etc/faucet/ctaz.env as CTAZ_MINER_ADDRESS. Unset leaves the config exactly
# as it is today - transparent rewards and a faucet that cannot pay - which is a poor
# state but not a broken one, and better than this script inventing an address.
inserts=""
if [ -n "${CTAZ_MINER_ADDRESS:-}" ]; then
  case "$CTAZ_MINER_ADDRESS" in
    utest1*|u1*) ;;
    *) log "KNOWN BAD: CTAZ_MINER_ADDRESS is not a unified address: ${CTAZ_MINER_ADDRESS%%1*}1..."
       log "  A transparent or sapling address here would keep the reward OUT of the Orchard"
       log "  pool that requestfaucetdonation spends, which is the bug this setting fixes."
       exit 1 ;;
  esac
  inserts="mining	miner_address	\"${CTAZ_MINER_ADDRESS}\""
fi

awk -v edits="$edits" -v inserts="$inserts" '
BEGIN {
  n = split(edits, rows, "\n")
  for (i = 1; i <= n; i++) {
    split(rows[i], f, "\t")
    want[f[1] SUBSEP f[2]] = f[3]
  }
  m = split(inserts, irows, "\n")
  for (i = 1; i <= m; i++) {
    if (irows[i] == "") continue
    split(irows[i], g, "\t")
    add[g[1]] = add[g[1]] g[2] " = " g[3] "\n"
  }
}
# Emitted immediately after the section header, so the key lands INSIDE its own section.
# Appending at end of file would put it under whatever section happens to be last, which
# TOML would read as a different key entirely.
/^\[+[^]]+\]/ {
  section = $0; gsub(/^\[+|\]+$/, "", section)
  if (section in add) { print; printf "%s", add[section]; delete add[section]; next }
}
{
  if (match($0, /^[A-Za-z_][A-Za-z0-9_]*[ \t]*=/)) {
    key = $0; sub(/[ \t]*=.*$/, "", key)
    if ((section SUBSEP key) in want) {
      print key " = " want[section SUBSEP key]
      seen[section SUBSEP key] = 1
      next
    }
  }
  print
}
END {
  for (k in want) if (!(k in seen)) { split(k, p, SUBSEP); print "MISSING [" p[1] "] " p[2] > "/dev/stderr" }
}
' "$tmp/generated.toml" > "$tmp/final.toml" 2> "$tmp/missing"

if [ -s "$tmp/missing" ]; then
  log "KNOWN BAD: keys we must set are not in their generated config:"
  sed 's/^/  /' "$tmp/missing"
  log "  They renamed or removed these upstream. Do NOT ship a config that silently"
  log "  leaves them at their defaults: the defaults point at /root/.cache/zebra and"
  log "  port 8233, which is a node writing to the wrong disk on the wrong port."
  exit 1
fi

# Prove the deltas landed by reading the file back, not by trusting the awk above.
if ! grep -qF "cache_dir = \"${DATADIR}\"" "$tmp/final.toml"; then
  log "KNOWN BAD: wrote the config but cache_dir is not ${DATADIR} on re-read"
  exit 1
fi

install -m 0640 "$tmp/final.toml" "$OUT" || { log "CANNOT VERIFY: could not write $OUT"; exit 2; }
chgrp ctaz "$OUT" 2>/dev/null || log "note: no ctaz group yet, leaving group ownership alone"

log "wrote $OUT"
log "changes from their generated default:"
diff "$tmp/generated.toml" "$tmp/final.toml" | sed 's/^/  /'
exit 0

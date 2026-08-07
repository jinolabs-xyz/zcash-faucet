# shellcheck shell=bash
# ctaz-config.sh: generates the Crosslink node's config from THEIR generate output plus
# our deltas.
#
# THIS SCRIPT HAD NO SUITE UNTIL #328 MADE IT MATTER. It decides the datadir, the ports,
# the sync memory bounds and now the miner payout address, and nothing checked any of it.
# That is the shape install-ops's own header describes: "no suite and shipped broken for
# weeks". The miner_address work is what finally made the gap expensive enough to close.
#
# The binary is stubbed, because the real one generates a 200-line config and the thing
# under test is our editing, not their defaults.

CTAZ_CONFIG="$REPO/deploy/z3/ctaz-config.sh"

cc_env() {
  mk_scratch "${TMPDIR:-/tmp}/ctazconfig-test.XXXXXX"
  export CTAZ_BIN="$T/zebrad-stub"
  export CTAZ_DATADIR="$T/chain"
  export CTAZ_BASE_PORT=19233
  unset CTAZ_MINER_ADDRESS 2>/dev/null || true
  # Their generate output, trimmed to the sections we edit. [mining] carries
  # internal_miner and NOT miner_address, which is the real shape: they support the key
  # and omit it from the default, so it has to be INSERTED rather than replaced.
  cat > "$T/zebrad-stub" <<'STUB'
#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2;; *) shift;; esac; done
cat > "${out:-/dev/stdout}" <<'TOML'
[network]
listen_addr = "0.0.0.0:8233"
cache_dir = true

[rpc]
listen_addr = "0.0.0.0:8232"
enable_cookie_auth = true
cookie_dir = "/root/.cache/zebra"

[state]
cache_dir = "/root/.cache/zebra"

[sync]
checkpoint_verify_concurrency_limit = 1000
download_concurrency_limit = 50
full_verify_concurrency_limit = 20

[mining]
internal_miner = true

[tracing]
force_use_color = false
TOML
STUB
  chmod +x "$T/zebrad-stub"
}

echo "== ctaz-config: the deltas land, and the file is read back to prove it"
cc_env
bash "$CTAZ_CONFIG" "$T/out.toml" > "$T/base.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "the datadir is ours, not their /root/.cache default" \
  "grep -q 'cache_dir = \"$T/chain\"' '$T/out.toml'"
check "the RPC is loopback at base-1, which their zaino derives" \
  "grep -q 'listen_addr = \"127.0.0.1:19232\"' '$T/out.toml'"
check "cookie auth stays false, or their in-process zaino kills the node" \
  "grep -q 'enable_cookie_auth = false' '$T/out.toml'"
check "internal_miner is off until someone turns it on deliberately" \
  "grep -q 'internal_miner = false' '$T/out.toml'"

echo "== ctaz-config: NO miner_address unless one is configured"
# Unset must leave the config exactly as it was. Inventing an address would send the
# block rewards somewhere nobody chose.
check "absent by default" "! grep -q 'miner_address' '$T/out.toml'"

echo "== ctaz-config: MINING INTO THE POOL THE FAUCET SPENDS FROM (#328)"
# The whole point. requestfaucetdonation calls send_orchard_to_orchard_zats, so it spends
# ORCHARD. Rewards were landing in transparent addresses, so the pool stayed empty and
# every claim returned {"amount": 50000000} and moved nothing. Their coinbase builder
# routes a unified address orchard-first, so this one key fixes it.
cc_env
UA="utest14wa0pcf7uusm364sz8ewd0kg5x7fud4nmph6nm55f300l658nmaa0tstc6hssfnn44gw90utujn4wsrl7u6kuvel6yya8muzgcz6tyz9"
CTAZ_MINER_ADDRESS="$UA" bash "$CTAZ_CONFIG" "$T/out.toml" > "$T/mine.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "miner_address is written" "grep -q 'miner_address = \"$UA\"' '$T/out.toml'"

echo "== ctaz-config: and it lands INSIDE [mining], not wherever the file happened to end"
# The assertion that makes the one above mean something. A key appended at end of file
# would sit under [tracing] and TOML would read it as tracing.miner_address, which is a
# different key that silently does nothing.
section="$(awk '/^\[mining\]/{f=1;next} /^\[/{f=0} f' "$T/out.toml")"
check "miner_address is in the [mining] section" "printf '%s' \"$section\" | grep -q 'miner_address'"
check "and internal_miner is still there beside it" "printf '%s' \"$section\" | grep -q 'internal_miner'"
check "the LAST section did not absorb it" \
  "! awk '/^\[tracing\]/{f=1;next} /^\[/{f=0} f' '$T/out.toml' | grep -q 'miner_address'"

echo "== ctaz-config: a NON-unified miner address is refused, not written"
# A transparent address here would be accepted by their builder and keep the reward out
# of Orchard, which is the exact bug being fixed - so it must fail loudly rather than
# look like it worked.
cc_env
CTAZ_MINER_ADDRESS="tmRB9AEVsxNAQsqtJPqJUje9KCaAijpS77z" bash "$CTAZ_CONFIG" "$T/out.toml" > "$T/bad.log" 2>&1
check "exits nonzero" "[ $? -ne 0 ]"
check "says why, naming the pool" "grep -q 'Orchard' '$T/bad.log'"
check "and wrote no config at all" "[ ! -s '$T/out.toml' ] || ! grep -q 'miner_address' '$T/out.toml'"

echo "== ctaz-config: a key they RENAME still fails the run, which the insert must not weaken"
# The pre-existing guard. Adding an insert pass must not turn a missing REPLACE key into
# a silent default: their /root/.cache and port 8233 defaults are a node on the wrong
# disk and the wrong port.
cc_env
sed -i.bak 's/^cache_dir = "\/root\/.cache\/zebra"/renamed_cache_dir = "\/root\/.cache\/zebra"/' "$T/zebrad-stub" 2>/dev/null || \
  perl -pi -e 's/^cache_dir = "\/root\/\.cache\/zebra"/renamed_cache_dir = "\/root\/.cache\/zebra"/' "$T/zebrad-stub"
bash "$CTAZ_CONFIG" "$T/out2.toml" > "$T/renamed.log" 2>&1
check "a renamed key still fails the run" "[ $? -ne 0 ]"
check "and names it as KNOWN BAD" "grep -q 'KNOWN BAD' '$T/renamed.log'"

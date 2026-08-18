# shellcheck shell=bash
# Watchdog supervision tests. The bug these exist for: the watchdog announced
# "recovered <name>" whenever `docker start` exited 0, which for a crash-looping
# container is every single time. In production that produced 812 "recovered"
# alerts for one container over 16 hours while the wallet was never up, and
# because every message said success, nothing ever escalated.
#
# So the assertions here are mostly about what must NOT be said.

WD="$REPO/deploy/z3/watchdog.sh"

# Environment for one bounded watchdog run. The faucet URL points at a closed
# port on purpose: liveness and readiness are other suites' business, and here
# they must not interfere with the container-state assertions.
wd_env() {
  mk_scratch "${TMPDIR:-/tmp}/wd-test.XXXXXX"
  export STUB_LOG="$T/stub.log"; : > "$STUB_LOG"
  export STUB_CONTAINERS="$T/containers"; mkdir -p "$STUB_CONTAINERS"
  export PATH="$SCRATCH/stubs:$BASE_PATH"
  export WATCHDOG_STATE_DIR="$T/state"
  export WATCHDOG_INTERVAL=0
  export WATCHDOG_FAUCET_URL="http://127.0.0.1:1"
  export WATCHDOG_ALERT_SH="$T/alert.sh"
  export WATCHDOG_READY_GRACE_SECS=999999   # never page for readiness in here
  export WATCHDOG_ZEBRA_MATCH=zebra WATCHDOG_ZALLET_MATCH=zallet WATCHDOG_FAUCET_MATCH=faucet-web
  unset STUB_CRASHLOOP
  # Capture what would have been paged, without a webhook.
  printf '#!/bin/sh\nprintf "%%s\\n" "$1" >> "%s/alerts.log"\n' "$T" > "$T/alert.sh"
  chmod +x "$T/alert.sh"
  : > "$T/alerts.log"
}

# Bounded twice over. MAX_TICKS is how the watchdog exits on its own; the outer
# timeout is so a suite can never hang on a build that ignores it - which the
# pre-fix watchdog did, having no way at all to run a finite number of sweeps.
wd_run() {
  if command -v timeout >/dev/null 2>&1; then
    WATCHDOG_MAX_TICKS="$1" timeout 20 bash "$WD" > "$T/run.log" 2>&1
  else
    WATCHDOG_MAX_TICKS="$1" bash "$WD" > "$T/run.log" 2>&1
  fi
  return 0
}
alerts() { cat "$T/alerts.log" 2>/dev/null; }

echo "== watchdog: a crash-looping container is never called recovered"
wd_env
echo restarting > "$STUB_CONTAINERS/z3-testnet-zallet-1"
echo running    > "$STUB_CONTAINERS/z3-testnet-zebra-1"
echo running    > "$STUB_CONTAINERS/faucet-web"
export STUB_CRASHLOOP="z3-testnet-zallet-1"
wd_run 1
# The precise regression: `docker start` succeeded, so the old code paged
# "recovered". Nothing about that start is evidence the container stayed up.
check "does not claim recovery from an accepted start alone" \
  "! grep -q 'recovered z3-testnet-zallet-1' '$T/alerts.log'"
check "says the recovery is unconfirmed instead" \
  "grep -q 'recovery UNCONFIRMED' '$T/run.log'"
check "counts the attempt" "grep -q 'consecutive attempt 1' '$T/run.log'"

echo "== watchdog: a persistent loop escalates instead of self-congratulating"
wd_env
echo restarting > "$STUB_CONTAINERS/z3-testnet-zallet-1"
export STUB_CRASHLOOP="z3-testnet-zallet-1"
wd_run 3
check "pages STILL BROKEN once the threshold is hit" \
  "grep -q 'STILL BROKEN: z3-testnet-zallet-1 has needed 3 consecutive restarts' '$T/alerts.log'"
check "and still never claims a recovery" "! grep -q 'recovered' '$T/alerts.log'"
# 812 identical pages is its own outage. One page at the threshold, then silence
# until the re-alert interval, is the behaviour we actually want.
check "pages once, not once per sweep" "[ \"\$(grep -c 'STILL BROKEN' '$T/alerts.log')\" = 1 ]"

echo "== watchdog: a real recovery is still reported, one sweep later"
wd_env
echo exited > "$STUB_CONTAINERS/z3-testnet-zallet-1"
wd_run 2   # sweep 1 starts it, sweep 2 sees it running and only then claims it
check "reports recovery when the container is actually up afterwards" \
  "grep -q 'recovered z3-testnet-zallet-1: running again, verified' '$T/alerts.log'"
check "and names how many attempts it took" \
  "grep -q 'after 1 restart attempt' '$T/alerts.log'"

echo "== watchdog: a healthy stack is silent"
wd_env
echo running > "$STUB_CONTAINERS/z3-testnet-zallet-1"
echo running > "$STUB_CONTAINERS/z3-testnet-zebra-1"
echo running > "$STUB_CONTAINERS/faucet-web"
wd_run 2
# Guard against the over-correction: if escalation logic pages on healthy
# containers, the pager becomes noise and gets ignored, which is how we got here.
check "no alerts at all for a stack that is fine" "[ ! -s '$T/alerts.log' ]"

echo "== watchdog: a corrupt flap file cannot take monitoring offline"
wd_env
echo restarting > "$STUB_CONTAINERS/z3-testnet-zallet-1"
export STUB_CRASHLOOP="z3-testnet-zallet-1"
mkdir -p "$WATCHDOG_STATE_DIR"
# A torn write. This used to reach $(( )) as the identifiers not - a - number,
# and under set -u an unbound name in arithmetic exits the shell: the watchdog
# died having watched nothing, and since the file survived, systemd's restart
# produced a crash loop in the component that exists to detect crash loops.
printf 'not-a-number' > "$WATCHDOG_STATE_DIR/z3-testnet-zallet-1.flaps"
wd_run 3
check "survives a corrupt count and keeps sweeping" "grep -q 'consecutive attempt 1' '$T/run.log'"
check "no unbound-variable death" "! grep -qi 'unbound variable' '$T/run.log'"
check "still escalates on a garbage count" "grep -q 'STILL BROKEN' '$T/alerts.log'"

echo "== watchdog: an unwritable state dir degrades, it does not go silent"
wd_env
echo restarting > "$STUB_CONTAINERS/z3-testnet-zallet-1"
export STUB_CRASHLOOP="z3-testnet-zallet-1"
mkdir -p "$WATCHDOG_STATE_DIR"; chmod 500 "$WATCHDOG_STATE_DIR"
wd_run 3
chmod 700 "$WATCHDOG_STATE_DIR"
# The escalation must still fire from the in-memory count. Persisting it is only
# so a restart remembers; if that is impossible we lose memory across restarts,
# not the paging itself.
check "escalates even when the count cannot be persisted" "grep -q 'STILL BROKEN' '$T/alerts.log'"
check "and says it is running in memory-only mode" "grep -q 'in-memory only' '$T/run.log'"

echo "== watchdog: an unanswerable docker is not treated as healthy"
wd_env
echo running > "$STUB_CONTAINERS/z3-testnet-zebra-1"
# Present to find_container, absent to inspect: the shape of a container that
# vanishes mid-sweep, or a daemon that stops answering about it.
printf 'zombie\n' > "$STUB_CONTAINERS/z3-testnet-zallet-1"
rm -f "$STUB_CONTAINERS/z3-testnet-zallet-1"
wd_run 1
check "does not page about a container it cannot see" "! grep -q 'STILL BROKEN' '$T/alerts.log'"
check "does not claim it recovered either" "! grep -q 'recovered' '$T/alerts.log'"

# --- step 6: miner stall recovery ------------------------------------------------
# The miner holds ONE persistent RPC connection to zebra and does not reconnect when
# zebra restarts: it loops "getblocktemplate: Peer disconnected" while its heartbeat
# stays fresh, so Restart=always never fires because the process never exits. 2026-08-18
# that was ~18h of no mining and nothing noticed. The watchdog reads the heartbeat and
# restarts a miner that is provably alive but not templating - and, crucially, does NOT
# touch a dead process, a freshly started one, or a healthy one.

# An ISO-8601 Zulu timestamp $1 seconds in the past, matching the heartbeat's format.
_ago_z() { date -u -d "$1 seconds ago" +%Y-%m-%dT%H:%M:%SZ; }

# Write a heartbeat: writtenAt/startedAt/lastTemplateAt as ages in seconds. A
# lastTemplateAt of "none" is emitted as JSON null (the miner has never templated).
miner_hb() {
  local lt
  if [ "$3" = "none" ]; then lt='null'; else lt="\"$(_ago_z "$3")\""; fi
  printf '{"schema":1,"writtenAt":"%s","startedAt":"%s","lastTemplateAt":%s,"lastTemplateHeight":4282310}\n' \
    "$(_ago_z "$1")" "$(_ago_z "$2")" "$lt" > "$T/heartbeat.json"
}

wd_miner_env() {
  wd_env
  echo running > "$STUB_CONTAINERS/z3-testnet-zallet-1"
  echo running > "$STUB_CONTAINERS/z3-testnet-zebra-1"
  echo running > "$STUB_CONTAINERS/faucet-web"
  export STUB_SYSTEMD="$T/systemd"; mkdir -p "$STUB_SYSTEMD"
  export WATCHDOG_MINER_HEARTBEAT="$T/heartbeat.json"
  export WATCHDOG_MINER_UNIT="zcash-testnet-miner.service"
}

echo "== watchdog: a miner alive but not templating is restarted"
wd_miner_env
miner_hb 5 3600 3600      # heartbeat 5s old (alive), started 1h ago, last template 1h ago
wd_run 1
check "restarts the miner unit" "grep -q 'systemctl restart zcash-testnet-miner.service' '$STUB_LOG'"
check "and says why, naming the stall" "grep -q 'miner was stalled' '$T/alerts.log'"

echo "== watchdog: a miner templating normally is left alone"
wd_miner_env
miner_hb 5 3600 10        # last template 10s ago: healthy
wd_run 2
check "does not restart a healthy miner" "! grep -q 'systemctl restart zcash-testnet-miner' '$STUB_LOG'"
check "and pages nothing about the miner" "! grep -qi 'miner' '$T/alerts.log'"

echo "== watchdog: a just-restarted miner is inside its start grace and is not bounced"
wd_miner_env
miner_hb 5 20 none        # started 20s ago (< grace), no template yet
wd_run 1
check "does not restart a miner still starting up" "! grep -q 'systemctl restart zcash-testnet-miner' '$STUB_LOG'"

echo "== watchdog: a dead miner PROCESS is left to Restart=always, not healed here"
wd_miner_env
miner_hb 600 3600 3600    # heartbeat 10m old: the process itself is down or hung
wd_run 1
check "does not restart when the heartbeat itself is stale" "! grep -q 'systemctl restart zcash-testnet-miner' '$STUB_LOG'"

echo "== watchdog: no heartbeat file means no miner action at all"
wd_miner_env
rm -f "$T/heartbeat.json"
wd_run 2
check "silent when there is no heartbeat to judge" "! grep -q 'systemctl restart zcash-testnet-miner' '$STUB_LOG'"

echo "== watchdog: a stall that will not clear escalates instead of restart-looping"
wd_miner_env
miner_hb 5 3600 3600
wd_run 5                  # WATCHDOG_MINER_HEAL_MAX defaults to 3
check "restarts exactly the cap, then stops" \
  "[ \"\$(grep -c 'systemctl restart zcash-testnet-miner.service' '$STUB_LOG')\" = 3 ]"
check "and pages once it gives up" "grep -q 'miner STILL stalled after 3 restart' '$T/alerts.log'"

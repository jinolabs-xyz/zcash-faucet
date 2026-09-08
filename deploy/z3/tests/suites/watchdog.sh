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
  # Exports persist across tests in one shell; clear the per-test switches so a value set
  # by an earlier case cannot leak into a later one (STUB_HEAL_FIXES=1 leaking into the
  # give-up case is exactly what made this suite lie once).
  # WATCHDOG_MINER_HEARTBEAT too: exported by the miner cases, it otherwise points every
  # later case at a stale, stalled heartbeat in an old scratch dir, and the miner heal
  # runs (and gives up, and pages) inside tests that are about something else.
  unset STUB_CRASHLOOP STUB_HEAL_FIXES STUB_ZEBRA_BLOCKS STUB_ZEBRA_EST STUB_ZEBRA_ADVANCE STUB_ZEBRA_STUCK_CALLS \
        WATCHDOG_NODE_HEAL_ENABLED WATCHDOG_NODE_STOPS_MINER WATCHDOG_MINER_HEARTBEAT WATCHDOG_MINER_UNIT STUB_START_FAIL
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
check "pages NEEDS YOU once the threshold is hit" \
  "grep -q 'NEEDS YOU: z3-testnet-zallet-1 crash loop: 3 consecutive restarts' '$T/alerts.log'"
check "and still never claims a fix" "! grep -q 'FIXED: z3-testnet-zallet-1' '$T/alerts.log'"
# 812 identical pages is its own outage. One page at the threshold, then silence
# until the re-alert interval, is the behaviour we actually want.
check "pages once, not once per sweep" "[ \"\$(grep -c 'NEEDS YOU' '$T/alerts.log')\" = 1 ]"

echo "== watchdog: a real recovery is still reported, one sweep later"
wd_env
echo exited > "$STUB_CONTAINERS/z3-testnet-zallet-1"
wd_run 2   # sweep 1 starts it, sweep 2 sees it running and only then claims it
check "reports the fix when the container is actually up afterwards" \
  "grep -q 'FIXED: z3-testnet-zallet-1 was down' '$T/alerts.log'"
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
check "still escalates on a garbage count" "grep -q 'NEEDS YOU' '$T/alerts.log'"

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
check "escalates even when the count cannot be persisted" "grep -q 'NEEDS YOU' '$T/alerts.log'"
check "and says it is running in memory-only mode" "grep -q 'in-memory only' '$T/run.log'"

echo "== watchdog: an unanswerable docker is not treated as healthy"
wd_env
echo running > "$STUB_CONTAINERS/z3-testnet-zebra-1"
# Present to find_container, absent to inspect: the shape of a container that
# vanishes mid-sweep, or a daemon that stops answering about it.
printf 'zombie\n' > "$STUB_CONTAINERS/z3-testnet-zallet-1"
rm -f "$STUB_CONTAINERS/z3-testnet-zallet-1"
wd_run 1
check "does not page about a container it cannot see" "! grep -q 'NEEDS YOU' '$T/alerts.log'"
check "does not claim it fixed anything either" "! grep -q 'FIXED' '$T/alerts.log'"

# --- step 3: a hung app, reported as an episode -----------------------------------
# A restart is an attempt. The report comes only when /api/health is SEEN answering
# again, and a second restart with no healthy sweep between is a page, not another
# "fixed". Before this the step claimed "restarted hung faucet-web" on every restart,
# which on a dead app is one message every 90 seconds and never once a true one.
HEALTH_PORT="${WATCHDOG_HEALTH_TEST_PORT:-18931}"
# Serves /api/health with 500 for the first $1 requests, then 200 (-1 = 500 forever).
# Everything else answers 200, so the readiness probe in the same sweep is not the
# thing under test. The stub curl only intercepts /ready; health reaches this server.
health_server() {
  python3 - "$HEALTH_PORT" "$1" <<'PY' >/dev/null 2>&1 &
import http.server,sys
port,fail=int(sys.argv[1]),int(sys.argv[2]); n=[0]
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.startswith('/api/health'):
            n[0]+=1
            code=500 if (fail<0 or n[0]<=fail) else 200
        else:
            code=200
        self.send_response(code); self.end_headers(); self.wfile.write(b'{}')
    def log_message(self,*a): pass
http.server.HTTPServer(("127.0.0.1",port),H).serve_forever()
PY
  HEALTH_PID=$!
  for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:$HEALTH_PORT/warmup" && break; sleep 0.25; done
}
stop_health_server() { kill "$HEALTH_PID" 2>/dev/null; wait "$HEALTH_PID" 2>/dev/null; }

echo "== watchdog: a hung app is restarted, and reported FIXED only once it answers again"
wd_env
echo running > "$STUB_CONTAINERS/z3-testnet-zallet-1"
echo running > "$STUB_CONTAINERS/z3-testnet-zebra-1"
echo running > "$STUB_CONTAINERS/faucet-web"
health_server 3
export WATCHDOG_FAUCET_URL="http://127.0.0.1:$HEALTH_PORT"
wd_run 5   # three misses -> restart; the fourth check answers -> the report; fifth is quiet
stop_health_server
check "restarts the app after the miss limit" "grep -q 'docker restart faucet-web' '$STUB_LOG'"
check "does not claim the fix on the restart itself" "grep -q 'report follows once it answers' '$T/run.log'"
check "reports the fix once health answers again" "grep -q 'FIXED: faucet app hung' '$T/alerts.log'"
check "exactly once" "[ \"\$(grep -c 'FIXED: faucet app' '$T/alerts.log')\" = 1 ]"
check "and no page for an app that came back" "! grep -q 'NEEDS YOU: faucet app' '$T/alerts.log'"

echo "== watchdog: an app that stays dead after a restart is a page, not a second fixed"
wd_env
echo running > "$STUB_CONTAINERS/z3-testnet-zallet-1"
echo running > "$STUB_CONTAINERS/z3-testnet-zebra-1"
echo running > "$STUB_CONTAINERS/faucet-web"
health_server -1
export WATCHDOG_FAUCET_URL="http://127.0.0.1:$HEALTH_PORT"
wd_run 6   # restarts at sweeps 3 and 6; the second one pages
stop_health_server
check "restarted twice" "[ \"\$(grep -c 'docker restart faucet-web' '$STUB_LOG')\" = 2 ]"
check "never claims a fix it has not seen" "! grep -q 'FIXED: faucet app' '$T/alerts.log'"
check "pages on the second restart" "grep -q 'NEEDS YOU: faucet app not answering /api/health after 2 restart' '$T/alerts.log'"

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
# IN THE WRITER'S REAL SHAPE: one field per line, a space after the colon, matching
# deploy/z3/miner/testdata/heartbeat.canonical.json. The first version of this helper wrote
# compact JSON the miner never produces, the watchdog's parser only understood compact, and
# so a suite that was green proved nothing about the box: step 6 was dead there for weeks.
miner_hb() {
  local lt
  if [ "$3" = "none" ]; then lt='null'; else lt="\"$(_ago_z "$3")\""; fi
  printf '{\n  "schema": 1,\n  "writtenAt": "%s",\n  "startedAt": "%s",\n  "lastTemplateAt": %s,\n  "lastTemplateHeight": 4282310,\n  "consecutiveErrors": 0,\n  "nodeLag": 0,\n  "waitingSince": null,\n  "waitingReason": null\n}\n' \
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
check "the journal says why, naming the stall" "grep -q 'miner stalled' '$T/run.log'"
# A restart is an attempt, not a result. Claiming FIXED here, before the miner has been
# seen templating, is the same lie as "recovered" on an accepted docker start.
check "but does not claim a fix it has not seen" "! grep -q 'FIXED: miner' '$T/alerts.log'"

echo "== watchdog: a miner that templates again after the restart gets ONE fixed report"
wd_miner_env
miner_hb 5 3600 3600      # stalled
wd_run 1                  # restarted; nothing reported yet
miner_hb 5 3600 10        # now templating; the stall count survived on disk
wd_run 1
check "reports the fix once the miner is seen templating" "grep -q 'FIXED: miner stalled' '$T/alerts.log'"
check "and counts the restart it took" "grep -q '(1 restart' '$T/alerts.log'"
check "exactly one report" "[ \"\$(grep -c 'FIXED: miner' '$T/alerts.log')\" = 1 ]"

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
miner_hb 5 3600 3600      # WATCHDOG_MINER_HEAL_MAX defaults to 3
wd_run 5
check "restarts exactly the cap, then stops" \
  "[ \"\$(grep -c 'systemctl restart zcash-testnet-miner.service' '$STUB_LOG')\" = 3 ]"
check "and pages once it gives up" "grep -q 'NEEDS YOU: miner still stalled after 3 restarts' '$T/alerts.log'"
check "without ever claiming a fix" "! grep -q 'FIXED: miner' '$T/alerts.log'"

# --- step 5: poison auto-heal + budget reset -------------------------------------
# zallet crash-loops on a dropped tx it can no longer fetch (-5 No such mempool...). The
# watchdog runs the repair tools and restarts it. This step was shipped UNTESTED, which is
# how a blind spot (a poison tx with no expiry that the tool skipped) reached production
# twice in one day. The reset is the subtle part: it must NOT depend on the app readiness
# probe, which the watchdog cannot even reach, or the budget never comes back.
SIG='RPC Error (code: -5): No such mempool or main chain transaction'

# Stub repair tools. STUB_HEAL_FIXES=1 makes the abandon stub clear the poison from
# zallet's log (models the real tool removing the dead tx); unset leaves it (a poison it
# cannot clear).
mk_heal_tools() {
  mkdir -p "$T/tools"
  cat > "$T/tools/zallet-abandon-expired-txs.sh" <<TOOL
#!/usr/bin/env bash
echo "abandon: stub ran"
[ "\${STUB_HEAL_FIXES:-0}" = "1" ] && : > "$STUB_CONTAINERS/z3-testnet-zallet-1.logs"
exit 0
TOOL
  printf '#!/usr/bin/env bash\necho "drop-queue: stub ran"\nexit 0\n' > "$T/tools/zallet-drop-unfetchable-queue.sh"
  chmod +x "$T/tools/"*.sh
  export WATCHDOG_HEAL_TOOLS_DIR="$T/tools"
}

echo "== watchdog: the poison signature triggers a repair, and a heal that works frees the budget again"
wd_env
echo running > "$STUB_CONTAINERS/z3-testnet-zallet-1"
echo running > "$STUB_CONTAINERS/z3-testnet-zebra-1"
echo running > "$STUB_CONTAINERS/faucet-web"
mk_heal_tools
export STUB_HEAL_FIXES=1
printf '%s\n' "$SIG" > "$STUB_CONTAINERS/z3-testnet-zallet-1.logs"
wd_run 3
check "runs the repair tools on the -5 signature" "grep -q 'ran the repair tools (attempt 1/2)' '$T/run.log'"
check "and reports the fix once zallet is seen running clean" "grep -q 'FIXED: zallet crash-looped' '$T/alerts.log'"
check "exactly once" "[ \"\$(grep -c 'FIXED: zallet' '$T/alerts.log')\" = 1 ]"
check "does not give up on a heal that worked" "! grep -q 'poison persists' '$T/alerts.log'"
check "frees the heal budget once zallet is running and clean" "grep -q 'heal budget reset' '$T/run.log'"

echo "== watchdog: a poison the tools cannot clear heals up to the cap, then pages once"
wd_env
echo running > "$STUB_CONTAINERS/z3-testnet-zallet-1"
echo running > "$STUB_CONTAINERS/z3-testnet-zebra-1"
echo running > "$STUB_CONTAINERS/faucet-web"
mk_heal_tools                 # STUB_HEAL_FIXES unset: the signature never clears
printf '%s\n' "$SIG" > "$STUB_CONTAINERS/z3-testnet-zallet-1.logs"
wd_run 4                       # HEAL_MAX_ATTEMPTS defaults to 2
check "heals up to the cap" "[ \"\$(grep -c 'ran the repair tools' '$T/run.log')\" = 2 ]"
check "then pages that it needs a human" "grep -q 'NEEDS YOU: zallet poison persists after 2 repairs' '$T/alerts.log'"
check "and never claims a fix" "! grep -q 'FIXED: zallet' '$T/alerts.log'"
check "and pages that once, not every sweep" "[ \"\$(grep -c 'poison persists' '$T/alerts.log')\" = 1 ]"

echo "== watchdog: no poison signature means no repair is ever run"
wd_env
echo running > "$STUB_CONTAINERS/z3-testnet-zallet-1"
echo running > "$STUB_CONTAINERS/z3-testnet-zebra-1"
echo running > "$STUB_CONTAINERS/faucet-web"
mk_heal_tools
: > "$STUB_CONTAINERS/z3-testnet-zallet-1.logs"   # clean logs
wd_run 2
check "does not run the repair tools on a clean log" "! grep -q 'ran the repair tools' '$T/run.log'"
check "and does not log a budget reset it never spent" "! grep -q 'heal budget reset' '$T/run.log'"

# --- step 7: node sync-stall recovery --------------------------------------------
# Zebra can sit on one tip while the network moves on: a self-mined fork, or a thin flaky
# testnet peer set that stops serving blocks. The container stays "running", so steps 1-2
# never fire, and 2026-09-07 the node was 300-1400 blocks behind for over an hour, twice,
# until a human restarted it by hand. The heal reads zebra's own RPC and restarts it only
# when it is behind AND its tip has stopped moving: never a healthy idle node at the tip,
# never one still catching up. Then it escalates to dropping the peer cache, then pages.

wd_node_env() {
  wd_env
  echo running > "$STUB_CONTAINERS/z3-testnet-zallet-1"
  echo running > "$STUB_CONTAINERS/z3-testnet-zebra-1"
  echo running > "$STUB_CONTAINERS/faucet-web"
  export STUB_VOLROOT="$T/volumes"
  mkdir -p "$STUB_VOLROOT/z3-testnet-chain/network" "$STUB_VOLROOT/z3-testnet-chain/non_finalized_state"
  : > "$STUB_VOLROOT/z3-testnet-chain/network/testnet.peers"
  : > "$STUB_VOLROOT/z3-testnet-chain/non_finalized_state/backup.bin"
  export STUB_ZEBRA_COUNTER="$T/zebra-counter"; rm -f "$STUB_ZEBRA_COUNTER"
  # Sweeps are instant in here, so a stall is judged straight away rather than after five
  # minutes; the decision logic under test is the same either way.
  export WATCHDOG_NODE_STALL_SECS=0
  export WATCHDOG_NODE_LAG_LIMIT=50
  export WATCHDOG_NODE_HEAL_MAX=3
  export WATCHDOG_NODE_CLEAR_CACHE_AFTER=2
  export WATCHDOG_NODE_DROP_NONFINAL_AFTER=3
}

echo "== watchdog: a node at the tip that is merely between blocks is left alone"
wd_node_env
export STUB_ZEBRA_BLOCKS=4331737 STUB_ZEBRA_EST=4331737   # at the tip; no new block for a while
wd_run 4
check "does not restart a healthy idle node" "! grep -q 'docker restart z3-testnet-zebra-1' '$STUB_LOG'"
check "and pages nothing about the node" "! grep -q 'blocks behind' '$T/alerts.log'"

echo "== watchdog: a node that is behind but still catching up is not bounced"
wd_node_env
export STUB_ZEBRA_BLOCKS=4331200 STUB_ZEBRA_EST=4332600 STUB_ZEBRA_ADVANCE=1   # 1400 behind, +1 per sweep
wd_run 4
check "does not restart a node that is advancing" "! grep -q 'docker restart z3-testnet-zebra-1' '$STUB_LOG'"
check "and leaves the peer cache alone" "[ -f '$STUB_VOLROOT/z3-testnet-chain/network/testnet.peers' ]"

echo "== watchdog: a node behind AND stuck is restarted, and says why"
wd_node_env
export STUB_ZEBRA_BLOCKS=4331234 STUB_ZEBRA_EST=4332677   # 1443 behind, tip never moves
wd_run 2   # sweep 1 is the baseline; sweep 2 sees no movement
check "restarts zebra" "grep -q 'docker restart z3-testnet-zebra-1' '$STUB_LOG'"
check "the journal names the stall and the lag" "grep -q 'zebra stalled.*1443 behind' '$T/run.log'"
check "and no fix is claimed before the tip has moved" "! grep -q 'FIXED: zebra' '$T/alerts.log'"
check "first attempt is a plain restart, cache untouched" "[ -f '$STUB_VOLROOT/z3-testnet-chain/network/testnet.peers' ]"
check "and the non-finalized state is untouched too" "[ -d '$STUB_VOLROOT/z3-testnet-chain/non_finalized_state' ]"

echo "== watchdog: a stall that will not clear escalates to a peer-cache clear, then pages once"
wd_node_env
export STUB_ZEBRA_BLOCKS=4331234 STUB_ZEBRA_EST=4332677   # never moves, whatever we do
peers="$STUB_VOLROOT/z3-testnet-chain/network/testnet.peers"
nonfinal="$STUB_VOLROOT/z3-testnet-chain/non_finalized_state"
wd_run 6   # baseline, heal 1 (restart), heal 2 (clear cache), heal 3 (+ drop non-finalized), give-up, quiet
check "the first heal is a plain restart" "[ \"\$(grep -c 'docker restart z3-testnet-zebra-1' '$STUB_LOG')\" = 1 ]"
check "later heals stop the node to clear the cache" "grep -q 'docker stop z3-testnet-zebra-1' '$STUB_LOG'"
check "and the stale peer cache is actually gone" "[ ! -f '$peers' ]"
# Six plain restarts moved the tip by nothing on 2026-09-07 because every boot restored
# the wedged tip from this backup. The last tier has to actually remove it.
check "the last tier drops the non-finalized state" "[ ! -d '$nonfinal' ]"
check "and the journal says so" "grep -q 'dropped the non-finalized state' '$T/run.log'"
check "heals exactly the cap, then stops" "[ \"\$(grep -cE 'restarting \([0-9]+/3\)' '$T/run.log')\" = 3 ]"
check "pages that it gave up" "grep -q 'NEEDS YOU: zebra still 1443 blocks behind after 3 tries' '$T/alerts.log'"
check "and pages that once, not every sweep" "[ \"\$(grep -c 'NEEDS YOU: zebra' '$T/alerts.log')\" = 1 ]"
check "and never claims a fix" "! grep -q 'FIXED: zebra' '$T/alerts.log'"

echo "== watchdog: a node that starts moving again after a restart gets ONE fixed report"
wd_node_env
export STUB_ZEBRA_BLOCKS=4331234 STUB_ZEBRA_EST=4332677 STUB_ZEBRA_ADVANCE=1 STUB_ZEBRA_STUCK_CALLS=2
wd_run 4   # baseline, stuck (restart 1/3), advancing (the report), advancing (quiet)
check "reports the fix once the tip is seen moving" "grep -q 'FIXED: zebra was 1443 blocks behind' '$T/alerts.log'"
check "and says what fixed it and how many attempts" "grep -q 'Restarted it after 1 attempt' '$T/alerts.log'"
check "exactly one report, not one per sweep" "[ \"\$(grep -c 'FIXED: zebra' '$T/alerts.log')\" = 1 ]"
check "and never a give-up" "! grep -q 'NEEDS YOU: zebra' '$T/alerts.log'"

echo "== watchdog: a node whose RPC will not answer is not judged a stall"
wd_node_env   # STUB_ZEBRA_BLOCKS unset: docker exec fails, and no answer is not evidence
wd_run 3
check "does not restart on a silent RPC" "! grep -q 'docker restart z3-testnet-zebra-1' '$STUB_LOG'"
check "and pages nothing about the node" "! grep -q 'blocks behind' '$T/alerts.log'"

echo "== watchdog: the node heal can be switched off"
wd_node_env
export WATCHDOG_NODE_HEAL_ENABLED=0
export STUB_ZEBRA_BLOCKS=4331234 STUB_ZEBRA_EST=4332677
wd_run 3
check "does nothing when disabled, even on a real stall" "! grep -q 'docker restart z3-testnet-zebra-1' '$STUB_LOG'"

# ── THE SYNC GUARD AND THE NODE HEAL, TOGETHER (risk register #5, 2026-09-08) ───────────
# On 2026-09-07 the node sat on a private fork and the miner kept submitting on top of it,
# through six restarts and a state drop. Two layers now: the miner's own guard (it writes
# waitingSince to its heartbeat and fetches nothing), and step 7 stopping the miner for a
# heal episode. Step 6 must not "heal" a miner that is waiting, or the two fight.

# A heartbeat from a miner whose sync guard is holding it back: fresh beat, stale template,
# waitingSince set, nodeLag saying by how much.
miner_hb_waiting() { # $1 waiting for N seconds, $2 lag
  printf '{\n  "schema": 1,\n  "writtenAt": "%s",\n  "startedAt": "%s",\n  "lastTemplateAt": "%s",\n  "lastTemplateHeight": 4282310,\n  "consecutiveErrors": 0,\n  "nodeLag": %s,\n  "waitingSince": "%s",\n  "waitingReason": "behind"\n}\n' \
    "$(_ago_z 5)" "$(_ago_z 7200)" "$(_ago_z 3600)" "$2" "$(_ago_z "$1")" > "$T/heartbeat.json"
}

echo "== watchdog: a miner WAITING for the node is not a stall and is left alone"
wd_miner_env
miner_hb_waiting 1800 1443   # idle on purpose for 30 min, node 1443 behind, template 1h old
wd_run 3
check "does not restart a miner that is holding back on purpose" "! grep -q 'systemctl restart zcash-testnet-miner' '$STUB_LOG'"
check "says so in the journal, with the lag" "grep -q 'miner is waiting for the node (1443 blocks behind)' '$T/run.log'"
check "and says it once, not every sweep" "[ \"\$(grep -c 'miner is waiting for the node' '$T/run.log')\" = 1 ]"
check "and pages nothing about the miner" "[ -e '$T/alerts.log' ] || : > '$T/alerts.log'; ! grep -qi 'miner' '$T/alerts.log'"
check "while the sweep itself ran (the negative above is about a decision)" "grep -q 'miner is waiting' '$T/run.log'"

echo "== watchdog: a WAITING label beside a failing RPC is not honoured, it is the wedge of 2026-08-18"
# The writer clears waitingSince on any error, but an older writer might not, and a wedged
# connection with a stale "waiting" label would otherwise never be restarted again.
wd_miner_env
printf '{\n  "schema": 1,\n  "writtenAt": "%s",\n  "startedAt": "%s",\n  "lastTemplateAt": "%s",\n  "lastTemplateHeight": 4282310,\n  "consecutiveErrors": 4000,\n  "lastErrorStage": "getblockchaininfo",\n  "nodeLag": 51,\n  "waitingSince": "%s",\n  "waitingReason": "behind"\n}\n' \
  "$(_ago_z 5)" "$(_ago_z 7200)" "$(_ago_z 3600)" "$(_ago_z 1800)" > "$T/heartbeat.json"
wd_run 1
check "a miner whose RPC is failing is restarted even though it claims to be waiting" "grep -q 'systemctl restart zcash-testnet-miner' '$STUB_LOG'"

echo "== watchdog: a WAITING label with NO error count at all is not honoured either"
# An older writer without consecutiveErrors, or a corrupt line. Unreadable must not be
# read as zero, or the gate that guards the wait fails open.
wd_miner_env
printf '{\n  "schema": 1,\n  "writtenAt": "%s",\n  "startedAt": "%s",\n  "lastTemplateAt": "%s",\n  "lastTemplateHeight": 4282310,\n  "waitingSince": "%s"\n}\n' \
  "$(_ago_z 5)" "$(_ago_z 7200)" "$(_ago_z 3600)" "$(_ago_z 1800)" > "$T/heartbeat.json"
wd_run 1
check "restarted: a wait without a readable error count is a stall" "grep -q 'systemctl restart zcash-testnet-miner' '$STUB_LOG'"

echo "== watchdog: THE REAL FIXTURE. The miner's own canonical bytes are read as a live miner"
# The seam test for the shell reader: the bytes the Rust writer is pinned to. If these read
# as empty, every miner check above is running against a shape the box never has.
wd_miner_env
sed "s/\"writtenAt\": \"[^\"]*\"/\"writtenAt\": \"$(_ago_z 5)\"/; s/\"lastTemplateAt\": \"[^\"]*\"/\"lastTemplateAt\": \"$(_ago_z 3600)\"/; s/\"startedAt\": \"[^\"]*\"/\"startedAt\": \"$(_ago_z 7200)\"/" \
  "$REPO/deploy/z3/miner/testdata/heartbeat.canonical.json" > "$T/heartbeat.json"
wd_run 1
check "the canonical fixture, aged into a stall, is restarted: the parser reads the writer's real format" "grep -q 'systemctl restart zcash-testnet-miner' '$STUB_LOG'"
check "and compact JSON still reads too, for any hand-written file" "printf '{\"schema\":1,\"writtenAt\":\"%s\",\"startedAt\":\"%s\",\"lastTemplateAt\":\"%s\"}' \"\$(_ago_z 5)\" \"\$(_ago_z 7200)\" \"\$(_ago_z 3600)\" > '$T/heartbeat.json'; : > '$STUB_LOG'; wd_run 1; grep -q 'systemctl restart zcash-testnet-miner' '$STUB_LOG'"

echo "== watchdog: the same heartbeat WITHOUT waitingSince is still the stall it always was"
# The mirror: if this did not restart, the waiting check would be swallowing every stall.
wd_miner_env
miner_hb 5 7200 3600
wd_run 1
check "a stale template with no wait is restarted as before" "grep -q 'systemctl restart zcash-testnet-miner' '$STUB_LOG'"

echo "== watchdog: a node heal STOPS a running miner first, and starts it again on recovery"
wd_node_env
echo active > "$STUB_SYSTEMD/zcash-testnet-miner.service"
export STUB_ZEBRA_BLOCKS=4331234 STUB_ZEBRA_EST=4332677 STUB_ZEBRA_ADVANCE=1 STUB_ZEBRA_STUCK_CALLS=2
wd_run 4   # baseline, stuck (stop miner + restart 1/3), advancing (start miner + report), quiet
check "the miner is stopped before the node is touched" "grep -q 'systemctl stop zcash-testnet-miner.service' '$STUB_LOG'"
check "and the stop comes BEFORE the restart, not after" "[ \"\$(grep -n 'systemctl stop zcash-testnet-miner' '$STUB_LOG' | head -1 | cut -d: -f1)\" -lt \"\$(grep -n 'docker restart z3-testnet-zebra-1' '$STUB_LOG' | head -1 | cut -d: -f1)\" ]"
check "the journal says why" "grep -q 'stopped zcash-testnet-miner.service for the node heal' '$T/run.log'"
check "the miner is started again once the tip moves" "grep -q 'systemctl start zcash-testnet-miner.service' '$STUB_LOG'"
check "and the ONE fixed report says the miner was stopped and is back" "grep -q 'FIXED: zebra was 1443 blocks behind.*The miner was stopped for the heal and is started again' '$T/alerts.log'"
check "stopped exactly once for the episode" "[ \"\$(grep -c 'systemctl stop zcash-testnet-miner' '$STUB_LOG')\" = 1 ]"

echo "== watchdog: a node heal that GIVES UP leaves the miner stopped and says so"
wd_node_env
echo active > "$STUB_SYSTEMD/zcash-testnet-miner.service"
export STUB_ZEBRA_BLOCKS=4331234 STUB_ZEBRA_EST=4332677
wd_run 6
check "the miner was stopped for the episode" "grep -q 'systemctl stop zcash-testnet-miner.service' '$STUB_LOG'"
check "and never started again, because the node is not fixed" "! grep -q 'systemctl start zcash-testnet-miner.service' '$STUB_LOG'"
check "the page says the miner is left stopped and how to bring it back" "grep -q 'NEEDS YOU: zebra still 1443 blocks behind.*The miner is left STOPPED.*systemctl start zcash-testnet-miner.service' '$T/alerts.log'"

echo "== watchdog: a miner that is not running is not stopped, and the report does not mention it"
wd_node_env
echo inactive > "$STUB_SYSTEMD/zcash-testnet-miner.service"   # parked, as on 2026-09-08
export STUB_ZEBRA_BLOCKS=4331234 STUB_ZEBRA_EST=4332677 STUB_ZEBRA_ADVANCE=1 STUB_ZEBRA_STUCK_CALLS=2
wd_run 4
check "no stop for a miner that is already off" "! grep -q 'systemctl stop zcash-testnet-miner' '$STUB_LOG'"
check "no start either: the watchdog does not un-park a miner someone parked" "! grep -q 'systemctl start zcash-testnet-miner' '$STUB_LOG'"
check "the fixed report is the plain one" "grep -q 'FIXED: zebra' '$T/alerts.log' && ! grep -q 'miner' '$T/alerts.log'"

echo "== watchdog: stopping the miner for a heal can be switched off"
wd_node_env
echo active > "$STUB_SYSTEMD/zcash-testnet-miner.service"
export WATCHDOG_NODE_STOPS_MINER=0
export STUB_ZEBRA_BLOCKS=4331234 STUB_ZEBRA_EST=4332677
wd_run 2
check "the node is still healed" "grep -q 'docker restart z3-testnet-zebra-1' '$STUB_LOG'"
check "but the miner is left running" "! grep -q 'systemctl stop zcash-testnet-miner' '$STUB_LOG'"
check "and the journal says the guard was switched off, so the negative above is a decision" "grep -q 'not stopping zcash-testnet-miner.service for this heal (WATCHDOG_NODE_STOPS_MINER=0)' '$T/run.log'"

echo "== watchdog: THE FLAG SURVIVES A WATCHDOG RESTART, so a miner stopped mid-episode comes back"
# faucet-watchdog.service is Restart=always and every ops deploy restarts it. An in-memory
# flag would leave the miner stopped forever with the panel reading a calm "off".
wd_node_env
echo active > "$STUB_SYSTEMD/zcash-testnet-miner.service"
export STUB_ZEBRA_BLOCKS=4331234 STUB_ZEBRA_EST=4332677
wd_run 2   # baseline, stuck: stop the miner, restart zebra. Then this watchdog "dies".
check "the first watchdog stopped the miner" "grep -q 'systemctl stop zcash-testnet-miner.service' '$STUB_LOG'"
check "and wrote that down" "[ \"\$(cat '$T/state/miner-stopped-for-node-heal.flaps' 2>/dev/null)\" = 1 ]"
export STUB_ZEBRA_ADVANCE=1   # the heal worked while the watchdog was down
: > "$T/alerts.log"
wd_run 3   # a NEW process: baseline (prev=0, must not act), advancing (start miner, report), quiet
check "the new watchdog does not un-stop the miner on its very first sweep" "[ \"\$(grep -c 'systemctl start zcash-testnet-miner' '$STUB_LOG')\" = 1 ]"
check "it starts the miner once the tip is seen moving" "grep -q 'systemctl start zcash-testnet-miner.service' '$STUB_LOG'"
check "and reports it, naming the earlier watchdog's heal" "grep -q 'FIXED: zebra is syncing again after a node heal that a previous watchdog started.*miner was stopped for the heal and is started again' '$T/alerts.log'"
check "and clears the flag" "[ \"\$(cat '$T/state/miner-stopped-for-node-heal.flaps' 2>/dev/null)\" = 0 ]"

echo "== watchdog: a miner that will not START after the heal is a page, not a footnote on a tick"
wd_node_env
echo active > "$STUB_SYSTEMD/zcash-testnet-miner.service"
export STUB_ZEBRA_BLOCKS=4331234 STUB_ZEBRA_EST=4332677 STUB_ZEBRA_ADVANCE=1 STUB_ZEBRA_STUCK_CALLS=2 STUB_START_FAIL=1
wd_run 4
check "the node's own recovery is still reported" "grep -q 'FIXED: zebra was 1443 blocks behind' '$T/alerts.log'"
check "and the failed start is a NEEDS YOU of its own" "grep -q 'NEEDS YOU: the node has recovered but .systemctl start zcash-testnet-miner.service. FAILED' '$T/alerts.log'"
check "which the FIXED does not paper over" "! grep 'FIXED: zebra' '$T/alerts.log' | grep -q 'started again'"
unset STUB_START_FAIL

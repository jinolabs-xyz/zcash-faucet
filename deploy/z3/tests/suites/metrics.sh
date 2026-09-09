# shellcheck shell=bash
# faucet-metrics.sh: scrapes the app's own endpoints into a Prometheus
# textfile. A real python http server serves canned /api/ready and
# /api/status; docker is stubbed for container state.

METRICS_SH="$REPO/deploy/z3/faucet-metrics.sh"

metrics_env() {
  fresh_env
  # fresh_env puts the whole stubs dir on PATH, including the curl stub that
  # fakes /ready for the zsnap gate tests. These tests need the REAL curl
  # (they talk to an actual server) but still want the docker stub, so build
  # a bin dir holding just docker.
  mkdir -p "$T/bin" "$T/textfile"
  ln -sf "$SCRATCH/stubs/docker" "$T/bin/docker"
  export PATH="$T/bin:$BASE_PATH"
  export METRICS_FILE="$T/textfile/faucet.prom"
  export METRICS_FAUCET_URL="http://127.0.0.1:$API_PORT"
  # KEEP /etc OUT OF THE TESTS (lib.sh says the same about ZSNAP_SOURCE_FILE). Without
  # this the watchdog fallback resolves the REAL /etc/faucet/watchdog.env on a developer's
  # box or on the faucet itself, and a case fails for a reason that has nothing to do with
  # the code under test. Verified: with a real file present, one case went red.
  export METRICS_WATCHDOG_ENV="$T/no-watchdog.env"
  export METRICS_WARN_STATE_DIR="$T/warnstate" METRICS_WARN_EVERY_SECONDS=0
  # AND THE SAME FOR THE DISK CHECK AND THE PAGER. Unpinned, these defaulted to the real
  # `/`, /var/lib/zsnap and /var/lib/faucet-backups at a 10% floor, with ALERT_SH pointing
  # at the SHIPPED alert.sh. Measured: on a host under the floor the suite reached
  # alert.sh, which sourced the host's /etc/faucet/watchdog.env and tried to POST. Running
  # the tests on the faucet box could send a real page from a test run.
  export METRICS_ALERT_SH="$T/bin/no-such-alert.sh"
  export METRICS_DISK_PATHS="$T/textfile" METRICS_DISK_FLOOR_PCT=0
  rm -f "$T/no-watchdog.env"
}
# One server for the whole suite, torn down at the end.
#
# The readiness probe below runs at suite TOP LEVEL, before any metrics_env call, so it
# used to inherit whatever PATH the PREVIOUS suite left behind. That is a real dependency
# on suite order: the deploy suite leaves its own stub dir first on PATH, and when a `curl`
# stub was added there this probe started answering success instantly. The server was then
# still coming up, the scrape read nothing, and eight value assertions failed while "run
# exits 0" and "textfile created" both passed. A stub answering a question it should never
# have been asked.
#
# So the probe uses the REAL curl explicitly, by absolute path, and does not care what is
# on PATH at all.
API_PORT="${METRICS_TEST_PORT:-18731}"
REAL_CURL="$(PATH="$BASE_PATH" command -v curl)"
# Its own process group, so the teardown can take the python child too. The stub is a
# bash wrapper: killing the wrapper alone leaves the listener up, and a second run of the
# harness then answered every value assertion from the first run's orphan while its own
# stub silently failed to bind.
set -m
"$SCRATCH/stubs/faucet-api-stub" "$API_PORT" >/dev/null 2>&1 &
API_PID=$!
set +m
up=0
for _ in $(seq 1 40); do
  if "$REAL_CURL" -sf -o /dev/null "http://127.0.0.1:$API_PORT/api/status"; then up=1; break; fi
  sleep 0.25
done
# Never proceed silently on a server that never came up: every value assertion below would
# fail for a reason that has nothing to do with the code under test.
[ "$up" = 1 ] || { echo "REFUSING: the metrics fixture's API stub never came up on port $API_PORT" >&2; exit 1; }

echo "== metrics: scrapes the live endpoints into a textfile"
metrics_env
echo running > "$STUB_CONTAINERS/z3-testnet-zebra-1"
echo running > "$STUB_CONTAINERS/z3-testnet-zallet-1"
echo exited  > "$STUB_CONTAINERS/faucet-web"
bash "$METRICS_SH" > "$T/m1.log" 2>&1
check "metrics run exits 0" "[ $? -eq 0 ]"
check "textfile created" "[ -f '$METRICS_FILE' ]"
check "app reachable is faucet_up 1" "grep -qx 'faucet_up 1' '$METRICS_FILE'"
# /api/ready answers 503 with ready:false, which is an answer, not an outage.
check "not-ready is recorded as faucet_ready 0" "grep -qx 'faucet_ready 0' '$METRICS_FILE'"
check "balance comes through" "grep -qx 'faucet_balance_taz 3.5' '$METRICS_FILE'"
check "queue depth comes through" "grep -qx 'faucet_queue_depth 2' '$METRICS_FILE'"
check "empty=false becomes 0" "grep -qx 'faucet_empty 0' '$METRICS_FILE'"
# The nested node object, not the top-level "ready" that means something else. The fixture's
# node carries nested shield/chain objects like the real one; with the old `{[^{}]*}`
# extractor these three gauges were absent from the real file and this check passed on a
# fixture without nesting.
check "nested node.ready read correctly, past the objects nested inside node" "grep -qx 'faucet_node_ready 1' '$METRICS_FILE'"
check "node.syncPercent and node.height survive the nesting too" "grep -qx 'faucet_node_sync_percent 99.98' '$METRICS_FILE' && grep -qx 'faucet_node_height 4204726' '$METRICS_FILE'"
# The send gate's verdict, which faucet_ready cannot carry: this fixture's node is ready
# and its gate is closed, the exact pair a scraper must be able to tell apart.
check "the send gate's verdict is its own gauge" "grep -qx 'faucet_can_build_tx 0' '$METRICS_FILE'"
check "nested node.syncPercent read correctly" "grep -qx 'faucet_node_sync_percent 99.98' '$METRICS_FILE'"
check "nested node.height read correctly" "grep -qx 'faucet_node_height 4204726' '$METRICS_FILE'"
check "running container reported up" "grep -qx 'faucet_container_up 1' '$METRICS_FILE'"
check "exited container reported down" "grep -qx 'faucet_web_container_up 0' '$METRICS_FILE'"
check "every metric has HELP and TYPE" "[ \"\$(grep -c '^# HELP' '$METRICS_FILE')\" = \"\$(grep -c '^# TYPE' '$METRICS_FILE')\" ]"
check "no temp file left behind" "! ls '$T/textfile/'faucet.prom.?????? >/dev/null 2>&1"
# A 503 IS the app: it is how /api/ready says it cannot drip, and the fixture answers 503.
# Treating a non-200 as "no answer" would lose the reason at the moment someone needs it,
# so the 200/503 pair is pinned here beside the 502 case below.
check "a 503 from the app still counts as an answer, with its reason read" \
  "grep -qx 'faucet_up 1' '$METRICS_FILE' && grep -qx 'faucet_ready 0' '$METRICS_FILE'"

echo "== metrics: app unreachable is distinguishable from app saying no"
metrics_env
export METRICS_FAUCET_URL="http://127.0.0.1:1"    # nothing listens here
bash "$METRICS_SH" > "$T/m2.log" 2>&1
check "still exits 0 so the timer stays green" "[ $? -eq 0 ]"
check "faucet_up 0 when the app answers nothing" "grep -qx 'faucet_up 0' '$METRICS_FILE'"
check "no invented readiness value" "! grep -q '^faucet_ready ' '$METRICS_FILE'"
check "container metrics still emitted" "grep -q '^faucet_container_up ' '$METRICS_FILE'"

echo "== metrics: rewrites stay complete and readable"
metrics_env
bash "$METRICS_SH" > /dev/null 2>&1
check "first write produced content" "[ -s '$METRICS_FILE' ]"
bash "$METRICS_SH" > /dev/null 2>&1
check "rewrite leaves a complete file" "grep -q 'faucet_metrics_scrape_timestamp' '$METRICS_FILE'"
check "file is world-readable for the scraper" "[ \"\$(stat -c %a '$METRICS_FILE')\" = '644' ]"

echo "== metrics: the probe config falls back to the WATCHDOG's, which is the one the box has"
# This script read only METRICS_* names, out of /etc/faucet/metrics.env, a file nobody
# creates. On production that meant probing 127.0.0.1:3000 (the app is behind caddy and
# publishes no port) and looking for a container called faucet-web (it is called
# zcash-faucet-faucet-1), so `faucet_up 0` and no app gauges at all, for months, while the
# faucet served (risk register #19). The watchdog's env file had the right values all along.
metrics_env
unset METRICS_FAUCET_URL
printf 'WATCHDOG_FAUCET_URL=http://127.0.0.1:%s\n' "$API_PORT" > "$T/watchdog.env"
METRICS_WATCHDOG_ENV="$T/watchdog.env" bash "$METRICS_SH" > /dev/null 2>&1
check "with no METRICS_FAUCET_URL it uses the watchdog's URL and the faucet reads UP" "grep -qx 'faucet_up 1' '$METRICS_FILE'"
check "and the app gauges are there, not silently absent" "grep -q '^faucet_balance_taz ' '$METRICS_FILE' && grep -q '^faucet_ready ' '$METRICS_FILE'"

metrics_env
unset METRICS_FAUCET_URL
printf '# the box writes it with a comment and quotes\nexport WATCHDOG_FAUCET_URL="http://127.0.0.1:%s"  # behind caddy\n' "$API_PORT" > "$T/watchdog.env"
METRICS_WATCHDOG_ENV="$T/watchdog.env" bash "$METRICS_SH" > /dev/null 2>&1
check "a quoted, exported, commented value is read, the way alert.sh and box-report.sh read this file" "grep -qx 'faucet_up 1' '$METRICS_FILE'"

metrics_env
printf 'WATCHDOG_FAUCET_URL=http://127.0.0.1:1\n' > "$T/watchdog.env"
METRICS_WATCHDOG_ENV="$T/watchdog.env" bash "$METRICS_SH" > /dev/null 2>&1
check "an explicit METRICS_FAUCET_URL still wins over the watchdog's" "grep -qx 'faucet_up 1' '$METRICS_FILE'"

metrics_env
unset METRICS_FAUCET_URL
METRICS_WATCHDOG_ENV="$T/no-such-file" bash "$METRICS_SH" > /dev/null 2>&1
check "no watchdog env at all still runs, and says the faucet is down rather than crashing" "grep -qx 'faucet_up 0' '$METRICS_FILE'"

echo "== metrics: a container match that finds NOTHING says so, instead of reading as down"
# A wrong name and a stopped container both emit 0. That is how the wrong name survived.
metrics_env
: > "$STUB_CONTAINERS/zcash-faucet-faucet-1"; echo running > "$STUB_CONTAINERS/zcash-faucet-faucet-1"
METRICS_FAUCET_MATCH="no-such-container" bash "$METRICS_SH" > "$T/warn.log" 2>&1
check "the warning names the setting and its value" "grep -q 'no container matches faucet=\"no-such-container\"' '$T/warn.log'"
check "and says the 0 means nothing was found" "grep -q 'because nothing was found, not because it is down' '$T/warn.log'"
check "the metrics file itself stays parseable: no prose in it" \
  "! grep -vE '^(#|[a-z_]+(\{[^}]*\})? -?[0-9.]+$)' '$METRICS_FILE'"
metrics_env
echo running > "$STUB_CONTAINERS/zcash-faucet-faucet-1"
METRICS_FAUCET_MATCH="zcash-faucet-faucet" bash "$METRICS_SH" > "$T/nowarn.log" 2>&1
check "a match that DOES find a container warns about nothing" "! grep -q 'no container matches faucet' '$T/nowarn.log'"
check "and reports it up" "grep -qx 'faucet_web_container_up 1' '$METRICS_FILE'"

# THE CASE THAT BROKE PRODUCTION was the container match, not the URL, and it was the one
# with no test. All three matches fall back, so all three are pinned.
metrics_env
# Names that share NO substring with the defaults (zebra, zallet, faucet-web). With
# wd-zebra-1 the default "zebra" still matched it, so removing the fallback changed
# nothing and the check passed on a broken script.
echo running > "$STUB_CONTAINERS/node-a-1"
echo running > "$STUB_CONTAINERS/wallet-b-1"
echo running > "$STUB_CONTAINERS/site-c-1"
cat > "$T/watchdog.env" <<WD
WATCHDOG_ZEBRA_MATCH=node-a
WATCHDOG_ZALLET_MATCH=wallet-b
WATCHDOG_FAUCET_MATCH=site-c
WD
METRICS_WATCHDOG_ENV="$T/watchdog.env" bash "$METRICS_SH" > "$T/wdmatch.log" 2>&1
check "the zebra match falls back to the watchdog's" "grep -qx 'faucet_container_up 1' '$METRICS_FILE'"
check "the zallet match falls back to the watchdog's" "grep -qx 'faucet_zallet_container_up 1' '$METRICS_FILE'"
check "the faucet match falls back to the watchdog's: the very gauge that read 0 on the box" "grep -qx 'faucet_web_container_up 1' '$METRICS_FILE'"
check "and nothing warns, because everything was found" "! grep -q 'no container matches' '$T/wdmatch.log'"

echo "== metrics: a STOPPED container reads as down, not as a name nobody could find"
# The gauge is 0 either way. Dropping -a from the lookup would make every legitimately
# stopped container warn "nothing was found", which is the confusion this exists to end.
metrics_env
echo exited > "$STUB_CONTAINERS/zcash-faucet-faucet-1"
METRICS_FAUCET_MATCH="zcash-faucet-faucet" bash "$METRICS_SH" > "$T/stopped.log" 2>&1
check "a stopped container is reported down" "grep -qx 'faucet_web_container_up 0' '$METRICS_FILE'"
check "and does NOT warn that nothing matched, because something did" "! grep -q 'no container matches faucet' '$T/stopped.log'"

echo "== metrics: a docker that will not answer is its own diagnosis"
metrics_env
# rm FIRST: $T/bin/docker is a symlink into the SHARED stubs dir, and writing through it
# replaces the real stub for every later case (it did: the next case then saw every
# lookup as a docker error). The autodeploy suite learned the same thing.
rm -f "$T/bin/docker"
printf '#!/usr/bin/env bash\necho "Cannot connect to the Docker daemon" >&2\nexit 1\n' > "$T/bin/docker"; chmod +x "$T/bin/docker"
bash "$METRICS_SH" > "$T/dockerdown.log" 2>&1
check "it says docker did not answer" "grep -q 'docker did not answer' '$T/dockerdown.log'"
check "and does NOT blame the container names, which are fine" "! grep -q 'no container matches' '$T/dockerdown.log'"

echo "== metrics: the resolved probe target is on the record, so a wrong URL is diagnosable"
metrics_env
bash "$METRICS_SH" > "$T/target.log" 2>&1
check "the run says what it probed and where that came from" "grep -q \"probing http://127.0.0.1:$API_PORT (from METRICS_FAUCET_URL)\" '$T/target.log'"
metrics_env
unset METRICS_FAUCET_URL
bash "$METRICS_SH" > "$T/default.log" 2>&1
check "and names the built-in default as a default when nothing supplied one" "grep -q 'from the built-in default' '$T/default.log'"

echo "== metrics: the warning is throttled, because this runs every 30 seconds"
metrics_env
export METRICS_WARN_EVERY_SECONDS=3600
METRICS_FAUCET_MATCH="no-such-container" bash "$METRICS_SH" > "$T/w1.log" 2>&1
METRICS_FAUCET_MATCH="no-such-container" bash "$METRICS_SH" > "$T/w2.log" 2>&1
check "the first run warns" "grep -q 'no container matches faucet' '$T/w1.log'"
check "the second run inside the window does not: 8640 identical lines a day is how a real one stops being read" "! grep -q 'no container matches faucet' '$T/w2.log'"
export METRICS_WARN_EVERY_SECONDS=0

echo "== metrics: the config that broke production is pinned to the unit and the HELP"
metrics_env
# The gauge's HELP is read at the one moment it matters: when the gauge is 0. That branch
# was written out separately and never widened, so it still blamed the app for what may be
# DNS, TLS or the proxy.
METRICS_FAUCET_URL="http://127.0.0.1:1" bash "$METRICS_SH" > /dev/null 2>&1
check "faucet_up is 0 when nothing answers" "grep -qx 'faucet_up 0' '$METRICS_FILE'"
check "and its HELP still says the probe covers DNS, TLS and the proxy, not just the app" \
  "grep -q '^# HELP faucet_up .*DNS, TLS and the proxy' '$METRICS_FILE'"
bash "$METRICS_SH" > /dev/null 2>&1
check "the same wording when it is 1, so the two branches cannot drift apart" \
  "grep -qx 'faucet_up 1' '$METRICS_FILE' && grep -q '^# HELP faucet_up .*DNS, TLS and the proxy' '$METRICS_FILE'"
# watchdog.env holds the alert webhook. systemd's EnvironmentFile= is NOT inert: it would
# put that credential in this process's environment and every child's.
check "the unit does NOT load watchdog.env into the process environment" \
  "! grep -q '^EnvironmentFile=.*watchdog.env' '$REPO/deploy/z3/faucet-metrics.service'"
check "and says why, so the next person does not add it back for the systemctl-cat reason" \
  "grep -q 'NOT AS A SECOND EnvironmentFile' '$REPO/deploy/z3/faucet-metrics.service'"

echo "== metrics: one docker ps per match, so the warning and the gauge agree"
# They used to be two lookups: the gauge's ran inside $( ), which cannot see the warning
# loop's variables. A container that stopped between them was warned about as missing and
# gauged from a different snapshot, and the comment claimed the opposite.
metrics_env
echo running > "$STUB_CONTAINERS/zebra-1"
echo running > "$STUB_CONTAINERS/zallet-1"
echo running > "$STUB_CONTAINERS/faucet-web-1"
: > "$STUB_LOG"
bash "$METRICS_SH" > /dev/null 2>&1
check "three matches cost three docker ps, not six" \
  "[ \"\$(grep -c 'docker ps -a' '$STUB_LOG')\" = 3 ]"
check "and the gauges are still emitted from that one answer" \
  "grep -q '^faucet_container_up ' '$METRICS_FILE' && grep -q '^faucet_zallet_container_up ' '$METRICS_FILE' && grep -q '^faucet_web_container_up ' '$METRICS_FILE'"

echo "== metrics: the warning throttle degrades toward noise and validates its window"
metrics_env
export METRICS_WARN_EVERY_SECONDS=3600
mkdir -p "$T/rostate"; chmod 500 "$T/rostate"
METRICS_WARN_STATE_DIR="$T/rostate" bash "$METRICS_SH" > "$T/ro.log" 2>&1
check "an unwritable state dir still warns" "grep -q 'no container matches' '$T/ro.log'"
check "says the throttle is off rather than printing a raw shell error per run" \
  "grep -q 'throttle OFF: cannot write' '$T/ro.log' && ! grep -q 'Permission denied' '$T/ro.log'"
chmod 700 "$T/rostate"
METRICS_WARN_EVERY_SECONDS=1h bash "$METRICS_SH" > "$T/badwin.log" 2>&1
check "a window that is not a number is named and replaced, not silently zero" \
  "grep -q \"METRICS_WARN_EVERY_SECONDS='1h' is not a whole number\" '$T/badwin.log'"
# Leading zeros are stripped before the length is judged, the way alert.sh does it: nine
# characters of "000000010" is ten seconds, not an over-a-day value to be capped.
rm -f "$T/warnstate"/.metrics-warn-*
METRICS_WARN_EVERY_SECONDS=000000010 bash "$METRICS_SH" > "$T/zeros1.log" 2>&1
METRICS_WARN_EVERY_SECONDS=000000010 bash "$METRICS_SH" > "$T/zeros2.log" 2>&1
check "a value written with leading zeros is the number it spells, not a capped one" \
  "grep -q 'no container matches zebra' '$T/zeros1.log' && ! grep -q 'no container matches zebra' '$T/zeros2.log' && ! grep -q 'more than a day' '$T/zeros1.log'"
# And a genuinely huge one is capped OUT LOUD, not in silence.
METRICS_WARN_EVERY_SECONDS=999999 bash "$METRICS_SH" > "$T/bigwin.log" 2>&1
check "a window longer than a day says so rather than capping in silence" \
  "grep -q 'is more than a day; using 3600' '$T/bigwin.log'"
check "and no raw shell arithmetic error goes with it" \
  "! grep -q 'integer expression expected' '$T/badwin.log'"
# A clock step backwards leaves a stamp in the future. Under-warning is the failure this
# throttle must not cause, so a future stamp releases rather than silences.
mkdir -p "$T/warnstate"; printf '%s' "$(( $(date -u +%s) + 86400 ))" > "$T/warnstate/.metrics-warn-match-zebra"
bash "$METRICS_SH" > "$T/future.log" 2>&1
check "a stamp in the future does not silence the cause until the clock catches up" \
  "grep -q 'no container matches zebra' '$T/future.log'"

echo "== metrics: the suite cannot reach the shipped pager or the host's real filesystems"
# Measured before this was pinned: on a host under the floor, the tests ran the SHIPPED
# alert.sh, which sourced the host's /etc/faucet/watchdog.env and tried to POST. Running
# the suite on the faucet box could send a real page from a test run.
metrics_env
# `:-` on purpose: unpinned, these are UNSET, and under set -u an unset variable aborts
# the whole run with a bash error instead of failing the check that names the problem.
check "metrics_env points the pager at a path that does not exist" \
  "[ -n \"\${METRICS_ALERT_SH:-}\" ] && [ ! -e \"\$METRICS_ALERT_SH\" ]"
check "and the disk paths at the scratch dir, never / or /var/lib" \
  "case \"\${METRICS_DISK_PATHS:-}\" in \"\$T\"*) true ;; *) false ;; esac"

# EVERY case that talks to the API stub must sit ABOVE this line. The stub is a bash
# wrapper; the kill takes the wrapper and orphans the python that holds the port, so a
# case placed below still passes - against a server nothing is supposed to be running.
# That has now happened twice.
kill -- "-$API_PID" 2>/dev/null || kill "$API_PID" 2>/dev/null
# Prove it: a listener left behind is how a later run passes against the wrong server.
for _ in $(seq 1 20); do "$REAL_CURL" -sf -o /dev/null "http://127.0.0.1:$API_PORT/api/status" || break; sleep 0.25; done
check "the API stub is gone after the teardown, not orphaned for the next run to inherit" \
  "! '$REAL_CURL' -sf -o /dev/null 'http://127.0.0.1:$API_PORT/api/status'"

echo "== metrics: disk gauges per filesystem, and a floor that alerts"
metrics_env
echo running > "$STUB_CONTAINERS/z3-testnet-zebra-1"
export METRICS_DISK_PATHS="$T"
export METRICS_DISK_FLOOR_PCT=0            # nothing is below a 0% floor
bash "$METRICS_SH" > "$T/disk.log" 2>&1
check "free bytes gauge emitted with a path label" "grep -q 'faucet_disk_free_bytes{path=\"$T\"} [0-9]' '$METRICS_FILE'"
check "free percent gauge emitted" "grep -q 'faucet_disk_free_percent{path=\"$T\"} [0-9]' '$METRICS_FILE'"
check "not below floor at 0%" "grep -q 'faucet_disk_below_floor{path=\"$T\"} 0' '$METRICS_FILE'"
check "no alert sent when healthy" "! grep -q 'DISK LOW' '$T/disk.log'"

# A 101% floor is below-floor by construction, so the alert path runs without
# needing to actually fill a disk.
metrics_env
export METRICS_DISK_PATHS="$T" METRICS_DISK_FLOOR_PCT=101
printf '#!/usr/bin/env bash\necho "ALERTED: $*" >> %q\n' "$T/alerts.log" > "$T/fake-alert.sh"
chmod +x "$T/fake-alert.sh"; export METRICS_ALERT_SH="$T/fake-alert.sh"
bash "$METRICS_SH" > "$T/disk2.log" 2>&1
check "below-floor gauge is 1" "grep -q 'faucet_disk_below_floor{path=\"$T\"} 1' '$METRICS_FILE'"
check "logs the shortfall with both numbers" "grep -qE 'DISK LOW: .* has [0-9]+% free, floor is 101%' '$T/disk2.log'"
check "pages through the shared sender, as a page rather than a note" "grep -q 'ALERTED: 🚨 NEEDS YOU: disk low' '$T/alerts.log'"
check "the alert names the consequence" "grep -q 'snapshots and backups will start failing' '$T/alerts.log'"

echo "== metrics: a nonexistent disk path is skipped, not reported as 0 free"
metrics_env
export METRICS_DISK_PATHS="$T/definitely-not-here"
bash "$METRICS_SH" > /dev/null 2>&1
check "no gauge invented for a missing path" "! grep -q 'definitely-not-here' '$METRICS_FILE'"

echo "== metrics: the file only ever contains valid Prometheus lines"
# A log line leaking into the textfile can make node_exporter reject all of it,
# and the disk warning did exactly that until it was sent to stderr.
metrics_env
# TWO paths, so a per-path HELP header would be a duplicate and the check below can see
# it. With one path the repeated-HELP parse error is unreachable.
mkdir -p "$T/second"
# A path a human could plausibly type, carrying the two characters that end a label value
# early or start an escape sequence. Unescaped, node_exporter rejects the WHOLE file and
# this script still logs "wrote N metrics".
mkdir -p "$T/back\\slash"
# AND a quote. Only the backslash half was pinned, so deleting the quote substitution left
# the suite green while node_exporter rejected the file and exported nothing.
mkdir -p "$T/has\"quote"
export METRICS_DISK_PATHS="$T $T/second $T/back\\slash $T/has\"quote" METRICS_DISK_FLOOR_PCT=101
# IT PRINTS, like the shipped alert.sh, whose log() is a plain echo. A silent stub made
# the `>&2` on the pager call deletable with no check moving, and without it a "sent" line
# lands in the middle of the metrics file and node_exporter rejects the lot.
printf '#!/usr/bin/env bash\necho "$(date -u +%%FT%%TZ) alert: sent: $*"\nexit 0\n' > "$T/fake-alert.sh"
chmod +x "$T/fake-alert.sh"
export METRICS_ALERT_SH="$T/fake-alert.sh"
bash "$METRICS_SH" > "$T/valid.log" 2>&1
check "warning appears in the log, not the metrics file" "grep -q 'DISK LOW' '$T/valid.log' && ! grep -q 'DISK LOW' '$METRICS_FILE'"
# THE OLD CHECK PASSED ANYTHING STARTING WITH '#', which is exactly the line that broke
# this: `# HELP faucet_disk_free_bytes{path="/"} ...` is not a valid comment, and
# node_exporter rejects the WHOLE FILE on it - every gauge in here reached Prometheus as
# nothing at all. Verified against promtool and a real node_exporter; this is that parser's
# rules written out, because neither is in the harness image.
cat > "$T/promlint.awk" <<'AWK'
/^#[[:space:]]*(HELP|TYPE)[[:space:]]/ {
  name = $3
  if (name !~ /^[a-zA-Z_:][a-zA-Z0-9_:]*$/) { print "bad metric name in comment: " $0; bad = 1; next }
  if ($2 == "HELP") { if (name in help) { print "second HELP for " name; bad = 1 } ; help[name] = 1 }
  else { if (name in type) { print "second TYPE for " name; bad = 1 } ; type[name] = 1 }
  next
}
/^#/ { next }
/^[[:space:]]*$/ { next }
{
  line = $0
  if (line !~ /^[a-zA-Z_:][a-zA-Z0-9_:]*/) { print "bad metric name: " line; bad = 1; next }
  match(line, /^[a-zA-Z_:][a-zA-Z0-9_:]*/); rest = substr(line, RLENGTH + 1)
  # THE LABEL SET, character by character. The first version matched `\{[^}]*\}` and so
  # could not see an unescaped quote or backslash - the two malformations this script can
  # actually produce, from an operator-supplied path, and both of which make node_exporter
  # reject the whole file.
  if (substr(rest, 1, 1) == "{") {
    i = 2; n = length(rest)
    while (1) {
      while (i <= n && substr(rest, i, 1) == " ") i++
      if (i <= n && substr(rest, i, 1) == "}") { i++; break }
      if (match(substr(rest, i), /^[a-zA-Z_][a-zA-Z0-9_]*/) == 0) { print "bad label name: " line; bad = 1; next }
      i += RLENGTH
      while (i <= n && substr(rest, i, 1) == " ") i++
      if (substr(rest, i, 1) != "=") { print "expected = after label name: " line; bad = 1; next }
      i++
      while (i <= n && substr(rest, i, 1) == " ") i++
      if (substr(rest, i, 1) != "\"") { print "expected quoted label value: " line; bad = 1; next }
      i++
      closed = 0
      while (i <= n) {
        c = substr(rest, i, 1)
        if (c == "\\") {
          e = substr(rest, i + 1, 1)
          # Prometheus allows exactly these three escapes in a label value.
          if (e != "\\" && e != "\"" && e != "n") { print "invalid escape sequence in label value: " line; bad = 1; broke = 1; break }
          i += 2; continue
        }
        if (c == "\"") { i++; closed = 1; break }
        i++
      }
      if (broke) { broke = 0; next }
      if (!closed) { print "unterminated label value: " line; bad = 1; next }
      while (i <= n && substr(rest, i, 1) == " ") i++
      if (substr(rest, i, 1) == ",") { i++; continue }
      if (substr(rest, i, 1) == "}") { i++; break }
      print "unexpected character in label set: " line; bad = 1; next
    }
    rest = substr(rest, i)
  }
  # value, then an OPTIONAL timestamp: the real parser takes one and the first version
  # did not, which would have failed a correct change rather than a wrong one.
  if (rest !~ /^[[:space:]]+[-+]?([0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?|Inf|NaN)([[:space:]]+-?[0-9]+)?[[:space:]]*$/) {
    print "bad value: " line; bad = 1
  }
}
END { exit bad ? 1 : 0 }
AWK
check "every line parses as Prometheus text exposition, comments included" \
  "awk -f '$T/promlint.awk' '$METRICS_FILE'"
# The labelled family is the one that broke it, so it has to be IN the file when the
# check runs, not merely possible.
check "and the file under test actually carries a labelled family" \
  "grep -q '^faucet_disk_free_bytes{path=' '$METRICS_FILE'"
check "whose HELP names the family, not one path's label set" \
  "grep -qx '# TYPE faucet_disk_free_bytes gauge' '$METRICS_FILE'"
check "a quote in a path is escaped, not passed through to end the label value early" \
  "grep -q 'faucet_disk_free_bytes{path=\"[^\"]*has.\"quote\"}' '$METRICS_FILE'"
check "a backslash in a path is escaped, not passed through to break the label set" \
  "grep -q 'faucet_disk_free_bytes{path=\"[^\"]*back\\\\\\\\slash\"}' '$METRICS_FILE'"
check "once, however many paths there are" \
  "[ \"\$(grep -c '^# HELP faucet_disk_free_bytes' '$METRICS_FILE')\" = 1 ]"
# mktemp makes 0600 and the mode used to go on AFTER the rename, so twice a minute a
# non-root scraper got EACCES on a file that had just been published. Reading the mode
# afterwards cannot see that window - by then the chmod has run either way - so it is read
# AT the rename, from a stub that records it and then does the move.
printf '#!/usr/bin/env bash\nstat -c %%a "$1" > "$MODE_LOG"\nexec /bin/mv "$@"\n' > "$T/bin/mv"
chmod +x "$T/bin/mv"
export MODE_LOG="$T/mode.log"; : > "$MODE_LOG"
bash "$METRICS_SH" > /dev/null 2>&1
rm -f "$T/bin/mv"
check "the file is already world-readable when it is renamed into place, not a beat later" \
  "[ \"\$(cat '$T/mode.log')\" = 644 ]"
check "and it really is world-readable once published" \
  "[ \"\$(stat -c %a '$METRICS_FILE')\" = 644 ]"

echo "== metrics: the knobs that turn alerting off are validated, and skips are said out loud"
metrics_env
# This script is the box's ONLY disk alerting - watchdog.sh has no disk check - so a typo
# in the floor silently turns it off. Measured before this: two `integer expression
# expected` errors per path per run and faucet_disk_below_floor pinned at 0.
METRICS_DISK_PATHS="$T" METRICS_DISK_FLOOR_PCT="10%" bash "$METRICS_SH" > "$T/floor.log" 2>&1
# The cap and the off-switch note: both correct, neither asserted until now.
METRICS_DISK_PATHS="$T" METRICS_DISK_FLOOR_PCT=012345 bash "$METRICS_SH" > "$T/cap.log" 2>&1
check "a floor too long to be a percent is capped, naming what was typed" \
  "grep -q 'METRICS_DISK_FLOOR_PCT=012345 is not a percent' '$T/cap.log'"
METRICS_DISK_PATHS="$T" METRICS_DISK_FLOOR_PCT=0 bash "$METRICS_SH" > "$T/zero.log" 2>&1
check "and a floor of zero says the box's only disk alerting is off" \
  "grep -q 'no disk floor alert will ever fire' '$T/zero.log'"
check "a floor that is not a number is named and replaced" \
  "grep -q \"METRICS_DISK_FLOOR_PCT='10%' is not a whole percent\" '$T/floor.log'"
check "and no raw shell arithmetic error goes with it" \
  "! grep -q 'integer expression expected' '$T/floor.log'"
check "the disk gauges are still emitted at the replacement floor" \
  "grep -q '^faucet_disk_below_floor{path=' '$METRICS_FILE'"
METRICS_DISK_PATHS="$T" METRICS_DISK_FLOOR_PCT=0101 bash "$METRICS_SH" > "$T/floor2.log" 2>&1
check "leading zeros are stripped before the value is judged, so 0101 is 101 percent" \
  "grep -qx 'faucet_disk_below_floor{path=\"'\"$T\"'\"} 1' '$METRICS_FILE'"
# A path that is not a directory used to vanish with no line at all, while a container
# match that finds nothing gets a throttled warning for exactly this reason.
metrics_env
METRICS_DISK_PATHS="$T/no-such-mount" bash "$METRICS_SH" > "$T/nopath.log" 2>&1
check "a disk path that is not a directory says so rather than vanishing" \
  "grep -q 'is not a directory, so it has no disk gauges' '$T/nopath.log'"
check "and it is throttled like every other repeating warning" \
  "grep -q 'no-such-mount' '$T/nopath.log'"
# ONE KEY PER PATH. `tr -c 'A-Za-z0-9' '-'` alone maps a-b and a.b to the same key, so
# with two bad mounts only the first was ever reported and the second was invisible.
metrics_env
# THE THROTTLE HAS TO BE ON, or both paths warn regardless and the collision is invisible:
# metrics_env sets the window to 0, which disables it.
METRICS_WARN_EVERY_SECONDS=3600 METRICS_DISK_PATHS="$T/mount-a $T/mount.a" bash "$METRICS_SH" > "$T/collide.log" 2>&1
check "two bad paths that sanitise to the same string are still two causes" \
  "[ \"\$(grep -c 'is not a directory' '$T/collide.log')\" = 2 ]"
# A long path made the state FILENAME exceed NAME_MAX, which turned the throttle off and
# blamed the state directory, which was fine.
metrics_env
LONGP="$T/$(printf 'x%.0s' $(seq 1 300))"
METRICS_DISK_PATHS="$LONGP" bash "$METRICS_SH" > "$T/long1.log" 2>&1
METRICS_WARN_EVERY_SECONDS=3600 METRICS_DISK_PATHS="$LONGP" bash "$METRICS_SH" > "$T/long2.log" 2>&1
check "a very long path does not defeat the throttle by overflowing its state filename" \
  "! grep -q 'throttle OFF' '$T/long1.log' && ! grep -q 'throttle OFF' '$T/long2.log'"
# A label value must be valid UTF-8 and escaping cannot make it so; node_exporter rejects
# the whole file on a stray byte while this script logs "wrote N metrics".
metrics_env
if command -v iconv >/dev/null 2>&1; then
  BADDIR="$(printf '%s' "$T/bad")$(printf '\377')byte"
  mkdir -p "$BADDIR" 2>/dev/null
  if [ -d "$BADDIR" ]; then
    METRICS_DISK_PATHS="$BADDIR" bash "$METRICS_SH" > "$T/utf8.log" 2>&1
    check "a path that is not valid UTF-8 is skipped rather than emitted" \
      "! grep -q '^faucet_disk_free_bytes{' '$METRICS_FILE'"
    check "and says why, because the alternative is a file the scraper refuses whole" \
      "grep -q 'not valid UTF-8' '$T/utf8.log'"
  else
    echo "  skip: this filesystem will not take a non-UTF-8 directory name"
  fi
else
  echo "  skip: no iconv here"
fi

echo "== metrics: an answer from the PROXY is not an answer from the app"
# This branch is what moves the probe off 127.0.0.1:3000 and onto the watchdog's public
# origin, which puts caddy in the path for the first time. Its 502 page is a non-empty
# body, and faucet_up meant "a body came back": up read 1 with every other gauge absent,
# a shape in which neither `faucet_up == 0` nor `faucet_ready == 0` can ever fire.
metrics_env
BAD_PORT=$((API_PORT + 11))
python3 - "$BAD_PORT" <<'BADPY' >/dev/null 2>&1 &
import http.server, sys
port = int(sys.argv[1])
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(502)
        self.send_header("content-type", "text/html")
        self.end_headers()
        self.wfile.write(b"<html><title>502 Bad Gateway</title></html>")
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
BADPY
BAD_PID=$!
for _ in $(seq 1 40); do "$REAL_CURL" -s -o /dev/null "http://127.0.0.1:$BAD_PORT/api/ready" && break; sleep 0.25; done
METRICS_FAUCET_URL="http://127.0.0.1:$BAD_PORT" bash "$METRICS_SH" > "$T/badgw.log" 2>&1
check "a 502 from the proxy is faucet_up 0, not 1 with an error page for a body" \
  "grep -qx 'faucet_up 0' '$METRICS_FILE'"
check "and the journal names the code, so it is not confused with a dead app" \
  "grep -q 'answered 502, which is not the app' '$T/badgw.log'"
kill "$BAD_PID" 2>/dev/null
echo "== metrics: a truncated answer is not a healthy one"
# curl's exit status was discarded, so a server that sends 200 and half a body and then
# hangs past --max-time gave http_code 200 with a fragment, and `ready` and `canBuildTx`
# were parsed out of it: faucet_up 1 and faucet_ready 1 on an answer that never finished,
# which is a shape where neither alert rule can fire.
metrics_env
CUT_PORT=$((API_PORT + 13))
python3 - "$CUT_PORT" <<'CUTPY' >/dev/null 2>&1 &
import socket, sys, threading, time
port = int(sys.argv[1])
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", port)); s.listen(8)
BODY = b'{"ready": true, "reason": null, "node": {"ready": true, "canBuildTx": true}}'
# ONE THREAD PER CONNECTION. Single-threaded, the first request's hold blocked accept()
# and every later request got no response at all - which the "nothing answered" arm
# catches, so the truncation guard was never the thing under test.
def serve(c):
    try:
        c.recv(4096)
        # A complete status line and headers, then HALF the body, then hold the socket.
        c.sendall(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: "
                  + str(len(BODY)).encode() + b"\r\n\r\n" + BODY[: len(BODY) // 2])
        time.sleep(30)
    except Exception:
        pass
    finally:
        try: c.close()
        except Exception: pass
while True:
    c, _ = s.accept()
    threading.Thread(target=serve, args=(c,), daemon=True).start()
CUTPY
CUT_PID=$!
# Wait for the LISTENER, not for a complete response: this server never finishes one.
for _ in $(seq 1 40); do "$REAL_CURL" -s -o /dev/null --max-time 1 "http://127.0.0.1:$CUT_PORT/api/ready"; [ $? -ne 7 ] && break; sleep 0.25; done
METRICS_FAUCET_URL="http://127.0.0.1:$CUT_PORT" METRICS_CURL_TIMEOUT=2 bash "$METRICS_SH" > "$T/cut.log" 2>&1
check "a body that never finished is not read as an answer" "grep -qx 'faucet_up 0' '$METRICS_FILE'"
check "and no readiness is invented out of the fragment" "! grep -q '^faucet_ready ' '$METRICS_FILE'"
# THE EXACT PAIR, not the common prefix. With the server never started, faucet_up 0 and
# "no faucet_ready" are true of any dead port and the prefix matches curl exit 7 too, so
# all three checks passed against nothing at all. 28 is the timeout; 200 is what makes it
# a truncation rather than an outage.
check "the journal names curl's status AND the code, so a dead port cannot pass for this" \
  "grep -q 'curl exit 28, code 200' '$T/cut.log'"
kill "$CUT_PID" 2>/dev/null

echo "== metrics: a check it cannot run is said, not silently passed"
# label_is_utf8 needs iconv. Without it the check fails OPEN, which is the right direction
# - but silence there means a file the scraper refuses whole while this script logs
# "wrote N metrics", so it says so.
metrics_env
mkdir -p "$T/noiconv"
# env, dirname and tail are reached by wd_value, the ALERT_SH default and path_key. The
# case passed without them only because those three branches happen not to run here, which
# is the next person's confusing failure.
for b in bash env dirname tail curl date df awk sed tr cut head printf grep od cksum stat mktemp mv chmod mkdir cat seq; do
  src="$(PATH="$BASE_PATH" command -v $b 2>/dev/null)"; [ -n "$src" ] && ln -sf "$src" "$T/noiconv/$b"
done
ln -sf "$SCRATCH/stubs/docker" "$T/noiconv/docker"
PATH="$T/noiconv" bash "$METRICS_SH" > "$T/noiconv.log" 2>&1
check "no iconv is named rather than passing quietly" \
  "grep -q 'no iconv here' '$T/noiconv.log'"
check "and the run still produces a file, because failing open is the right direction" \
  "grep -q '^faucet_up ' '$METRICS_FILE'"

echo "== metrics: someone else's 200 is not this app's answer"
# `ready` is the FIRST key /api/ready emits, so no truncation removes it, and jfield finds
# it inside a NESTED object - so a foreign API carrying node.ready satisfied the guard and
# its nested value was read as top-level readiness. `ts` is the LAST key, so a body that
# stops early loses it. Both are required.
metrics_env
FOREIGN_PORT=$((API_PORT + 17))
python3 - "$FOREIGN_PORT" <<'FGN' >/dev/null 2>&1 &
import http.server, json, sys
port = int(sys.argv[1])
# No top-level `ready`, but a nested one - and no `ts`.
FOREIGN = {"node": {"ready": True, "height": 123}, "service": "someone-elses-api"}
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        raw = json.dumps(FOREIGN).encode()
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
FGN
FOREIGN_PID=$!
for _ in $(seq 1 40); do "$REAL_CURL" -sf -o /dev/null "http://127.0.0.1:$FOREIGN_PORT/api/ready" && break; sleep 0.25; done
METRICS_FAUCET_URL="http://127.0.0.1:$FOREIGN_PORT" bash "$METRICS_SH" > "$T/foreign.log" 2>&1
check "a foreign body carrying node.ready is not this faucet answering" \
  "grep -qx 'faucet_up 0' '$METRICS_FILE'"
check "and no readiness is read out of its nested field" "! grep -q '^faucet_ready ' '$METRICS_FILE'"
check "the journal names both keys it needed" "grep -q 'needs .ready. and .ts.' '$T/foreign.log'"
kill "$FOREIGN_PID" 2>/dev/null
# AND THE OTHER HALF. The fixture above has neither key, so it cannot tell which one is
# doing the work: reducing the guard to `ts` alone left the suite green. A foreign API
# carrying a numeric ts and no ready is the common shape.
metrics_env
TSONLY_PORT=$((API_PORT + 21))
python3 - "$TSONLY_PORT" <<'TSO' >/dev/null 2>&1 &
import http.server, json, sys
port = int(sys.argv[1])
BODY = {"service": "someone-elses-api", "ts": 1785180000, "node": {"ready": True}}
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        raw = json.dumps(BODY).encode()
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
TSO
TSONLY_PID=$!
for _ in $(seq 1 40); do "$REAL_CURL" -sf -o /dev/null "http://127.0.0.1:$TSONLY_PORT/api/ready" && break; sleep 0.25; done
METRICS_FAUCET_URL="http://127.0.0.1:$TSONLY_PORT" bash "$METRICS_SH" > "$T/tsonly.log" 2>&1
check "a body with ts but no top-level ready is not this faucet either" \
  "grep -qx 'faucet_up 0' '$METRICS_FILE' && ! grep -q '^faucet_ready ' '$METRICS_FILE'"
kill "$TSONLY_PID" 2>/dev/null

echo "== metrics: a value that is not a number is dropped, not written"
# The label side is guarded hard because one bad label makes node_exporter reject the WHOLE
# file. A bad VALUE reaches the same outcome: "balanceTaz":1.2.3 wrote `faucet_balance_taz
# 1.2.3` and zero series were exported.
metrics_env
BADNUM_PORT=$((API_PORT + 18))
python3 - "$BADNUM_PORT" <<'BADN' >/dev/null 2>&1 &
import http.server, sys
port = int(sys.argv[1])
READY = b'{"ready": true, "reason": null, "node": null, "backend": {"reachable": true}, "ts": 1}'
STATUS = b'{"network": "testnet", "balanceTaz":1e400, "queueDepth":1.2.3, "empty": false}'
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        raw = READY if self.path.startswith("/api/ready") else STATUS
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
BADN
BADNUM_PID=$!
for _ in $(seq 1 40); do "$REAL_CURL" -sf -o /dev/null "http://127.0.0.1:$BADNUM_PORT/api/ready" && break; sleep 0.25; done
METRICS_FAUCET_URL="http://127.0.0.1:$BADNUM_PORT" bash "$METRICS_SH" > /dev/null 2>&1
check "a magnitude no float64 can hold is dropped rather than written into the file" \
  "! grep -q '^faucet_balance_taz ' '$METRICS_FILE'"
check "and so is a number with two decimal points" "! grep -q '^faucet_queue_depth ' '$METRICS_FILE'"
check "and the gauges around them still arrive, so a bad value costs one gauge, not all" \
  "grep -qx 'faucet_empty 0' '$METRICS_FILE' && grep -qx 'faucet_up 1' '$METRICS_FILE'"
# The exposition check proper runs later with its own parser; here it is enough that no
# line carries the malformed value.
check "and neither value is anywhere in the file" \
  "! grep -q '1.2.3' '$METRICS_FILE' && ! grep -q 'e400' '$METRICS_FILE'"
kill "$BADNUM_PID" 2>/dev/null

echo "== metrics: a 200 on /api/status that is not the faucet's is not five gauges"
# /api/ready is healthy, /api/status answers a maintenance page. Five gauges vanishing with
# no journal line is the silence this branch was written to end, and it only covered the
# curl-error case.
metrics_env
MIXED_PORT=$((API_PORT + 19))
python3 - "$MIXED_PORT" <<'MIX' >/dev/null 2>&1 &
import http.server, sys
port = int(sys.argv[1])
READY = b'{"ready": true, "reason": null, "node": null, "backend": {"reachable": true}, "ts": 1}'
# Not HTML: a JSON body that CONTAINS the word network without it being a key. A bare
# substring test passed this and wrote its queueDepth as ours.
# The word as a COMPLETE quoted string, so a substring test for `"network"` matches it
# while a test for `"network":` does not. "network unreachable" would not discriminate.
HTML = b'{"service": "someone-elses-api", "error": "network", "queueDepth": 77}'
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        ready = self.path.startswith("/api/ready")
        raw = READY if ready else HTML
        self.send_response(200)
        self.send_header("content-type", "application/json" if ready else "text/html")
        self.send_header("content-length", str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
MIX
MIXED_PID=$!
for _ in $(seq 1 40); do "$REAL_CURL" -sf -o /dev/null "http://127.0.0.1:$MIXED_PORT/api/ready" && break; sleep 0.25; done
METRICS_FAUCET_URL="http://127.0.0.1:$MIXED_PORT" bash "$METRICS_SH" > "$T/mixed.log" 2>&1
check "readiness still comes through, because /api/ready did answer" \
  "grep -qx 'faucet_up 1' '$METRICS_FILE' && grep -qx 'faucet_ready 1' '$METRICS_FILE'"
check "the status gauges are absent, and the journal says why rather than nothing" \
  "! grep -q '^faucet_balance_taz ' '$METRICS_FILE' && grep -q 'not the faucet.s (no .network. field)' '$T/mixed.log'"
check "and a body where network is a VALUE rather than a key is not the faucet either" \
  "! grep -q '^faucet_queue_depth 77' '$METRICS_FILE'"
kill "$MIXED_PID" 2>/dev/null

echo "== metrics: a 200 that is not the app's body is not the app answering"
# This branch is what moves the probe onto the PUBLIC origin, so caddy is in the path: its
# maintenance page and a mis-routed vhost both answer 200 with HTML, and that used to read
# as faucet_up 1 with every other gauge absent - the shape where neither alert rule fires.
metrics_env
HTML_PORT=$((API_PORT + 15))
python3 - "$HTML_PORT" <<'HTMLPY' >/dev/null 2>&1 &
import http.server, sys
port = int(sys.argv[1])
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"<html><title>Scheduled maintenance</title></html>"
        self.send_response(200); self.send_header("content-type", "text/html")
        self.send_header("content-length", str(len(body))); self.end_headers()
        self.wfile.write(body)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
HTMLPY
HTML_PID=$!
for _ in $(seq 1 40); do "$REAL_CURL" -sf -o /dev/null "http://127.0.0.1:$HTML_PORT/api/ready" && break; sleep 0.25; done
METRICS_FAUCET_URL="http://127.0.0.1:$HTML_PORT" bash "$METRICS_SH" > "$T/html.log" 2>&1
check "a 200 maintenance page is faucet_up 0, not 1 with every other gauge missing" \
  "grep -qx 'faucet_up 0' '$METRICS_FILE'"
check "and the journal says the body is not the app's, naming the field it looked for" \
  "grep -q 'not /api/ready' '$T/html.log'"
kill "$HTML_PID" 2>/dev/null

echo "== metrics: an empty 200 is not the same as a dead app"
metrics_env
EMPTY_PORT=$((API_PORT + 14))
python3 - "$EMPTY_PORT" <<'EMPTYPY' >/dev/null 2>&1 &
import http.server, sys
port = int(sys.argv[1])
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        # /api/ready answers 200 with NO body; /api/status fails, so the asymmetric -f
        # path is exercised in the same run.
        if self.path.startswith("/api/status"):
            self.send_response(500); self.send_header("content-length", "0"); self.end_headers(); return
        self.send_response(200); self.send_header("content-length", "0"); self.end_headers()
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
EMPTYPY
EMPTY_PID=$!
for _ in $(seq 1 40); do "$REAL_CURL" -s -o /dev/null "http://127.0.0.1:$EMPTY_PORT/api/ready" && break; sleep 0.25; done
METRICS_FAUCET_URL="http://127.0.0.1:$EMPTY_PORT" bash "$METRICS_SH" > "$T/empty.log" 2>&1
check "a 200 with an empty body says so rather than reading as a dead app" \
  "grep -q 'answered 200 with an EMPTY body' '$T/empty.log'"
check "and /api/status not answering cleanly is said too, rather than five gauges vanishing" \
  "grep -q 'GET /api/status did not answer cleanly' '$T/empty.log'"
kill "$EMPTY_PID" 2>/dev/null

echo "== metrics: a publish that failed is not reported as a write"
metrics_env
mkdir -p "$T/ro"; : > "$T/ro/f.prom"; chmod 500 "$T/ro"
METRICS_FILE="$T/ro/f.prom" bash "$METRICS_SH" > "$T/ro.log" 2>&1
check "it says the publish failed" "grep -q 'FAILED to publish' '$T/ro.log'"
check "and does NOT claim it wrote metrics to a file it could not write" \
  "! grep -q 'wrote .* metrics to' '$T/ro.log'"
chmod 700 "$T/ro"

echo "== metrics: the extractors read what the app actually emits"
metrics_env
# balanceTaz is zat/1e8 and JSON.stringify writes an exponent below a millionth, so a
# wallet holding 100 zatoshi serialised as 1e-6. The number class had no `e`, so the
# match stopped at the 1 and the gauge read ONE TAZ for a wallet that was empty.
# python3, like every other stub server here: the harness image has no node.
EXP_PORT=$((API_PORT + 9))
python3 - "$EXP_PORT" <<'EXPPY' >/dev/null 2>&1 &
import http.server, json, sys
port = int(sys.argv[1])
READY = {"ready": True, "reason": None, "node": None, "backend": {"reachable": True}}
# balanceTaz is zat/1e8 and JSON writes an exponent below a millionth; 1e-07 TAZ is ten
# zatoshi, a real balance for a faucet that has just been drained. Pretty-printed on
# purpose: the node extractor walked ONE line and stopped, so a multi-line body silently
# lost every node gauge.
STATUS = {"network": "testnet", "balanceTaz": 1e-07, "empty": False, "queueDepth": 0,
          "node": {"ready": True, "syncPercent": 99.9, "height": 4204726,
                   "shield": {"state": "fresh"}}}
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps(READY) if self.path == "/api/ready" else json.dumps(STATUS, indent=2)
        # A TAB before the node object, which the literal-space strip could not see.
        body = body.replace('"node": {', '"node":\t{')
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body.encode())
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
EXPPY
EXP_PID=$!
for _ in $(seq 1 40); do curl -sf -o /dev/null "http://127.0.0.1:$EXP_PORT/api/status" && break; sleep 0.25; done
METRICS_FAUCET_URL="http://127.0.0.1:$EXP_PORT" bash "$METRICS_SH" > /dev/null 2>&1
check "an exponent is a number: a balance of 1e-07 is not reported as 1" \
  "grep -qx 'faucet_balance_taz 1e-07' '$METRICS_FILE'"
# The node block here comes from /api/status, which is the pretty-printed body.
# The whitespace strip before the brace test was literal spaces, so a tab between the key
# and its object made the node block invisible - and the gauges vanish in silence.
check "a TAB between the key and its object is whitespace too" \
  "grep -qx 'faucet_node_height 4204726' '$METRICS_FILE'"
check "and a pretty-printed body still yields the node gauges" \
  "grep -qx 'faucet_node_height 4204726' '$METRICS_FILE' && grep -qx 'faucet_node_sync_percent 99.9' '$METRICS_FILE'"
kill "$EXP_PID" 2>/dev/null

echo "== metrics: a node that is NULL yields no node gauges, never the next object's numbers"
# With cTAZ enabled the object after "node" carries height and syncPercent too; an extractor
# that took the next brace reported the feature-net's figures as the Zcash node's.
metrics_env
NULL_PORT=$((API_PORT + 7))
python3 - "$NULL_PORT" <<'PY' >/dev/null 2>&1 &
import http.server, json, sys
port = int(sys.argv[1])
READY = {"ready": True, "reason": None, "node": None, "backend": {"reachable": True}, "balanceTaz": 3.5, "ts": 1}
STATUS = {"network": "testnet", "dripTaz": 0.1, "balanceTaz": 3.5, "empty": False, "queueDepth": 2, "node": None,
          "ctaz": {"enabled": True, "height": 9999, "syncPercent": 42.5, "readiness": "ready"}}
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps(READY if self.path == "/api/ready" else STATUS).encode()
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
PY
NULL_PID=$!
for _ in $(seq 1 40); do "$REAL_CURL" -sf -o /dev/null "http://127.0.0.1:$NULL_PORT/api/status" && break; sleep 0.25; done
METRICS_FAUCET_URL="http://127.0.0.1:$NULL_PORT" bash "$METRICS_SH" > /dev/null 2>&1
check "no node height invented from the cTAZ object" "! grep -q '^faucet_node_height ' '$METRICS_FILE'"
check "no node sync percent invented either" "! grep -q '^faucet_node_sync_percent ' '$METRICS_FILE'"
check "no node ready gauge from a null node" "! grep -q '^faucet_node_ready ' '$METRICS_FILE'"
check "while the top-level gauges are still there, so the file was written" "grep -qx 'faucet_up 1' '$METRICS_FILE' && grep -qx 'faucet_balance_taz 3.5' '$METRICS_FILE'"
kill "$NULL_PID" 2>/dev/null

echo "== metrics: a key the node object LACKS is answered by nothing, not by the next object"
# The slice is bounded at the node object's own closing brace, nesting and strings
# counted, so cTAZ's height cannot stand in for a node height that was never sent.
metrics_env
python3 - "$((API_PORT + 8))" <<'PY' >/dev/null 2>&1 &
import http.server, json, sys
port = int(sys.argv[1])
READY = {"ready": True, "reason": None, "node": {"ready": True, "shield": {"state": "safe", "reason": "a } brace in text"}}, "backend": {"reachable": True}, "balanceTaz": 3.5, "ts": 1}
STATUS = {"network": "testnet", "dripTaz": 0.1, "balanceTaz": 3.5, "empty": False, "queueDepth": 2,
          "node": {"ready": True, "shield": {"state": "safe", "reason": "a } brace in text"}},
          "ctaz": {"enabled": True, "height": 9999, "syncPercent": 42.5, "ready": False}}
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps(READY if self.path == "/api/ready" else STATUS).encode()
        self.send_response(200); self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
http.server.HTTPServer(("127.0.0.1", port), H).serve_forever()
PY
LACK_PID=$!; LACK_PORT=$((API_PORT + 8))
for _ in $(seq 1 40); do "$REAL_CURL" -sf -o /dev/null "http://127.0.0.1:$LACK_PORT/api/status" && break; sleep 0.25; done
METRICS_FAUCET_URL="http://127.0.0.1:$LACK_PORT" bash "$METRICS_SH" > /dev/null 2>&1
check "node.ready is read from the node object, past a brace inside a string" "grep -qx 'faucet_node_ready 1' '$METRICS_FILE'"
check "no node height: the node object has none and cTAZ's is not borrowed" "! grep -q '^faucet_node_height ' '$METRICS_FILE'"
check "no node sync percent either" "! grep -q '^faucet_node_sync_percent ' '$METRICS_FILE'"
kill "$LACK_PID" 2>/dev/null

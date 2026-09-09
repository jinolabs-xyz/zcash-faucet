#!/usr/bin/env bash
# Stack watchdog for the z3 shielded faucet. Its whole job is that no single
# failure leaves the faucet dark and needing a human on SSH. It does four things
# on a loop and nothing clever:
#
#   1. Reboot survival. Force restart=unless-stopped on every target container,
#      so a box reboot brings the whole stack back with no intervention.
#   2. Dead-container recovery. If a target container has exited or died, start
#      it again. This is the real fix for the wallet fault we kept hitting:
#      zallet exits when zebra closes the mempool stream, and this brings it
#      straight back instead of leaving drips paused.
#   3. Hung web-app recovery. If faucet-web is "running" but /api/health stops
#      answering, restart just that container.
#   4. Honest alerting. If the faucet is not READY (cannot serve a drip) for
#      longer than the grace window, POST to WATCHDOG_ALERT_URL once. It does
#      NOT restart anything for un-readiness alone, because a first sync or a
#      background refill is un-ready on purpose and restarting would only slow
#      it down.
#
# Everything is env-configurable so it survives the container-naming drift
# between the manual faucet-web and the compose overlay. Logs go to stdout so
# journald keeps them. Run it under the systemd unit next to this file.
set -uo pipefail

INTERVAL="${WATCHDOG_INTERVAL:-30}"                 # seconds between sweeps
FAUCET_URL="${WATCHDOG_FAUCET_URL:-http://127.0.0.1:3000}"
FAUCET_FAIL_LIMIT="${WATCHDOG_FAUCET_FAIL_LIMIT:-3}" # consecutive liveness misses before restart
READY_GRACE_SECS="${WATCHDOG_READY_GRACE_SECS:-1800}" # 30 min un-ready before we page
ALERT_URL="${WATCHDOG_ALERT_URL:-}"                 # optional webhook for alerts
ALERT_FORMAT="${WATCHDOG_ALERT_FORMAT:-slack}"      # slack (default) or discord

# Crash-loop escalation. A container that needs starting again and again is not
# being recovered, it is looping, and the old code could not tell the difference:
# it announced "recovered" on every attempt, so 812 consecutive failures over 16
# hours looked exactly like 812 successful self-heals and nobody was ever paged.
# Counts live on disk so a watchdog restart does not reset the evidence.
FLAP_ESCALATE="${WATCHDOG_FLAP_ESCALATE:-3}"        # consecutive attempts before we page
FLAP_REALERT="${WATCHDOG_FLAP_REALERT:-60}"         # then re-page every N attempts
STATE_DIR="${WATCHDOG_STATE_DIR:-/run/faucet-watchdog}"

# Poison auto-heal (step 5). Restarting zallet cannot fix a crash whose cause is a row
# in wallet.db, so the watchdog runs the repair tools when it sees that exact signature.
# Off by setting HEAL_ENABLED=0, and capped so a wrong diagnosis cannot rewrite the
# wallet on a loop - after the cap it pages instead of retrying.
HEAL_ENABLED="${WATCHDOG_HEAL_ENABLED:-1}"
HEAL_MAX_ATTEMPTS="${WATCHDOG_HEAL_MAX_ATTEMPTS:-2}"
HEAL_TOOLS_DIR="${WATCHDOG_HEAL_TOOLS_DIR:-$(dirname "$0")}"
heal_attempts=0
alerted_heal_giveup=0

# Miner stall recovery (step 6). The miner holds ONE persistent RPC connection to zebra
# and does not reconnect when zebra restarts: it loops `getblocktemplate: Peer
# disconnected` forever while its heartbeat stays fresh, so Restart=always never fires
# because the process never exits. 2026-08-18: zebra restarted, the miner went ~18h with
# no template and nothing recovered it. The heartbeat is the tell - written recently
# (alive) but lastTemplateAt old (not mining) - and a restart re-establishes the socket.
MINER_HEAL_ENABLED="${WATCHDOG_MINER_HEAL_ENABLED:-1}"
MINER_HEARTBEAT="${WATCHDOG_MINER_HEARTBEAT:-/var/lib/faucet-miner/heartbeat.json}"
MINER_UNIT="${WATCHDOG_MINER_UNIT:-zcash-testnet-miner.service}"
MINER_STALL_SECS="${WATCHDOG_MINER_STALL_SECS:-300}"          # alive but no template this long = wedged
MINER_HEARTBEAT_FRESH_SECS="${WATCHDOG_MINER_HEARTBEAT_FRESH_SECS:-60}" # older writtenAt = process itself down (Restart=always' job, not ours)
MINER_START_GRACE_SECS="${WATCHDOG_MINER_START_GRACE_SECS:-120}"  # just (re)started: give it time to fetch its first template
MINER_HEAL_MAX="${WATCHDOG_MINER_HEAL_MAX:-3}"               # then page instead of restart-looping the miner
# Step 7 stops the miner while it heals the node. A node being rewound ~100 blocks with a
# miner still submitting on top of the old tip is how the 2026-09-07 fork kept growing.
# The miner has its own sync guard (MINER_MAX_LAG); this is the layer that acts before
# that guard's limit is reached, because a heal is already certain the node is behind.
NODE_STOPS_MINER="${WATCHDOG_NODE_STOPS_MINER:-1}"

# Node sync-stall recovery (step 7). Zebra can sit on one tip while the network moves on:
# a self-mined block briefly forks it, or, far more often here, a thin and flaky testnet
# peer set stops serving blocks and zebra's own 67s sync-restart loop never recovers. The
# container stays "running", so steps 1-2 never fire, and step 4 only pages after the
# grace window. 2026-09-07: the node sat 300-1400 blocks behind, frozen, and the gate
# correctly refused every drip for over an hour until a human restarted zebra by hand.
# Twice in one day. This is that hand.
NODE_HEAL_ENABLED="${WATCHDOG_NODE_HEAL_ENABLED:-1}"
NODE_LAG_LIMIT="${WATCHDOG_NODE_LAG_LIMIT:-50}"                 # blocks behind before a stuck tip counts as a stall
NODE_STALL_SECS="${WATCHDOG_NODE_STALL_SECS:-300}"              # behind AND tip unmoved this long = wedged
NODE_HEAL_MAX="${WATCHDOG_NODE_HEAL_MAX:-5}"                    # restarts before paging instead
NODE_CLEAR_CACHE_AFTER="${WATCHDOG_NODE_CLEAR_CACHE_AFTER:-2}"  # from this attempt on, also drop the peer cache
NODE_DROP_NONFINAL_AFTER="${WATCHDOG_NODE_DROP_NONFINAL_AFTER:-3}" # from this attempt on, also drop the non-finalized state
ZEBRA_CHAIN_VOLUME="${WATCHDOG_ZEBRA_CHAIN_VOLUME:-z3-testnet-chain}"
node_last_height=0
node_stall_since=0
node_heal_attempts=0
miner_waiting_logged=0     # step 6 has already noted the miner's own wait
# "step 7 stopped the miner for this episode" lives on DISK, through flap_get/flap_set,
# for the reason the flap counts do: this unit is Restart=always and a deploy restarts it.
# An in-memory flag lost mid-episode would leave the miner stopped forever, and the panel
# would read the calm "off, unit stopped" for a miner nobody meant to park.
MINER_STOP_KEY="miner-stopped-for-node-heal"
alerted_node_giveup=0
node_heal_what=""     # the deepest thing the current episode has tried, for the one report
node_stall_lag=0      # how far behind it was when the episode began

# 0 = loop forever (production). Tests set this to run an exact number of sweeps.
MAX_TICKS="${WATCHDOG_MAX_TICKS:-0}"

# Target containers, matched by name substring so exact compose prefixes and the
# hand-run faucet-web container both resolve. Override any of these in the env.
FAUCET_MATCH="${WATCHDOG_FAUCET_MATCH:-faucet-web}"
ZEBRA_MATCH="${WATCHDOG_ZEBRA_MATCH:-zebra}"
ZALLET_MATCH="${WATCHDOG_ZALLET_MATCH:-zallet}"

log() { echo "$(date -u +%FT%TZ) watchdog: $*"; }

# Escapes the two characters that would break the JSON body. Alert text is
# ours, not user input, but a container name with a quote in it should not
# silently drop an alert.
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# Delegates to the shared sender so one URL covers every unit. Falls back to
# posting inline if alert.sh is not installed yet, so an upgrade cannot mute us.
ALERT_SH="${WATCHDOG_ALERT_SH:-$(dirname "$0")/alert.sh}"
alert() {
  log "ALERT: $1"
  if [ -x "$ALERT_SH" ]; then
    # --now: these are already one per episode, so alert.sh's per-cause cooldown must not
    # hold a NEEDS YOU behind the FIXED that preceded it. Its output is kept: "sent" and
    # any refusal belong in this journal, not in /dev/null.
    "$ALERT_SH" --now "$1" 2>&1 | sed 's/^/alert.sh: /'
    [ "${PIPESTATUS[0]}" -eq 0 ] || log "alert send failed via $ALERT_SH"
    return 0
  fi
  [ -n "$ALERT_URL" ] || return 0
  local msg body
  msg="[zcash-faucet watchdog] $(json_escape "$1")"
  case "$ALERT_FORMAT" in
    discord) body="{\"content\":\"$msg\"}" ;;
    slack|*)  body="{\"text\":\"$msg\"}" ;;
  esac
  curl -fsS --max-time 10 -H 'content-type: application/json' \
    -d "$body" "$ALERT_URL" >/dev/null 2>&1 || log "alert webhook POST failed"
}

# TWO KINDS OF MESSAGE, AND THE MARKER IS THE POINT. A phone shows the first few words,
# so severity has to be readable before the sentence is. One report per RESOLVED episode,
# sent only once the watchdog has SEEN the recovery and never on the attempt, and one
# page when it cannot fix something. The attempts in between are journal lines. That
# keeps the rule that a self-heal is never silent (812 unnoticed restarts, once) without
# the per-attempt chatter that trains a reader to stop looking at the channel.
fixed()  { alert "✅ FIXED: $1"; }
danger() { alert "🚨 NEEDS YOU: $1"; }

# First running-or-stopped container id whose name contains $1 (empty if none).
find_container() {
  docker ps -a --filter "name=$1" --format '{{.Names}}' | head -n1
}

# Ensure restart policy is unless-stopped (idempotent, cheap, reboot-safe).
ensure_restart_policy() {
  local name="$1"
  [ -n "$name" ] || return 0
  local pol
  pol="$(docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' "$name" 2>/dev/null || echo '')"
  if [ "$pol" != "unless-stopped" ] && [ "$pol" != "always" ]; then
    log "setting restart=unless-stopped on $name (was '${pol:-none}')"
    docker update --restart unless-stopped "$name" >/dev/null 2>&1 || log "docker update failed on $name"
  fi
}

# Consecutive failed-start attempts per container. The count lives in memory
# first and on disk second: disk exists only so a watchdog restart does not
# forget an ongoing loop, so an unwritable state dir must degrade to "works
# until restart" rather than to "never escalates". An escalation mechanism that
# silently does nothing is precisely the failure it was built to prevent.
STATE_WRITE_OK=unknown

flap_var()  { printf 'FLAP_%s' "$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_')"; }
flap_file() { printf '%s/%s.flaps' "$STATE_DIR" "$(printf '%s' "$1" | tr -c 'A-Za-z0-9_.-' '_')"; }

# Never trust the file. Its contents are fed to $(( )) below, and under `set -u`
# an unbound name inside arithmetic exits the shell - so a torn write (OOM, power
# loss, full disk) would put the watchdog itself into a restart loop that no
# restart could clear, leaving the box unmonitored until a human deleted a file.
# Anything that is not all digits is treated as no count at all.
flap_get() {
  local var val disk
  var="$(flap_var "$1")"
  eval "val=\${$var-}"
  if [ -n "$val" ]; then printf '%s' "$val"; return 0; fi
  disk="$(cat "$(flap_file "$1")" 2>/dev/null)"
  case "$disk" in
    ''|*[!0-9]*) printf '0' ;;
    *)           printf '%s' "$disk" ;;
  esac
}

# Memory is authoritative; the file is a best-effort copy written atomically so a
# reader never sees a half-written count.
flap_set() {
  local var f tmp
  var="$(flap_var "$1")"
  eval "$var=\$2"
  f="$(flap_file "$1")"; tmp="$f.tmp.$$"
  if mkdir -p "$STATE_DIR" 2>/dev/null && printf '%s' "$2" > "$tmp" 2>/dev/null && mv -f "$tmp" "$f" 2>/dev/null; then
    if [ "$STATE_WRITE_OK" = "no" ]; then
      log "state dir $STATE_DIR is writable again; flap counts will survive a restart"
    fi
    STATE_WRITE_OK=yes
  else
    rm -f "$tmp" 2>/dev/null
    if [ "$STATE_WRITE_OK" != "no" ]; then
      log "WARNING: cannot write $STATE_DIR - flap counts are in-memory only, so escalation still works but resets if this watchdog restarts"
    fi
    STATE_WRITE_OK=no
  fi
  return 0
}

# Start a container back up if it is not running, and report only what we can
# actually establish. Three outcomes, because two were not enough:
#
#   recovered     it is running NOW and we had been restarting it, so the start held
#   still-broken  it needed starting again, which is a loop rather than a fix
#   cannot-tell   docker could not answer, which is not the same as "it is fine"
#
# `docker start` exiting 0 means the COMMAND was accepted, not that the container
# stayed up. For a container already in 'restarting' docker is cycling it anyway,
# so the call is a no-op that always succeeds. Claiming recovery there is how the
# zallet crash loop stayed invisible: only the NEXT sweep seeing 'running' proves
# anything, so recovery is announced one tick later or not at all.
recover_if_down() {
  local name="$1"
  [ -n "$name" ] || return 0

  local state
  if ! state="$(docker inspect -f '{{.State.Status}}' "$name" 2>/dev/null)" || [ -z "$state" ]; then
    # Could not ask. Absent container and unreachable daemon are different
    # problems and neither is evidence of health, so assert neither.
    log "cannot determine state of $name (docker inspect gave nothing) - asserting nothing"
    return 0
  fi

  local prior
  prior="$(flap_get "$name")"

  if [ "$state" = "running" ]; then
    if [ "$prior" -gt 0 ]; then
      # This is the only place a recovery claim is honest: it is up on a later
      # sweep than the one that started it.
      fixed "$name was down. Started it; running again after $prior restart attempt(s), verified on a later sweep."
      flap_set "$name" 0
    fi
    return 0
  fi

  local n=$((prior + 1))
  flap_set "$name" "$n"
  log "container $name is '$state' - starting it (consecutive attempt $n)"

  if docker start "$name" >/dev/null 2>&1; then
    log "start command accepted for $name; recovery UNCONFIRMED until a later sweep sees it running"
  else
    log "start command failed for $name (state '$state')"
  fi

  # Page on the threshold, then only periodically: an ongoing outage should keep
  # reminding us without becoming the 812-messages-a-night noise it replaces.
  if [ "$n" -eq "$FLAP_ESCALATE" ] || { [ "$n" -gt "$FLAP_ESCALATE" ] && [ $(( (n - FLAP_ESCALATE) % FLAP_REALERT )) -eq 0 ]; }; then
    danger "$name crash loop: $n consecutive restarts (state '$state'), not recovering."
  fi
}

# One string field out of the miner heartbeat, empty if absent or JSON null. grep, not a
# json parser, because the watchdog carries no such dependency and the heartbeat is our
# own flat object, one field per line.
# THE WRITER PUTS A SPACE AFTER THE COLON. The miner renders `"writtenAt": "..."` (pinned
# byte-for-byte by deploy/z3/miner/testdata/heartbeat.canonical.json), and these two
# readers required `"writtenAt":"..."`. Every field read as empty, written_age was empty,
# and heal_miner_if_stalled returned on its first check on every sweep: step 6 had been
# dead since it shipped, including the 2026-08-18 wedge it was written for. The suite hid
# it with compact fixtures the miner never writes; it now writes the real shape.
hb_field() { grep -o "\"$1\":[[:space:]]*\"[^\"]*\"" "$MINER_HEARTBEAT" 2>/dev/null | head -n1 | sed -E 's/^"[^"]*":[[:space:]]*"//; s/"$//'; }
# A numeric field, empty when absent or null. The guard writes nodeLag as a bare integer.
# At least one digit, so a match is a number. A null or absent field comes back empty
# either way; what turns "empty" into a refusal rather than a permissive 0 is the
# `${errs:-unreadable}` at the one call site that gates on it.
hb_num() { grep -o "\"$1\":[[:space:]]*[0-9][0-9]*" "$MINER_HEARTBEAT" 2>/dev/null | head -n1 | sed -E 's/.*:[[:space:]]*//'; }

# Age in seconds of an ISO-8601 Zulu timestamp, or empty if it is absent or will not
# parse. Empty is deliberately different from a large number: "no timestamp" is not
# evidence of staleness, it is absence of evidence, and the caller distinguishes them.
ts_age() {
  local ts="$1" epoch
  [ -n "$ts" ] || { printf ''; return; }
  epoch="$(date -u -d "$ts" +%s 2>/dev/null)" || { printf ''; return; }
  printf '%s' "$(( $(date -u +%s) - epoch ))"
}

# STEP 6: MINER STALL RECOVERY. Narrow, like the poison heal. It acts ONLY on a miner
# that is provably alive (heartbeat fresh) yet not templating (lastTemplateAt stale), so
# it never touches a miner that is merely down - that is Restart=always' job - nor one
# that just (re)started and has not had time to fetch its first template. Capped, so a
# stall it cannot fix (zebra genuinely down, RPC endpoint moved) pages a human instead of
# restart-looping the miner forever.
heal_miner_if_stalled() {
  [ "$MINER_HEAL_ENABLED" = "1" ] || return 0
  # A miner step 7 stopped for a node heal is not stalled, it is stopped. Its last
  # heartbeat stays "fresh" for MINER_HEARTBEAT_FRESH_SECS while lastTemplateAt ages, which
  # is exactly this function's trigger, and it runs before step 7 each sweep: review
  # reproduced it restarting the miner two sweeps after the stop, so the miner mined
  # through the peer-cache drop and the state rewind, which is the 2026-09-07 mechanism.
  [ "$(flap_get "$MINER_STOP_KEY")" != "1" ] || return 0
  [ -f "$MINER_HEARTBEAT" ] || return 0
  local key="$MINER_UNIT" written_age started_age tmpl_age

  written_age="$(ts_age "$(hb_field writtenAt)")"
  # No parseable heartbeat: cannot establish the miner is alive, so assert nothing and
  # leave a dead process to Restart=always.
  [ -n "$written_age" ] || return 0
  [ "$written_age" -le "$MINER_HEARTBEAT_FRESH_SECS" ] || return 0

  # A freshly (re)started miner has not fetched a template yet; restarting it now would
  # thrash exactly the thing a restart just fixed.
  started_age="$(ts_age "$(hb_field startedAt)")"
  [ -z "$started_age" ] || [ "$started_age" -ge "$MINER_START_GRACE_SECS" ] || return 0

  # A miner that says it is WAITING is idle on purpose: its sync guard found the node
  # behind (heartbeat waitingSince set, nodeLag says by how much). Its lastTemplateAt is
  # stale by construction, and restarting it would bounce a process that is doing the one
  # thing that keeps it off a fork. The node itself is step 7's business. Logged once per
  # episode, not per sweep.
  # The writer clears waitingSince on any RPC error, so a wedged connection cannot wear the
  # waiting label; consecutiveErrors is checked here too, so an older writer cannot either.
  local waiting_since errs; waiting_since="$(hb_field waitingSince)"; errs="$(hb_num consecutiveErrors)"
  if [ -n "$waiting_since" ] && [ "${errs:-unreadable}" = "0" ]; then
    if [ "$miner_waiting_logged" = "0" ]; then
      local lagn; lagn="$(hb_num nodeLag)"
      log "miner is waiting for the node (${lagn:-?} blocks behind); not a stall, leaving it alone"
      miner_waiting_logged=1
    fi
    return 0
  fi
  miner_waiting_logged=0

  # lastTemplateAt absent/null counts as "never templated", which past the start grace is
  # itself a stall.
  tmpl_age="$(ts_age "$(hb_field lastTemplateAt)")"
  if [ -n "$tmpl_age" ] && [ "$tmpl_age" -lt "$MINER_STALL_SECS" ]; then
    # Templating normally. Clear any prior stall count so the next episode gets a full
    # budget, the same way a READY faucet resets the poison heal.
    local prior; prior="$(flap_get "$key")"
    if [ "$prior" != "0" ]; then
      flap_set "$key" 0
      log "miner templating again (last ${tmpl_age}s ago); stall count reset"
      fixed "miner stalled (alive, no block template). Restarted it ($prior restart(s)). Mining again, template ${tmpl_age}s ago."
    fi
    return 0
  fi

  local n; n=$(( $(flap_get "$key") + 1 )); flap_set "$key" "$n"
  if [ "$n" -le "$MINER_HEAL_MAX" ]; then
    log "miner stalled: alive (heartbeat ${written_age}s old) but no block template for ${tmpl_age:-never}s; restarting $MINER_UNIT ($n/$MINER_HEAL_MAX)"
    if systemctl restart "$MINER_UNIT" >/dev/null 2>&1; then
      log "restart issued for $MINER_UNIT ($n/$MINER_HEAL_MAX); report follows once it templates again"
    else
      danger "miner stalled and 'systemctl restart $MINER_UNIT' FAILED ($n/$MINER_HEAL_MAX)."
    fi
  elif [ "$n" -eq "$((MINER_HEAL_MAX + 1))" ]; then
    danger "miner still stalled after $MINER_HEAL_MAX restarts. Not retrying. Zebra down, or its RPC endpoint moved?"
  fi
}

# "<blocks> <estimatedheight>" straight from zebra's own JSON-RPC, or nothing if it will
# not answer. Read from the node rather than the faucet app, because the watchdog often
# cannot reach the app at all (it publishes no host port), and the app is itself gated on
# the node, so asking it about the node is circular. No jq: two integers out of a flat
# reply with sed. A missing estimate is not evidence we are behind, so it collapses to
# "at the tip" and the caller does nothing.
zebra_chain_heights() {
  local name="$1" out blocks est
  [ -n "$name" ] || return 0
  out="$(docker exec "$name" sh -lc 'CK=$(cat /run/auth/.cookie 2>/dev/null || cat /var/run/auth/.cookie 2>/dev/null); curl -s --max-time 10 -u "$CK" --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"watchdog\",\"method\":\"getblockchaininfo\",\"params\":[]}" -H content-type:text/plain http://127.0.0.1:18232/' 2>/dev/null)" || return 0
  blocks="$(printf '%s' "$out" | sed -n 's/.*"blocks":\([0-9][0-9]*\).*/\1/p' | head -n1)"
  est="$(printf '%s' "$out" | sed -n 's/.*"estimatedheight":\([0-9][0-9]*\).*/\1/p' | head -n1)"
  case "$blocks" in ''|*[!0-9]*) return 0 ;; esac
  case "$est" in ''|*[!0-9]*) est="$blocks" ;; esac
  printf '%s %s' "$blocks" "$est"
}

# STEP 7: NODE SYNC-STALL RECOVERY. Two facts together, because either alone lies. A node
# AT the tip also stops advancing between blocks (testnet spacing is minutes), so "tip not
# moving" on its own would bounce a healthy idle node. And a node that is behind but still
# advancing is catching up by itself, so "behind" on its own would restart the one thing a
# restart can only slow down. Only behind AND stuck, for NODE_STALL_SECS, is a real wedge.
#
# "Advancing" is judged against the PREVIOUS sweep, not against where it was before a
# heal. A restart drops the non-finalized tip by up to ~100 blocks, and if that drop
# counted as movement the budget would reset on every restart and this would bounce zebra
# forever without ever escalating. Only a height higher than last sweep's is progress.
#
# ESCALATES, then GIVES UP. A plain restart re-rolls the peer set and usually clears it.
# If it stalls again, the later heals also drop the stale peer cache before restarting,
# which is the manual fix that actually worked on 2026-09-07. After NODE_HEAL_MAX it pages
# instead of restart-looping, because by then zebra is not the thing that is wrong.
#
# If the RPC will not answer, that is a different failure (steps 1-2 and the pager), not
# evidence of a stall, so this asserts nothing.
# Starts a miner that a node heal stopped, once the node is fit again. Sets
# MINER_RELEASE_NOTE (the sentence for the report) on success and empties it otherwise. A
# variable rather than printed output: called through $(...), its journal line would land
# inside the report and its "already paged" flag would die with the subshell. A start
# that FAILS keeps the flag, so the next sweep tries again, and pages once per episode
# rather than once ever: the unit was stopped, so Restart=always will not bring it back
# and this is the only thing that will.
alerted_miner_start_failed=0
MINER_RELEASE_NOTE=""
release_miner_after_heal() {
  MINER_RELEASE_NOTE=""
  [ "$(flap_get "$MINER_STOP_KEY")" = "1" ] || return 0
  if systemctl start "$MINER_UNIT" >/dev/null 2>&1; then
    flap_set "$MINER_STOP_KEY" 0
    alerted_miner_start_failed=0
    log "started $MINER_UNIT again after the node heal"
    MINER_RELEASE_NOTE=" The miner was stopped for the heal and its unit is started again; its heartbeat confirms within a minute."
    return 0
  fi
  log "WARNING: could not start $MINER_UNIT after the node heal; will retry next sweep"
  if [ "$alerted_miner_start_failed" = "0" ]; then
    # Not a footnote on a ✅: a miner that will not start is its own page.
    danger "the node has recovered but 'systemctl start $MINER_UNIT' FAILED. The miner was stopped for the heal and is still stopped; the watchdog retries every sweep, or start it by hand."
    alerted_miner_start_failed=1
  fi
  return 0
}

heal_node_if_stalled() {
  if [ "$NODE_HEAL_ENABLED" != "1" ]; then
    # Switched off mid-episode (an operator about to reimport a snapshot does exactly
    # this). The only `systemctl start` for a miner stopped by a heal lives below, so
    # without this the miner stays stopped for ever with the panel reading a calm "off".
    if [ "$(flap_get "$MINER_STOP_KEY")" = "1" ]; then
      # Through the same helper as every other release: the flag clears only on a start
      # that succeeded, a failure retries next sweep and pages once, and the "already
      # paged" flag resets on success, so a later episode's failure can page again.
      release_miner_after_heal
      [ -n "$MINER_RELEASE_NOTE" ] && log "node heal is disabled; started $MINER_UNIT, which a heal had stopped, so it is not left parked by accident (its own sync guard applies)"
    fi
    return 0
  fi
  local name="$1"
  [ -n "$name" ] || return 0

  local heights blocks est prev now lag
  heights="$(zebra_chain_heights "$name")"
  [ -n "$heights" ] || return 0
  blocks="${heights%% *}"; est="${heights##* }"
  prev="$node_last_height"; node_last_height="$blocks"
  now="$(date -u +%s)"
  lag=$(( est - blocks )); [ "$lag" -lt 0 ] && lag=0

  # Higher than last sweep: syncing, or at the tip and a block just landed. Healthy, so
  # clear every bit of stall state and the next episode gets a full budget.
  if [ "$blocks" -gt "$prev" ]; then
    # The miner comes back FIRST, so the report can say it did. Its own sync guard keeps
    # it idle until the node is within MINER_MAX_LAG, so starting it here is safe even
    # while the node is still catching up. Not on the very first sweep (prev=0 makes any
    # height "advancing"): a watchdog restarted mid-episode must see the tip move once
    # before it un-stops a miner it stopped for a node that may still be stuck.
    local miner_note=""
    if [ "$prev" -gt 0 ]; then release_miner_after_heal; miner_note="$MINER_RELEASE_NOTE"; fi
    if [ "$node_heal_attempts" != "0" ]; then
      # The one report, and only now: the tip has been SEEN to move after we acted.
      log "zebra tip advancing again (height $blocks, ${lag} behind); node-stall state cleared"
      fixed "zebra was ${node_stall_lag} blocks behind and stuck. ${node_heal_what} after $node_heal_attempts attempt(s). Syncing again, ${lag} behind now.${miner_note}"
    elif [ -n "$miner_note" ]; then
      # This process did not do the healing (it was restarted mid-episode) but it found the
      # flag and the tip moving, so the miner's return is still reported, once.
      log "zebra tip advancing again (height $blocks); a previous watchdog had stopped the miner for a heal"
      fixed "zebra is syncing again after a node heal that a previous watchdog started (${lag} behind now).${miner_note}"
    elif [ "$node_stall_since" != "0" ]; then
      log "zebra tip advancing again (height $blocks, ${lag} behind); stall clock cleared"
    fi
    node_stall_since=0; node_heal_attempts=0; alerted_node_giveup=0; node_heal_what=""; node_stall_lag=0
    return 0
  fi

  # Not higher, but essentially at the tip: normal idle between blocks, not a stall.
  # AND the place to release a miner a heal stopped when the height never strictly
  # advanced across a sweep: a snapshot reimport, or a node that came back already at its
  # tip. Review found the flag stuck for ever here, with step 6 disabled by it and the
  # panel reading a calm "off". At the tip is exactly when mining is safe.
  if [ "$lag" -le "$NODE_LAG_LIMIT" ]; then
    node_stall_since=0
    if [ "$prev" -gt 0 ] && [ "$(flap_get "$MINER_STOP_KEY")" = "1" ]; then
      release_miner_after_heal
      [ -n "$MINER_RELEASE_NOTE" ] && fixed "zebra is at the tip again after a node heal (${lag} behind).${MINER_RELEASE_NOTE}"
      # At the tip IS the end of the episode, so the budget and the one-page-per-episode
      # flags reset here exactly as they do when the height advances; left set, a later
      # advancing sweep would report the same heal twice and the next stall would start
      # with no budget and no page.
      node_heal_attempts=0; alerted_node_giveup=0; node_heal_what=""; node_stall_lag=0
    fi
    return 0
  fi

  # Behind and not moving. Start the stall clock, or keep it running.
  [ "$node_stall_since" = "0" ] && node_stall_since="$now"
  local stalled_for=$(( now - node_stall_since ))
  [ "$stalled_for" -ge "$NODE_STALL_SECS" ] || return 0

  local n=$(( node_heal_attempts + 1 ))
  if [ "$n" -gt "$NODE_HEAL_MAX" ]; then
    if [ "$alerted_node_giveup" = "0" ]; then
      local miner_note=""
      [ "$(flap_get "$MINER_STOP_KEY")" = "1" ] && miner_note=" The miner is left STOPPED until the node is fixed: systemctl start $MINER_UNIT afterwards."
      danger "zebra still ${lag} blocks behind after $NODE_HEAL_MAX tries (restart, clear peers, drop fork state). Likely a fork past the finalized tip: compare getblockhash with an explorer and reimport a snapshot (SNAPSHOTS.md).${miner_note}"
      alerted_node_giveup=1
    fi
    return 0
  fi
  node_heal_attempts="$n"
  [ "$node_stall_lag" = "0" ] && node_stall_lag="$lag"

  # Stop the miner for the episode, once, and only if it is running. Every heal below
  # moves the node's tip backwards (a restart drops the non-finalized tip, a state drop
  # rewinds ~100 blocks); a miner submitting through that extends whatever it was on.
  if [ "$NODE_STOPS_MINER" != "1" ]; then
    log "not stopping $MINER_UNIT for this heal (WATCHDOG_NODE_STOPS_MINER=$NODE_STOPS_MINER); its own sync guard is the only protection"
  elif [ "$(flap_get "$MINER_STOP_KEY")" != "1" ] && systemctl is-active --quiet "$MINER_UNIT" 2>/dev/null; then
    if systemctl stop "$MINER_UNIT" >/dev/null 2>&1; then
      flap_set "$MINER_STOP_KEY" 1
      # Step 6 may have restarted the miner before this (a wedged node wedges the miner's
      # socket too). Its count would survive the episode and, once the miner templates
      # again after OUR start, credit step 6 with a FIXED for a heal it did not do.
      flap_set "$MINER_UNIT" 0
      log "stopped $MINER_UNIT for the node heal; it is started again once the tip moves"
    else
      log "WARNING: could not stop $MINER_UNIT before healing the node; its own sync guard is the remaining protection"
    fi
  fi

  if [ "$n" -ge "$NODE_CLEAR_CACHE_AFTER" ]; then
    # Both live on the chain volume: the peer cache at network/<net>.peers, and the
    # non-finalized state backup at non_finalized_state/. Stop FIRST: zebra rewrites both
    # on shutdown, so a delete before the stop is undone by the stop.
    local mp what
    mp="$(docker volume inspect "$ZEBRA_CHAIN_VOLUME" -f '{{.Mountpoint}}' 2>/dev/null || echo '')"
    log "zebra stalled ${stalled_for}s at height $blocks (${lag} behind); clearing state ($n/$NODE_HEAL_MAX)"
    docker stop "$name" >/dev/null 2>&1
    if [ -n "$mp" ]; then
      rm -f "$mp"/network/*.peers 2>/dev/null
      what="cleared the peer cache"
      if [ "$n" -ge "$NODE_DROP_NONFINAL_AFTER" ]; then
        # The last resort short of a human. The non-finalized backup is the last ~100
        # blocks and zebra restores it on every boot, so a wedged or forked tip inside it
        # comes straight back with every restart: on 2026-09-07 six plain restarts moved
        # the tip by nothing. Dropping it rewinds to the finalized tip, which is canonical
        # and never more than ~100 blocks back, and re-syncs forward. No keys live here;
        # zebra holds none. This is what finally cleared it that day.
        rm -rf "$mp/non_finalized_state" 2>/dev/null
        what="cleared the peer cache and dropped the non-finalized state"
      fi
    else
      log "WARNING: cannot find volume $ZEBRA_CHAIN_VOLUME; restarting without clearing anything"
      what="could not find the chain volume, so only restarted"
    fi
    docker start "$name" >/dev/null 2>&1
    node_heal_what="${what^} and restarted it"
    log "$what, restarting ($n/$NODE_HEAL_MAX); report follows once the tip moves"
  else
    log "zebra stalled ${stalled_for}s at height $blocks (${lag} behind); restarting ($n/$NODE_HEAL_MAX); report follows once the tip moves"
    docker restart "$name" >/dev/null 2>&1
    node_heal_what="Restarted it"
  fi
  # Give the restart room to reconnect and pull a burst before it is judged again.
  node_stall_since=0
}

faucet_misses=0
faucet_restarts=0   # consecutive restarts with no healthy sweep in between
unready_since=0
alerted_unready=0

# An unrecognized format still sends (a watchdog that dies on a config typo
# is worse than one that guesses), but say so, or a typo means alerts go out
# in a shape the channel rejects and nobody hears anything.
case "$ALERT_FORMAT" in
  slack|discord) : ;;
  *) log "WARNING: unknown WATCHDOG_ALERT_FORMAT '$ALERT_FORMAT', sending the slack shape (valid: slack, discord)" ;;
esac

log "starting: interval=${INTERVAL}s faucet=${FAUCET_URL} ready_grace=${READY_GRACE_SECS}s alert=${ALERT_URL:-none} format=${ALERT_FORMAT}"

ticks=0
while true; do
  ticks=$((ticks + 1))
  zebra="$(find_container "$ZEBRA_MATCH")"
  zallet="$(find_container "$ZALLET_MATCH")"
  faucet="$(find_container "$FAUCET_MATCH")"

  # 1 + 2: keep restart policy set and bring back anything that fell over.
  for c in "$zebra" "$zallet" "$faucet"; do
    ensure_restart_policy "$c"
    recover_if_down "$c"
  done

  # 3: web-app liveness. Only restart when the container claims to be running
  # but /api/health has stopped answering - a genuine hang, not a cold start.
  if [ -n "$faucet" ] && [ "$(docker inspect -f '{{.State.Status}}' "$faucet" 2>/dev/null)" = "running" ]; then
    if curl -fsS --max-time 5 "$FAUCET_URL/api/health" >/dev/null 2>&1; then
      # The one report, and only now: it has been SEEN answering again after a restart.
      if [ "$faucet_restarts" -gt 0 ]; then
        fixed "faucet app hung. Restarted it ($faucet_restarts time(s)); answering again."
      fi
      faucet_misses=0; faucet_restarts=0
    else
      faucet_misses=$((faucet_misses + 1))
      log "faucet liveness miss $faucet_misses/$FAUCET_FAIL_LIMIT"
      if [ "$faucet_misses" -ge "$FAUCET_FAIL_LIMIT" ]; then
        faucet_restarts=$((faucet_restarts + 1))
        log "restarting hung $faucet (restart $faucet_restarts this episode); report follows once it answers"
        docker restart "$faucet" >/dev/null 2>&1 || log "docker restart failed for $faucet"
        faucet_misses=0
        # A second restart with no healthy sweep in between is a loop, not a fix: page once
        # there, then only periodically, the same shape as the container crash-loop page.
        if [ "$faucet_restarts" -eq 2 ] || { [ "$faucet_restarts" -gt 2 ] && [ $(( (faucet_restarts - 2) % 20 )) -eq 0 ]; }; then
          danger "faucet app not answering /api/health after $faucet_restarts restart(s). Not recovering."
        fi
      fi
    fi
  fi

  # 4: readiness alerting. Not-ready is normal during first sync / refill, so we
  # only page when it persists past the grace window, and only once per episode.
  now="$(date -u +%s)"
  # ONE fetch, and both the verdict and the reason come out of it. This used to probe
  # and then re-fetch for the reason, which spent two sequential 8s budgets against the
  # same endpoint: when readiness was slow the second fetch timed out too, so the page
  # read "reason: unknown" precisely when a reason would have been most useful, and it
  # doubled the load on an endpoint already established as slow (#229).
  #
  # -sS not -fsS, because a 503 body carries the reason and -f discards it. The status
  # comes from -w instead, so a non-2xx is still recognised as not-ready.
  ready_body="$(curl -sS --max-time 8 -w '\n%{http_code}' "$FAUCET_URL/api/ready" 2>/dev/null)"
  ready_rc=$?
  ready_code="${ready_body##*$'\n'}"
  reason="$(printf '%s' "$ready_body" | grep -o '"reason":"[^"]*"' | head -n1 | cut -d'"' -f4)"
  # A transport failure is not an answer. Say so, rather than reporting an empty reason
  # that reads as though the app declined to explain itself.
  if [ "$ready_rc" -ne 0 ]; then reason="no answer from /api/ready (curl $ready_rc)"; fi
  case "$ready_code" in 2*) ready_ok=1 ;; *) ready_ok=0 ;; esac
  if [ "$ready_rc" -eq 0 ] && [ "$ready_ok" = "1" ]; then
    if [ "$alerted_unready" = "1" ]; then fixed "faucet is READY again."; fi
    unready_since=0
    alerted_unready=0
  else
    [ "$unready_since" = "0" ] && unready_since="$now"
    elapsed=$((now - unready_since))
    if [ "$elapsed" -ge "$READY_GRACE_SECS" ] && [ "$alerted_unready" = "0" ]; then
      danger "faucet NOT READY for $((elapsed / 60)) min. Reason: ${reason:-unknown}."
      alerted_unready=1
    fi
  fi

  # 5: POISON AUTO-HEAL. The one thing steps 1-4 could not do, and the reason
  # 2026-08-17 was a ten-hour outage instead of a five-minute one.
  #
  # zallet stores the transaction ids it wants data for. When one expired unmined and
  # zebra has since dropped it, the answer is `-5 No such mempool or main chain
  # transaction`; zaino calls that unrecoverable rather than not-found, and zallet
  # exits. Step 2 then restarts it into the identical death, forever, because the input
  # that kills it is STORED STATE. 162 restarts, and every one of them looked like a
  # successful self-heal.
  #
  # So restarting is not enough here: the poison has to be cleared. That is what the
  # deploy/z3/zallet-*.sh tools do, and this runs them.
  #
  # NARROW ON PURPOSE. It fires only when zallet's OWN log carries that exact -5
  # signature. Anything else - a hung node, a full disk, a genuine zebra outage - is left
  # to steps 1-4 and the pager, because a watchdog that reaches for a database repair
  # whenever something looks wrong is worse than one that does nothing.
  #
  # JUDGED FROM ZALLET'S LOG, NOT THE APP'S READINESS. This used to also gate on /api/ready
  # saying "cannot read the wallet", but the watchdog often cannot reach the app at all
  # (the faucet container publishes no host port), so that probe answers "no answer" every
  # sweep. Worse, it meant the reset below - which only ran when the app went READY - never
  # ran, so the budget never came back and the heal gave up PERMANENTLY after two uses.
  # 2026-08-18: it healed twice, could not (with the old tool) clear the poison, gave up,
  # and stayed given-up. The -5 line in zallet's log is the direct, reachable evidence; its
  # ABSENCE while zallet runs is what proves a heal worked.
  #
  # IT ALWAYS REPORTS, once the heal is seen to work, and pages when it does not. A silent
  # self-heal is how 812 restarts went unnoticed once already; a heal that fixed something
  # is exactly what an operator needs to know, and repeated reports are the signal that
  # the tap upstream is leaking. The attempts themselves are journal lines, not messages.
  #
  # AND IT GIVES UP. After HEAL_MAX_ATTEMPTS it stops and pages instead of rewriting
  # wallet.db on a loop: at that point the diagnosis is wrong and thrashing the database
  # is the more dangerous of the two options. The budget comes back once zallet is running
  # and its log is clean, so a later, unrelated episode still gets a full budget.
  if [ -n "$zallet" ] && [ "$HEAL_ENABLED" = "1" ]; then
    if docker logs --tail 40 "$zallet" 2>&1 | grep -q "No such mempool or main chain transaction"; then
      if [ "$heal_attempts" -ge "$HEAL_MAX_ATTEMPTS" ]; then
        if [ "$alerted_heal_giveup" = "0" ]; then
          danger "zallet poison persists after $heal_attempts repairs. Not retrying. Reason: ${reason:-unknown}."
          alerted_heal_giveup=1
        fi
      else
        heal_attempts=$((heal_attempts + 1))
        log "zallet poison signature detected; running repair $heal_attempts/$HEAL_MAX_ATTEMPTS"
        # Stopped first, or sqlite and the wallet fight over the file. `docker stop`
        # beats the restart policy: it marks the container stopped, so step 2's
        # recover_if_down is what deliberately brings it back afterwards.
        docker stop "$zallet" >/dev/null 2>&1
        heal_out=""
        for tool in zallet-abandon-expired-txs.sh zallet-drop-unfetchable-queue.sh; do
          if [ -x "$HEAL_TOOLS_DIR/$tool" ] || [ -f "$HEAL_TOOLS_DIR/$tool" ]; then
            heal_out="$heal_out $(bash "$HEAL_TOOLS_DIR/$tool" 2>&1 | tail -3 | tr '\n' ' ')"
          else
            log "WARNING: $HEAL_TOOLS_DIR/$tool missing, cannot heal"
          fi
        done
        docker start "$zallet" >/dev/null 2>&1
        log "ran the repair tools (attempt $heal_attempts/$HEAL_MAX_ATTEMPTS) and restarted zallet; report follows once it runs clean.${heal_out}"
      fi
    elif [ "$heal_attempts" -ne 0 ] || [ "$alerted_heal_giveup" != "0" ]; then
      # No -5 in the recent log. If zallet is actually up, the poison is gone (a heal
      # worked, or there was never one): reset the budget, keyed off zallet being up and
      # clean rather than the app-readiness probe the watchdog cannot reach.
      if [ "$(docker inspect -f '{{.State.Status}}' "$zallet" 2>/dev/null)" = "running" ]; then
        # The one report, now that it is SEEN running clean after we acted.
        [ "$heal_attempts" -ne 0 ] && fixed "zallet crash-looped on dropped-transaction poison. Ran the repair tools ($heal_attempts attempt(s)). Running clean."
        heal_attempts=0
        alerted_heal_giveup=0
        log "zallet running and clean of the poison signature; heal budget reset"
      fi
    fi
  fi

  # 6: miner stall recovery. Independent of the faucet's readiness - the miner funds the
  # reserve but a stalled miner does not gate drips, so this runs every sweep on its own
  # signal (the heartbeat) rather than off /api/ready.
  heal_miner_if_stalled

  # 7: node sync-stall recovery. Reads zebra directly, so it is independent of whether the
  # watchdog can reach the app, and acts only on behind-AND-stuck.
  heal_node_if_stalled "$zebra"

  # Bounded only under test. Production leaves MAX_TICKS at 0 and never exits,
  # and the sleep is skipped on the final tick so a suite is not paying for it.
  if [ "$MAX_TICKS" -gt 0 ] && [ "$ticks" -ge "$MAX_TICKS" ]; then
    break
  fi
  sleep "$INTERVAL"
done

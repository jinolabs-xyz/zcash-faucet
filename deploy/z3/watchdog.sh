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
# A FLAPPING FAUCET NEVER REACHES THE GRACE ABOVE, and that is not a tuning problem. The grace
# measures ONE UNBROKEN episode: unready_since is zeroed by any good read, so a faucet that answers
# 503 on one sweep in three resets the clock every ninety seconds against a threshold of 1800 and
# can never page, for ever. Measured on prod 2026-09-19: the node block came back null on 3 of 6
# reads - a small sample, given as the count it is - including while the wallet was caught up.
# Readiness answers "node status unknown" for exactly that, so those were 503s to visitors that
# had recovered by the next read, and nothing told anyone: it took a hand-read to find.
# So the SECOND question is asked separately - not "how long has it been down" but "how much of
# this window was it down" - because a good read cannot reset a count the way it resets a clock.
READY_FLAP_WINDOW_SECS="${WATCHDOG_READY_FLAP_WINDOW_SECS:-1800}"
# Too few sweeps is not a sample. At the default 30s interval a full window is 60 of them.
READY_FLAP_MIN_SWEEPS="${WATCHDOG_READY_FLAP_MIN_SWEEPS:-20}"
# Percent of the window that must be un-ready. A faucet refusing a quarter of the time is refusing
# a quarter of its visitors, which is an outage wearing a distribution.
READY_FLAP_PCT="${WATCHDOG_READY_FLAP_PCT:-25}"
# SENDS FAILING gets one self-heal (risk register II, R-18): a wallet that answers
# balances and refuses every send is the zallet shape a restart has fixed every time so
# far. The verdict is in-memory and ages out with its window (15 min from the older
# failure), and while it holds no new send can land to refresh it, so the 30-minute
# readiness page above CANNOT fire on this reason alone: the verdict is gone before
# the grace is up. This restart is the reaction; the reason is visible on /api/status
# and to live-smoke meanwhile. Three minutes of it, not ten, or two failures would
# have to land within five minutes of each other for this to ever run.
SENDS_RESTART_AFTER="${WATCHDOG_SENDS_RESTART_AFTER:-180}"    # 3 min of sends failing
SENDS_RESTART_BUDGET="${WATCHDOG_SENDS_RESTART_BUDGET:-3600}" # one zallet restart per hour
ALERT_URL="${WATCHDOG_ALERT_URL:-}"                 # optional webhook for alerts
ALERT_FORMAT="${WATCHDOG_ALERT_FORMAT:-slack}"      # slack (default) or discord

# Crash-loop escalation. A container that needs starting again and again is not
# being recovered, it is looping, and the old code could not tell the difference:
# it announced "recovered" on every attempt, so 812 consecutive failures over 16
# hours looked exactly like 812 successful self-heals and nobody was ever paged.
# Counts live on disk so a watchdog restart does not reset the evidence.
FLAP_ESCALATE="${WATCHDOG_FLAP_ESCALATE:-3}"        # consecutive attempts before we page
FLAP_REALERT="${WATCHDOG_FLAP_REALERT:-60}"         # then re-page every N attempts
# UP IS NOT RECOVERED (risk register II, R-13). A container that starts, runs forty
# seconds and dies is seen "running" on every other sweep. One sighting used to reset
# the count and send a FIXED, so a slow crash loop produced a green tick per minute and
# never the three consecutive misses that page: the 812-restarts night with a slightly
# slower crash. Recovery now needs the container to have been up for this long, read
# from docker's own StartedAt; a young "running" keeps the count and says nothing.
RECOVERY_MIN_UPTIME="${WATCHDOG_RECOVERY_MIN_UPTIME:-$(( INTERVAL * 3 ))}"
STATE_DIR="${WATCHDOG_STATE_DIR:-/run/faucet-watchdog}"

# THE FORK PARK MARKER, and it is PERSISTENT where STATE_DIR is not (R-12).
#
# STATE_DIR is /run on purpose: flap counts describe the last few minutes and a reboot is
# a fair reason to forget them. A PARKING DECISION is the opposite. A reboot does not
# resolve a fork, so a marker that vanished across one would let the next auto-deploy tick
# start a miner straight back onto a private chain - which is the 2026-09-15 sequence, in
# which a deploy un-parked a miner the owner had stopped and the box mined its own fork
# until Zallet rewound 18,434 blocks.
#
# Written by this script, read by auto-deploy.sh, CLEARED ONLY BY A HUMAN. The watchdog
# never parks the miner itself: step 7 may stop it for the duration of a node heal, and
# whether it STAYS stopped is the owner's, which is exactly what a marker a human clears
# expresses and a process that starts it again does not. OPERATIONS.md carries the clear.
#
# mkdir -p rather than StateDirectory= in the unit, deliberately: changing the unit file
# would need the unit restarted before it took effect, and install-ops.sh restarts the
# watchdog on a watchdog.sh change rather than a unit change (review of #553 found that
# same gap on the cTAZ socket). A directory this script makes itself has no such gap.
FORK_PARK_DIR="${WATCHDOG_FORK_PARK_DIR:-/var/lib/faucet-watchdog}"
FORK_PARK_MARKER="$FORK_PARK_DIR/miner-parked-by-fork-heal"

# THE AHEAD RUNG'S BOUNDS (R-12). Step 7 handles a node the network has left BEHIND. This
# is the other shape: our node higher than every independent reference, which is what a
# private chain looks like from the inside. A couple of blocks ahead is ordinary for a node
# that mines and /api/ready says so in words; 150 is far past anything ordinary explains.
#
# CORROBORATION IS REQUIRED AND `null` IS NOT CORROBORATION. One reference cannot tell our
# fork from its own bad answer, and two that disagree cannot either. Both are cannot-tell,
# and cannot-tell pages nothing and touches nothing - a rung that acts on one flaky oracle
# converts an oracle outage into a chain rewind.
#
# IT DROPS NOTHING, and that is a ruling rather than an omission (CTO, 2026-09-15, on my
# disagreement with the first design). Dropping the non-finalized state reaches the last
# ~100 blocks, so at 150 ahead the rung would delete the top of our own chain, come back
# still ~50 blocks ahead on the same fork, and log a heal it did not perform. A fork this
# deep needs a snapshot reimport, which is a human's call; what the rung automates is the
# part that failed on 2026-09-15 - the miner not coming back on its own.
FORK_HEAL_ENABLED="${WATCHDOG_FORK_HEAL_ENABLED:-1}"
FORK_AHEAD_BLOCKS="${WATCHDOG_FORK_AHEAD_BLOCKS:-150}"   # ahead of the highest corroborated reference
FORK_MINER_MIN_SECS="${WATCHDOG_FORK_MINER_MIN_SECS:-600}" # miner alive this long = it could have built this
alerted_fork=0
# THE POISON SIGNATURE, IN ONE PLACE. Both wordings: the wallet changed its words once (#601) and
# the detector did not, so a second spelling now lives beside the first rather than being copied to
# whichever rung notices next. Two readers use it - the fatal classification that heals, and the
# quiet retry counter - and they must not be able to drift apart. NOT a bare `code: -5`: other -5s
# are ordinary (an unknown address, a bad txid) and healing on those rewrites wallet.db for a typo.
ZALLET_POISON_RE='No such mempool or main chain transaction|[Tt]ransaction not found in mempool or best chain'
fork_cannot_tell_logged=0   # the cannot-tell line is a state, said once, and re-armed when it ends
alerted_history_fork=0
history_cannot_tell_logged=0   # same shape: a missing reference is a STATE, not a per-sweep event

# Poison auto-heal (step 5). Restarting zallet cannot fix a crash whose cause is a row
# in wallet.db, so the watchdog runs the repair tools when it sees that exact signature.
# Off by setting HEAL_ENABLED=0, and capped so a wrong diagnosis cannot rewrite the
# wallet on a loop - after the cap it pages instead of retrying.
HEAL_ENABLED="${WATCHDOG_HEAL_ENABLED:-1}"
HEAL_MAX_ATTEMPTS="${WATCHDOG_HEAL_MAX_ATTEMPTS:-2}"
HEAL_TOOLS_DIR="${WATCHDOG_HEAL_TOOLS_DIR:-$(dirname "$0")}"
# #601 step 4. The window is a docker logs --since value; the floor is "more than one block's
# worth", since the observed shape is three retries per block and a single block's worth could be
# one transient fetch. Both are knobs so a case can drive them without waiting ten minutes.
RETRY_WINDOW="${WATCHDOG_RETRY_WINDOW:-10m}"
RETRY_MIN="${WATCHDOG_RETRY_MIN:-6}"
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
# THE OUTCOME RUNG (#660). Every other miner check asks whether it is ALIVE or KEEPING UP. None
# asks whether it is ACCOMPLISHING anything, which is how a miner that templated every few seconds
# and completed nothing for hours read as healthy on four instruments at once.
MINER_OUTCOME_ENABLED="${WATCHDOG_MINER_OUTCOME_ENABLED:-1}"
# NO BLOCK-INTERVAL CONSTANT. This rung shipped with MINER_BLOCK_SECS=75, the testnet TARGET, and
# that was a defect: measured on the box the interval was 12.8s, so a HEALTHY miner - one abandon per
# tip change - computed 5.86 against a threshold of 5 and would have been paged. The target is not
# the rate, the rate moves, and a fresher constant would be the same mistake with a newer number.
# The heartbeat already carries lastTemplateHeight, so the blocks in the window are COUNTED.
# Abandons per block-interval before the RATE is anomalous rather than unlucky. Healthy is ~1.
# Five is far from healthy and far below what a wedged miner produces, so the gap does the work
# rather than the precision of the number.
MINER_ABANDON_PER_BLOCK="${WATCHDOG_MINER_ABANDON_PER_BLOCK:-5}"
# HOURS, NOT MINUTES, and this is the number that decides whether the rung cries wolf. Solves run
# about twice a day, so silence is ORDINARY: against a Poisson mean of 2/day a quiet 12 hours is
# ~37% likely and a quiet 24 hours ~13%. A rung that fired on silence alone would be wrong most
# weeks and would be switched off, which is worse than not having it.
MINER_NO_SOLVE_SECS="${WATCHDOG_MINER_NO_SOLVE_SECS:-21600}"
# THE RATE IS MEASURED OVER A WINDOW rather than divided by uptime, so this is how long a window
# has to be before it is worth dividing by. abandonedCount is a LIFETIME counter - heartbeat.rs
# resume() restores it across restarts - so uptime is the wrong denominator for it.
MINER_RATE_WINDOW_SECS="${WATCHDOG_MINER_RATE_WINDOW_SECS:-600}"
MINER_OUTCOME_KEY="miner-completing-nothing"
# TWO NUMERIC KEYS, NOT ONE COMPOUND VALUE. flap_get is a COUNT store by contract: its value
# feeds $(( )), so it sanitises anything that is not all digits to 0. A baseline written as
# "6190:900" reads back as 0 the moment it crosses a process boundary, which made the very
# first sweep compute the whole lifetime total over the whole clock and page instantly. Kept
# numeric so the helper's hardening still applies.
MINER_ABANDON_N_KEY="miner-abandon-count"
MINER_ABANDON_T_KEY="miner-abandon-at"
MINER_ABANDON_H_KEY="miner-abandon-height"
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
# 100, NOT 50, AND THE MINER'S NUMBER FOR THE MINER'S REASON. The lag here is zebra's own
# `estimatedheight` minus `blocks`, a CLOCK extrapolation from the tip's timestamp, not a
# measurement of any other node. Testnet goes an hour without a block; a 62-minute gap
# reads as ~50 "behind" with nobody ahead at all. At 50 the harness showed this heal
# restarting a node at the tip, wiping its peers, dropping its state and parking the one
# miner that would have ended the lull, then paging for a snapshot reimport. The miner's
# guard reads the same two fields and documents why it chose 100 (miner/src/sync.rs);
# the repo suite holds the two defaults equal so they cannot drift apart again.
NODE_LAG_LIMIT="${WATCHDOG_NODE_LAG_LIMIT:-100}"                # blocks behind ZEBRA'S OWN ESTIMATE before a stuck tip counts as a stall
# A LIMIT OF ITS OWN FOR THE NUMBER THAT CAN BE TRUSTED, and the first cut of the 20:35Z fix
# did not have one: it gated the corroborated tip on NODE_LAG_LIMIT too, so the episode this
# rung exists for - 58 blocks behind a corroborated tip, nine minutes, testnet at 6.4 blocks a
# minute - never started the stall clock, and the fix "worked" only against the suite's own
# 150-block case. Measured by the CTO's red-team on #568 before it shipped.
#
# WHY 25. This is a NOISE floor, not a timer: nothing on this rung fires until the tip has
# ALSO been unmoved for NODE_STALL_SECS, so the wait is already five minutes whatever this
# number is. What it has to clear is the gap the app itself calls agreement - TIP_AGREE_BLOCKS
# is 20 in src/lib/zcash/externalTip.ts, and two references inside 20 blocks of each other are
# `corroborated` - so a distance the app would not even call a disagreement must not be called
# a stall here. 25 is the first number clear of that, and it fires on 58. It sits deliberately
# far above SHIELD_MAX_LAG_BLOCKS=5, where drips are already refused: the faucet degrades
# quietly for a while before anything here stops a miner or touches state.
NODE_CONFIRMED_LAG_LIMIT="${WATCHDOG_NODE_CONFIRMED_LAG_LIMIT:-25}"  # blocks behind a CORROBORATED tip before that counts as a stall
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
# #510. How many of this episode's attempts ran on an UNCONFIRMED lag, and whether the budget has
# already been repaid once. An unconfirmed attempt restarts and rewinds NOTHING by design, so it
# buys none of what the budget is for; five of them used to spend it, and a confirmation arriving
# afterwards then found `n > NODE_HEAL_MAX` and an already-set give-up flag - no rewind, and the
# confirmed page suppressed by the unconfirmed one. The repayment is ONCE, because a tip oracle
# that flaps would otherwise hand out unlimited rewinds.
node_unconfirmed_attempts=0
node_budget_repaid=0
# #655 review. The derived limit is a STEADY STATE, so it is announced when it CHANGES rather than
# every sweep; the cap is announced once. Both are in-memory on purpose: a watchdog restart
# re-announcing the limit it is now using is information, not noise.
agree_limit_logged=""
agree_capped_logged=0

# 0 = loop forever (production). Tests set this to run an exact number of sweeps.
MAX_TICKS="${WATCHDOG_MAX_TICKS:-0}"

# A SWEEP CLOCK THE SUITE CAN DRIVE, for timing cases only (#570). UNSET - which is every real
# run, and the production path has no branch to get wrong - `wd_now` is `date -u +%s` and nothing
# else. Set, it reads whole seconds from a file that advances by CLOCK_STEP once per sweep, so a
# case can span an episode of any length in constant wall time.
#
# WHY THIS RATHER THAN A WIDER MARGIN: the case #570 is about failed 3 of ~22 runs on 2026-09-15,
# always with three or more harness containers on the same Mac and never alone. Four seats run the
# harness concurrently as a matter of course, so a timing-margin case reports the wrong thing to
# whoever's run lands in the busy window, and it teaches re-run-until-green - the habit the mutant
# gate exists to remove. A bigger margin postpones that; a clock the host cannot influence ends it.
#
# It ADVANCES once per sweep at the top of the loop and is only READ below, so two readers in one
# sweep see the same instant, exactly as two `date` calls a millisecond apart would.
CLOCK_FILE="${WATCHDOG_CLOCK_FILE:-}"
CLOCK_STEP="${WATCHDOG_CLOCK_STEP:-60}"
wd_now() {
  [ -n "$CLOCK_FILE" ] || { date -u +%s; return 0; }
  local t
  t="$(cat "$CLOCK_FILE" 2>/dev/null)"
  case "$t" in ''|*[!0-9]*) t=0 ;; esac
  printf '%s' "$t"
}
wd_clock_tick() {
  [ -n "$CLOCK_FILE" ] || return 0
  local t
  t="$(cat "$CLOCK_FILE" 2>/dev/null)"
  case "$t" in ''|*[!0-9]*) t=0 ;; esac
  echo $((t + CLOCK_STEP)) > "$CLOCK_FILE"
}

# Target containers, matched by name substring so exact compose prefixes and the
# hand-run faucet-web container both resolve. Override any of these in the env.
FAUCET_MATCH="${WATCHDOG_FAUCET_MATCH:-faucet-web}"
ZEBRA_MATCH="${WATCHDOG_ZEBRA_MATCH:-zebra}"
ZALLET_MATCH="${WATCHDOG_ZALLET_MATCH:-zallet}"
# The Signal bridge (risk register #15). It is how every page in this file reaches a
# phone, and until now nothing kept it running: a hand-run `docker run` with whatever
# restart policy it was given, in no compose file, on no watch list. A bridge that dies
# turns every alert into a journal line. Absent on a box without Signal, which is fine:
# find_container returns nothing and nothing happens.
# `-` not `:-`: an EMPTY value is the operator's way of saying "leave the bridge alone
# while I re-link it", and must not fall back to the default. find_container refuses an
# empty match rather than asking docker for every container.
SIGNAL_MATCH="${WATCHDOG_SIGNAL_MATCH-signal-api}"
# Caddy is the edge every page and every visitor goes through, and it was on no
# recovery list (risk register II, R-15): an exited caddy stayed exited until a person
# noticed the site was gone. Empty disables, like the bridge above.
CADDY_MATCH="${WATCHDOG_CADDY_MATCH-caddy}"

log() { echo "$(date -u +%FT%TZ) watchdog: $*"; }

# Escapes the two characters that would break the JSON body. Alert text is
# ours, not user input, but a container name with a quote in it should not
# silently drop an alert.
json_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

# Delegates to the shared sender so one URL covers every unit. Falls back to
# posting inline if alert.sh is not installed yet, so an upgrade cannot mute us.
ALERT_SH="${WATCHDOG_ALERT_SH:-$(dirname "$0")/alert.sh}"
# RETURNS WHETHER THE PAGE LEFT (risk register II, R-14). This used to return 0 whatever
# alert.sh said, and every caller set its "already paged" flag right after, so a NEEDS
# YOU whose POST failed (the bridge restarting, which step 2 itself does, or signal-cli's
# link dropped) was the one page for that episode, lost, and the channel's next word was
# the ✅ for the bridge coming back. Now: 0 delivered; alert.sh's own non-zero for a send
# that failed; 3 for "no channel configured at all", which callers treat as done, since
# retrying into nothing every sweep is not a page either.
alert() {
  log "ALERT: $1"
  local rc
  if [ -x "$ALERT_SH" ]; then
    # --now: these are already one per episode, so alert.sh's per-cause cooldown must not
    # hold a NEEDS YOU behind the FIXED that preceded it. Its output is kept: "sent" and
    # any refusal belong in this journal, not in /dev/null.
    "$ALERT_SH" --now "$1" 2>&1 | sed 's/^/alert.sh: /'
    rc="${PIPESTATUS[0]}"
    [ "$rc" -eq 0 ] || log "alert send failed via $ALERT_SH (rc $rc); the caller retries next sweep"
    return "$rc"
  fi
  [ -n "$ALERT_URL" ] || return 3
  local msg body
  msg="[zcash-faucet watchdog] $(json_escape "$1")"
  case "$ALERT_FORMAT" in
    discord) body="{\"content\":\"$msg\"}" ;;
    slack|*)  body="{\"text\":\"$msg\"}" ;;
  esac
  if curl -fsS --max-time 10 -H 'content-type: application/json' \
       -d "$body" "$ALERT_URL" >/dev/null 2>&1; then return 0; fi
  log "alert webhook POST failed; the caller retries next sweep"
  return 1
}
# "Did that page count as sent": delivered, or nowhere to deliver to. A failed send is
# the one case a caller must not mark as done.
paged() { [ "$1" -eq 0 ] || [ "$1" -eq 3 ]; }

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
  # An empty match would be `--filter name=` and match EVERY container.
  [ -n "$1" ] || return 0
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
      # Up on a later sweep than the one that started it, AND up for long enough that a
      # slow crash loop cannot pass for a recovery. docker's StartedAt is the only
      # witness that does not depend on which sweep happened to look.
      local up
      up="$(container_uptime "$name")"
      if [ -n "$up" ] && [ "$up" -lt "$RECOVERY_MIN_UPTIME" ]; then
        log "$name is running but only ${up}s old after $prior restart attempt(s); not calling that recovered (needs ${RECOVERY_MIN_UPTIME}s)"
        return 0
      fi
      [ -n "$up" ] || log "could not read StartedAt for $name; judging recovery on the sighting alone"
      fixed "$name was down. Started it; running again after $prior restart attempt(s), up ${up:-?}s, verified on a later sweep."
      flap_set "$name" 0
      flap_set "$name.paged" 0
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
  # reminding us without becoming the 812-messages-a-night noise it replaces. The
  # threshold page is retried every sweep until one leaves; "paged" is the delivery,
  # not the attempt, and it lives on disk with the count.
  local was_paged; was_paged="$(flap_get "$name.paged")"
  if { [ "$n" -ge "$FLAP_ESCALATE" ] && [ "$was_paged" = "0" ]; } \
     || { [ "$n" -gt "$FLAP_ESCALATE" ] && [ $(( (n - FLAP_ESCALATE) % FLAP_REALERT )) -eq 0 ]; }; then
    danger "$name crash loop: $n consecutive restarts (state '$state'), not recovering."; rc=$?
    paged "$rc" && flap_set "$name.paged" 1
  fi
}

# Seconds since docker last started the container, or empty when it cannot be read.
# StartedAt is RFC 3339 with nanoseconds; GNU date takes it once the fraction is cut.
container_uptime() {
  local started epoch
  started="$(docker inspect -f '{{.State.StartedAt}}' "$1" 2>/dev/null)" || return 0
  # Empty would become the bare "Z" below, which GNU date reads as today's midnight and
  # reports as hours of uptime; a never-started container's 0001-01-01 parses to a
  # negative epoch. Neither is a reading. And a clock stepped back after the start
  # gives a negative uptime, which is not "young", so it is judged on the sighting.
  [ -n "$started" ] || return 0
  started="${started%%.*}"; started="${started%Z}Z"
  epoch="$(date -u -d "$started" +%s 2>/dev/null)" || return 0
  case "$epoch" in ''|*[!0-9]*) return 0 ;; esac
  # RAW `date`, NOT wd_now, AND THAT IS DELIBERATE (#626 review - SDE-UI and SDE-App reached it
  # independently). `epoch` came from docker's StartedAt, a real instant produced OUTSIDE this
  # process, so the only clock it can be subtracted from is the real one. Under the suite's driven
  # clock this reads about -39,600,000 (1750000100 - a real StartedAt epoch), and the guard below
  # swallows it. THAT MAGNITUDE IS THE POINT, and I had it wrong first: I wrote "-1.75 billion",
  # which is only the degenerate path where CLOCK_FILE is set and the file is missing, and a
  # number that size looks broken to anyone who sees it. -39 million is the kind of absurd a
  # guard eats quietly - a plausible wrong number rather than an error, which is the worse
  # failure. Corrected by SDE-App on review, who computed both paths rather than reading mine.
  # The hazard is not a bug today; it is the tidy-up that
  # converts "the remaining date calls" for consistency, and a comment is what stops that edit.
  # A test cannot: it would have to pin the ABSENCE of a conversion, which is the denylist shape
  # all three of us have shipped once this week.
  local up=$(( $(date -u +%s) - epoch ))
  [ "$up" -ge 0 ] || return 0
  echo "$up"
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
  # RAW `date` for the same reason as the sibling above: `epoch` is parsed from a timestamp the
  # miner wrote, so its zero point is the real clock and nothing else can be subtracted here.
  printf '%s' "$(( $(date -u +%s) - epoch ))"
}

# STEP 6: MINER STALL RECOVERY. Narrow, like the poison heal. It acts ONLY on a miner
# that is provably alive (heartbeat fresh) yet not templating (lastTemplateAt stale), so
# it never touches a miner that is merely down - that is Restart=always' job - nor one
# that just (re)started and has not had time to fetch its first template. Capped, so a
# stall it cannot fix (zebra genuinely down, RPC endpoint moved) pages a human instead of
# restart-looping the miner forever.
# THE MINER IS ALIVE AND COMPLETING NOTHING (#660). It NAMES the state and never heals it.
#
# WHY THE ABANDON RATE AND NOT SILENCE ALONE. "No solve in N" is a weak detector by itself because
# solves are rare and irregular - see MINER_NO_SOLVE_SECS. The abandon count is the half that does
# not depend on luck: the miner abandons an attempt when the tip moves under it, so a healthy miner
# abandons about once per block. A rate several times that means it is starting and discarding work
# continuously, which is true whatever the cause and whether or not a solve happened to land.
# BOTH must hold. A high rate with solves still landing is not "completing nothing", and silence
# with a normal rate is just a quiet afternoon.
#
# WHAT IT DELIBERATELY DOES NOT SAY: why. The cause is outside this file - it could be the node, the
# network, or the miner - and an alert that guesses sends the reader to the wrong place with
# confidence. It prints the two numbers that make the state legible and stops there.
# AND IT NAMES NO COMPONENT AT ALL, not even as a place to look. My first draft ended "read the
# miner journal and the node's tip" - a pointer rather than a guess, and the row below still caught
# it, because a reader who sees "node" in a page about the miner has been pointed whether or not a
# claim was made. The numbers are the message; where to look is the reader's to decide.
miner_completing_nothing() {
  [ "$MINER_OUTCOME_ENABLED" = "1" ] || return 0
  [ -f "$MINER_HEARTBEAT" ] || return 0
  # A miner step 7 stopped for a node heal is not completing anything BY DESIGN.
  [ "$(flap_get "$MINER_STOP_KEY")" != "1" ] || return 0

  local written_age started_age quiet abandons per_block solved_at
  written_age="$(ts_age "$(hb_field writtenAt)")"
  # No parseable or stale heartbeat: the process itself is the question, and step 6 owns that.
  [ -n "$written_age" ] && [ "$written_age" -le "$MINER_HEARTBEAT_FRESH_SECS" ] || return 0
  # A miner that is not submitting is not expected to complete anything.
  [ "$(hb_field mode)" = "submit" ] || return 0

  started_age="$(ts_age "$(hb_field startedAt)")"
  # Cannot claim "nothing in six hours" about a process that has not been up for six hours.
  [ -n "$started_age" ] && [ "$started_age" -ge "$MINER_NO_SOLVE_SECS" ] || return 0

  # NULL IS NOT ZERO. A heartbeat written before #666 carries no abandonedCount, and reading its
  # absence as 0 would say "this miner has never abandoned an attempt" on no evidence at all.
  abandons="$(hb_num abandonedCount)"
  [ -n "$abandons" ] || return 0

  # Never solved since start is the strongest case of "no solve", not a missing measurement: the
  # duration that matters is then the whole uptime.
  solved_at="$(ts_age "$(hb_field lastSolvedAt)")"
  quiet="${solved_at:-$started_age}"

  # THE RATE IS A DELTA, NOT A LIFETIME TOTAL OVER AN UPTIME. abandonedCount is restored across
  # restarts by heartbeat.rs resume(), so it counts since the miner first ran, while startedAt is
  # THIS process. Dividing one by the other mixes two scopes and reports a rate the miner never ran
  # at - after a restart it would be enormous and this rung would page a healthy miner. That is L49
  # in my own code, and a surviving mutant is what found it: the arm that removed the uptime guard
  # changed nothing, because the guard was standing in for an arithmetic that was wrong underneath.
  # Measured against the PREVIOUS reading instead, which is the only form that means "right now".
  local now_s base_n base_t base_h tmpl_now blocks win
  now_s="$(wd_now)"
  base_n="$(flap_get "$MINER_ABANDON_N_KEY")"
  base_t="$(flap_get "$MINER_ABANDON_T_KEY")"
  base_h="$(flap_get "$MINER_ABANDON_H_KEY")"
  tmpl_now="$(hb_num lastTemplateHeight)"
  # Without a template height there is nothing to count blocks with, and a rate needs a denominator.
  [ -n "$tmpl_now" ] || return 0
  # A timestamp of 0 is the helper's "nothing stored" answer, and it is never a real reading: wd_now
  # is an epoch on the box. So 0 means no baseline. A counter that went BACKWARDS is a miner that
  # started without resuming, which is a new baseline rather than a negative rate.
  if [ "$base_t" = "0" ] || [ "$abandons" -lt "$base_n" ] || [ "$tmpl_now" -lt "$base_h" ]; then
    flap_set "$MINER_ABANDON_N_KEY" "$abandons"; flap_set "$MINER_ABANDON_T_KEY" "$now_s"
    flap_set "$MINER_ABANDON_H_KEY" "$tmpl_now"
    return 0
  fi
  win=$(( now_s - base_t ))
  # Too short a window to divide by. KEEP the baseline rather than refreshing it, or a short sweep
  # interval would reset the window for ever and the rung would never measure anything.
  [ "$win" -ge "$MINER_RATE_WINDOW_SECS" ] || return 0
  # THE DENOMINATOR IS COUNTED, NOT ASSUMED. blocks is how far the tip actually moved in this
  # window. A TIP THAT DID NOT MOVE IS NOT A RATE OF ZERO, it is no rate at all - and it is also the
  # only division guard this needs, so the guard and the meaning are the same line.
  blocks=$(( tmpl_now - base_h ))
  if [ "$blocks" -le 0 ]; then
    flap_set "$MINER_ABANDON_N_KEY" "$abandons"; flap_set "$MINER_ABANDON_T_KEY" "$now_s"
    flap_set "$MINER_ABANDON_H_KEY" "$tmpl_now"
    return 0
  fi
  # Integer arithmetic on purpose - this is a threshold, not a statistic.
  per_block=$(( (abandons - base_n) / blocks ))
  flap_set "$MINER_ABANDON_N_KEY" "$abandons"; flap_set "$MINER_ABANDON_T_KEY" "$now_s"
  flap_set "$MINER_ABANDON_H_KEY" "$tmpl_now"

  if [ "$quiet" -ge "$MINER_NO_SOLVE_SECS" ] && [ "$per_block" -ge "$MINER_ABANDON_PER_BLOCK" ]; then
    # A STATE, said once, like every other state line here - not an event repeated every sweep.
    if [ "$(flap_get "$MINER_OUTCOME_KEY")" != "1" ]; then
      danger "miner is running and completing nothing. No block solved in $((quiet / 3600))h, and $abandons abandoned attempts since it started $((started_age / 3600))h ago - about $per_block per block where one is normal. It is templating and erroring nothing, so nothing here restarts it and this needs a person."
      flap_set "$MINER_OUTCOME_KEY" 1
    fi
  elif [ "$(flap_get "$MINER_OUTCOME_KEY")" = "1" ]; then
    # Cleared by a SOLVE or by the rate coming back, so a second episode pages again.
    fixed "miner is completing work again (last solve $((quiet / 60))m ago, $per_block abandons per block)."
    flap_set "$MINER_OUTCOME_KEY" 0
  fi
}

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
      # Episode state, so it clears with the count. Left set, a SECOND stall in the same process
      # would be silent at the give-up rung.
      flap_set "$key.paged" 0
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
  elif [ "$n" -gt "$MINER_HEAL_MAX" ] && [ "$(flap_get "$key.paged")" = "0" ]; then
    # RETRIED UNTIL ONE LEAVES, not fired at an exact count (#511). This was `-eq MAX+1`, so the
    # give-up page existed on exactly ONE sweep: alert.sh failing there - a Signal outage, a full
    # disk, the broker hanging up - lost it for the rest of the episode, and nothing else says the
    # miner has stopped being retried. Same fix and same shape as the crash-loop page (#507): the
    # flag records DELIVERY rather than the attempt, and it lives on disk beside the count so a
    # watchdog restart cannot hand out a second one.
    danger "miner still stalled after $MINER_HEAL_MAX restarts. Not retrying. Zebra down, or its RPC endpoint moved?"; rc=$?
    paged "$rc" && flap_set "$key.paged" 1
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

# IS THE MINER RUNNING, ONE DEFINITION. Two rungs need this judgement and #571 is the issue
# about a third copy of a word going stale, so a second copy of the SET was the same defect one
# PR later - found by SDE-UI on review of #533 step 2. "activating" and "reloading" are units
# about to extend this chain (red-team, #560): a stop line keyed on exactly "active" leaves a
# starting miner with no instruction at all, and the whole point of #618 is that the three words
# are one decision rather than three spellings.
miner_unit_is_running() {
  case "${1:-}" in active|activating|reloading) return 0 ;; esac
  return 1
}

# OUR BLOCK HASH AT A HEIGHT, for the history half of the fork detector (#533 step 2).
#
# Mirrors zebra_chain_heights deliberately: same container, same cookie, same no-jq parse. The
# height is passed as an ARGUMENT to sh rather than interpolated into the JSON, so the quoting
# has one level instead of three and nothing this function builds depends on the caller having
# validated the number - though the caller does.
#
# Empty means we could not read it, which is never evidence of anything. That is the whole
# discipline of this rung: fail on proof, not on cannot-verify (#533).
zebra_block_hash() {
  local name="$1" height="$2" out
  [ -n "$name" ] && [ -n "$height" ] || return 0
  out="$(docker exec "$name" sh -lc 'CK=$(cat /run/auth/.cookie 2>/dev/null || cat /var/run/auth/.cookie 2>/dev/null); curl -s --max-time 10 -u "$CK" --data-binary "{\"jsonrpc\":\"1.0\",\"id\":\"watchdog\",\"method\":\"getblockhash\",\"params\":[$1]}" -H content-type:text/plain http://127.0.0.1:18232/' _ "$height" 2>/dev/null)" || return 0
  printf '%s' "$out" | sed -n 's/.*"result":"\([0-9a-fA-F][0-9a-fA-F]*\)".*/\1/p' | head -n1
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
#
# A CLOCK ESTIMATE MAY RESTART, NEVER CLEAR STATE OR PARK THE MINER. Zebra's
# `estimatedheight` is extrapolated from the tip's timestamp, so a quiet network and a
# wedged node look the same to it. Rung 1 (restart) is cheap and zebra's own word is
# enough for it (a restart can itself drop the non-finalized tip if the 10 s stop grace
# runs out before the backup is written, which the miner's own 100-lag guard covers).
# Rungs 2-3 (wipe peers, drop the non-finalized state) and stopping the miner are
# deliberate rewinds: those happen only when a CORROBORATED height confirms the lag - two
# non-stale references that agree, which /api/ready reports as `corroborated` beside
# `usedHeight`, and step 4 fetched that body this very sweep. NOT `node.externalHeight`,
# which this comment used to name and which step 7 used to read: that is the same height
# with the corroboration discarded, so one flaky source could buy a rewind. No
# confirmation - app unreachable, oracle dark, one source only, two that disagree, or the
# corroborated tip within its limit - means restarts only, and the give-up page says that
# instead of prescribing a snapshot reimport for a node that may be at the tip.
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
  # THE MARKER OUTRANKS THE RELEASE (R-12). Without this the rung is bypassed by this
  # script: the fork rung parks the miner decision, the node then recovers enough for
  # `release_miner_after_heal` to fire, and the watchdog starts the miner back onto the
  # chain it was just parked off - the same un-parking auto-deploy was taught to refuse,
  # one caller over. Whether it stays stopped is the owner's, and the marker is how that
  # is expressed to every process that might start it.
  if [ -f "$FORK_PARK_MARKER" ]; then
    MINER_RELEASE_NOTE=" The miner is still stopped ON PURPOSE: a fork park marker is in place ($FORK_PARK_MARKER). Clearing it is a human's call - see OPERATIONS.md."
    log "node recovered but NOT starting $MINER_UNIT: $FORK_PARK_MARKER exists"
    return 0
  fi
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
    danger "the node has recovered but 'systemctl start $MINER_UNIT' FAILED. The miner was stopped for the heal and is still stopped; the watchdog retries every sweep, or start it by hand."; rc=$?
    paged "$rc" && alerted_miner_start_failed=1
  fi
  return 0
}

# THE ONE DEFINITION OF "AN INDEPENDENT HEIGHT THIS SCRIPT MAY ACT ON". Two rungs need one
# and they had drifted, which is how the first cut of this fix came to authorise a chain
# rewind on a single source. Step 8 has read `corroborated` beside `usedHeight` since #560.
# Step 7 read `externalHeight`, which is the SAME NUMBER WITH THE CORROBORATION THROWN AWAY:
# the app sets it to the highest fresh reference whether the references agree or not
# (src/lib/zcash/externalTip.ts, referenceTip/getTipReferences; nodeStatus.ts assigns
# `referenceTip().height` to it). So one source, or two that disagree by 400 blocks, read to
# this rung as an independent tip - and line 83 of this file already forbids exactly that in
# those words: acting on it "converts an oracle outage into a chain rewind". A proxy for the
# property, with the property itself sitting one rung down unused. Found by the CTO's
# red-team on #568.
#
# Echoes the height when there is one this script may act on, and NOTHING otherwise. Callers
# read empty as "unconfirmed" - never as "at the tip", never as "behind", never as 0.
corroborated_tip_height() {
  local corr used_h
  corr="$(printf '%s' "${ready_body:-}" | grep -o '"corroborated":[a-z]*' | head -n1 | cut -d: -f2)"
  used_h="$(printf '%s' "${ready_body:-}" | grep -o '"usedHeight":[0-9][0-9]*' | head -n1 | cut -d: -f2)"
  case "$used_h" in ''|*[!0-9]*) used_h="" ;; esac
  # `true` only. An absent field and a null one read the same, on purpose: a body from before
  # #559 must never be turned into a height, and `corroborated:null` is a single source.
  if [ "$corr" = "true" ] && [ -n "$used_h" ]; then printf '%s' "$used_h"; fi
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

  local heights blocks est prev now lag external
  heights="$2"
  [ -n "$heights" ] || return 0
  blocks="${heights%% *}"; est="${heights##* }"
  prev="$node_last_height"; node_last_height="$blocks"
  now="$(wd_now)"

  # WHICH NUMBER "BEHIND" MEANS, and the whole rung turns on it (2026-09-15T20:35Z outage).
  # `estimatedheight` is zebra's own CLOCK extrapolation from the tip's timestamp at the target
  # spacing, so while the node is frozen it grows at one block per 75 s no matter what the
  # network is doing. That night testnet was producing every 9 s: the number this gated on grew
  # 0.8 blocks a minute while the real gap grew 6.7, the node sat frozen ten minutes 58 blocks
  # behind, and the watchdog journal has NO ENTRY for the episode. Zebra also reported
  # syncPercent 100 beside a 44-block lag, so the proxy fails at the source, not in our reading.
  #
  # The independent height was already being fetched every sweep and used only to CONFIRM rungs
  # the trigger never reached. It is the trigger now. Zebra's own estimate stays as the fallback
  # for a sweep where the app cannot be reached, because a blind watchdog that still restarts a
  # wedged node is better than one that does nothing - but it is named as the weaker evidence in
  # the journal, and it does not confirm a rewind.
  local zebra_lag ext_lag="" lag_src
  zebra_lag=$(( est - blocks )); [ "$zebra_lag" -lt 0 ] && zebra_lag=0
  # THE GATE, not the raw field. `externalHeight` is the same height with the corroboration
  # discarded, so reading it here made one flaky source sufficient for the rewinding rungs.
  external="$(corroborated_tip_height)"
  # EITHER NUMBER MAY TRIGGER, and that is the whole change: the independent tip is ADDED as a
  # trigger rather than substituted for zebra's. Substituting it would have overturned a
  # deliberate ruling this suite already protects - "a lag only zebra believes in buys restarts,
  # never a rewind or a parked miner" - and the suite caught me doing exactly that. A restart is
  # cheap and reversible, so the cheaper evidence is allowed to buy one; a REWIND is not, so it
  # still needs an independent height, which is what `confirmed` has always meant.
  if [ -n "$external" ]; then
    ext_lag=$(( external - blocks )); [ "$ext_lag" -lt 0 ] && ext_lag=0
  fi
  # EACH NUMBER AGAINST ITS OWN LIMIT. One threshold cannot serve both, and the first cut of
  # this fix tried: NODE_LAG_LIMIT=100 is right for a clock extrapolation and the suite pins
  # 55-by-the-clock as not-a-stall, while the same 100 meant tonight's 58 blocks behind a
  # CORROBORATED tip never started the stall clock at all. So the corroborated number gets
  # NODE_CONFIRMED_LAG_LIMIT and zebra's estimate keeps NODE_LAG_LIMIT.
  # THE CONFIRMED LIMIT IS DERIVED, NOT A SECOND COPY OF THE APP'S NUMBER (#651, SDE-App).
  # The app decides what counts as two sources AGREEING, and it publishes that tolerance flat in
  # /api/ready as `agreeBlocks`. If it calls a 32-block spread agreement, then a "corroborated" tip
  # is only good to +/-32 - and a fixed 25 here would read that tolerance slack as a confirmed lag
  # and drop non-finalized state on noise. So the floor has to sit ABOVE the app's tolerance by
  # construction rather than by two people remembering the same number.
  #
  # NO LITERAL WORKS, which is why this is derived: the tolerance is a block count standing in for
  # a delay measured in seconds, so it moves with the block rate. Any value clearing 32 at 10s
  # blocks is 60+ at 5s and absurd at 75s.
  #
  # +5 IS A JUDGEMENT AND THE ONLY ONE HERE. It is margin above the tolerance, not a derived
  # quantity, and it is named rather than folded in so the next person can argue with it.
  #
  # THE CONSTANT STAYS AS THE FLOOR. A missing or garbage field leaves today's behaviour exactly as
  # it is - same shape as the retry counter's guard, and the reason a /api/ready that predates #651
  # is not a silent downgrade.
  local agree_b conf_limit
  agree_b="$(printf '%s' "${ready_body:-}" | grep -o '"agreeBlocks":[0-9][0-9]*' | head -n1 | cut -d: -f2)"
  case "$agree_b" in ''|*[!0-9]*) agree_b="" ;; esac
  # AND A CEILING, because a floor alone only protects us from a SILENT app (SDE-App, review of
  # #655). The point of floor-and-derive is that this constant still governs when the app is
  # WRONG - a runaway tolerance would otherwise raise the limit without bound and switch this rung
  # off from the far end of an HTTP call. Four times the floor is far above any cadence we have
  # measured and still finite; past it the app is not telling us about block spacing any more.
  conf_limit="$NODE_CONFIRMED_LAG_LIMIT"
  local conf_ceiling=$(( NODE_CONFIRMED_LAG_LIMIT * 4 ))
  if [ -n "$agree_b" ]; then
    local want=$(( agree_b + 5 ))
    if [ "$want" -gt "$conf_ceiling" ]; then
      [ "$agree_capped_logged" = "1" ] || {
        log "the app published agreeBlocks=$agree_b, which would put the confirmed-lag limit at $want; capping at $conf_ceiling. Nothing remote can switch this rung off."
        agree_capped_logged=1
      }
      want="$conf_ceiling"
    fi
    if [ "$want" -gt "$conf_limit" ]; then
      conf_limit="$want"
      # SAID WHEN IT CHANGES, NOT EVERY SWEEP. agreeBlocks is ~30 at testnet's cadence, so the
      # raise is true on every sweep: ~2,880 identical lines a day describing a healthy steady
      # state, which is the shape this file refuses everywhere else (fork_cannot_tell_logged,
      # history_cannot_tell_logged, zallet.retryloop).
      if [ "$agree_limit_logged" != "$conf_limit" ]; then
        log "confirmed-lag limit now $conf_limit from the app's published agreeBlocks=$agree_b (floor $NODE_CONFIRMED_LAG_LIMIT, ceiling $conf_ceiling)"
        agree_limit_logged="$conf_limit"
      fi
    fi
  fi

  local ext_over=0 zebra_over=0
  [ -n "$ext_lag" ] && [ "$ext_lag" -gt "$conf_limit" ] && ext_over=1
  [ "$zebra_lag" -gt "$NODE_LAG_LIMIT" ] && zebra_over=1
  # THE NUMBER THAT FIRED, NOT THE LARGER ONE. With two limits the bigger raw lag can be the
  # one still inside its own budget - zebra 90 under its 100, beside 30 behind a corroborated
  # tip over its 25 - and a journal that named the 90 would send an operator to the evidence
  # that did not act. That was finding 4 of the same review: the line read "which the
  # independent tip does not support" about a lag that same tip had confirmed.
  if [ "$ext_over" = "1" ]; then
    lag="$ext_lag"; lag_src="corroborated tip $external"
  elif [ "$zebra_over" = "1" ]; then
    lag="$zebra_lag"
    lag_src="zebra's own clock estimate${external:+, which the corroborated tip $external does not support}"
    [ -z "$external" ] && lag_src="zebra's own clock estimate, no corroborated tip this sweep"
  elif [ -n "$ext_lag" ] && [ "$ext_lag" -ge "$zebra_lag" ]; then
    # Neither is over its limit, so nothing fires; the number is only for the idle line.
    lag="$ext_lag"; lag_src="corroborated tip $external"
  else
    lag="$zebra_lag"
    lag_src="zebra's own clock estimate${external:+, which the corroborated tip $external does not support}"
    [ -z "$external" ] && lag_src="zebra's own clock estimate, no corroborated tip this sweep"
  fi

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
    node_unconfirmed_attempts=0; node_budget_repaid=0
    return 0
  fi

  # Not higher, but essentially at the tip: normal idle between blocks, not a stall.
  # AND the place to release a miner a heal stopped when the height never strictly
  # advanced across a sweep: a snapshot reimport, or a node that came back already at its
  # tip. Review found the flag stuck for ever here, with step 6 disabled by it and the
  # panel reading a calm "off". At the tip is exactly when mining is safe.
  # BOTH numbers inside their own budget, not one number under one limit.
  if [ "$ext_over" = "0" ] && [ "$zebra_over" = "0" ]; then
    node_stall_since=0
    if [ "$prev" -gt 0 ] && [ "$(flap_get "$MINER_STOP_KEY")" = "1" ]; then
      release_miner_after_heal
      [ -n "$MINER_RELEASE_NOTE" ] && fixed "zebra is at the tip again after a node heal (${lag} behind).${MINER_RELEASE_NOTE}"
      # At the tip IS the end of the episode, so the budget and the one-page-per-episode
      # flags reset here exactly as they do when the height advances; left set, a later
      # advancing sweep would report the same heal twice and the next stall would start
      # with no budget and no page.
      node_heal_attempts=0; alerted_node_giveup=0; node_heal_what=""; node_stall_lag=0
      node_unconfirmed_attempts=0; node_budget_repaid=0
    fi
    return 0
  fi

  # Behind and not moving. Start the stall clock, or keep it running.
  [ "$node_stall_since" = "0" ] && node_stall_since="$now"
  local stalled_for=$(( now - node_stall_since ))
  [ "$stalled_for" -ge "$NODE_STALL_SECS" ] || return 0

  # The independent height, from the /api/ready body step 4 fetched this sweep. Empty
  # when the app did not answer or the oracle had nothing; the readers below treat empty
  # as "unconfirmed", never as "at the tip" and never as "behind".
  # CONFIRMED means an INDEPENDENT height says we are behind, which is now the same number the
  # trigger used. A sweep that fell back to zebra's own estimate confirms nothing, so the
  # rewinding rungs stay withheld exactly as before.
  # CONFIRMED is now exactly one thing: a CORROBORATED height says we are behind by more than
  # the confirmed limit. `external` is empty unless corroborated_tip_height let it through, so
  # a single source and two that disagree both land here as unconfirmed and the rewinding
  # rungs stay withheld - which is what this variable was always documented to mean and, until
  # the red-team probed it, not what it did.
  local confirmed="$ext_over"

  # THE WEDGE THIS FILE ALREADY DESCRIBED AND NEVER LOOKED FOR (line 89, and the 20:35Z outage
  # proved it verbatim): zebra logs "exhausted prospective tip set" and then "waiting to restart
  # sync" on a 67 s loop that never recovers, and the comment ends "a human restarted zebra by
  # hand". That night recovery came from an inbound gossiped block, not from the syncer. Naming
  # it does two things: the journal and the page say WHICH failure this is rather than "stalled",
  # and it confirms the peer-cache rung specifically, because a peer set that has stopped serving
  # is exactly what dropping that cache addresses. It never authorises the non-finalized drop -
  # that still needs an independent height, because it rewinds the chain rather than the peers.
  local tipset_note="" tipset=0
  if docker logs --tail 80 "$name" 2>&1 | grep -q "exhausted prospective tip set"; then
    tipset=1
    tipset_note=" - zebra's log says it exhausted its prospective tip set and is waiting to restart sync, which is the peer set having stopped serving blocks"
  fi

  # THE BUDGET IS REPAID FOR RESTARTS THAT REWOUND NOTHING (#510). An unconfirmed lag takes the
  # restart-only rung by design: no peer cache dropped, no non-finalized state dropped, no miner
  # stopped. Five of those spent a budget whose whole purpose is to authorise the rungs they were
  # not allowed to reach - and when the tip oracle or the app came back and the lag was CONFIRMED,
  # `n > NODE_HEAL_MAX` returned early and `alerted_node_giveup` was already 1 from the unconfirmed
  # page, so the confirmed one never fired either. A real fork got no rewind and no page; step 4's
  # 30-minute NOT READY was the only thing left.
  #
  # ONCE PER EPISODE, and that is the guard that matters: a tip oracle flapping between confirmed
  # and unconfirmed would otherwise refund the budget every time it flipped and hand out unlimited
  # rewinds on a node nothing has actually confirmed.
  if [ "$confirmed" = "1" ] && [ "$node_unconfirmed_attempts" -gt 0 ] && [ "$node_budget_repaid" != "1" ]; then
    local repaid="$node_unconfirmed_attempts"
    node_heal_attempts=$(( node_heal_attempts - repaid ))
    [ "$node_heal_attempts" -ge 0 ] || node_heal_attempts=0
    node_unconfirmed_attempts=0
    node_budget_repaid=1
    # The give-up page is re-armed with it: the earlier page said "no independent tip confirms it",
    # which is now false, and the operator needs the sentence that names a fork.
    alerted_node_giveup=0
    log "an independent tip now CONFIRMS the lag; returning $repaid heal attempt(s) that ran unconfirmed and rewound nothing, and re-arming the page ($node_heal_attempts/$NODE_HEAL_MAX spent)"
  fi

  local n=$(( node_heal_attempts + 1 ))
  if [ "$n" -gt "$NODE_HEAL_MAX" ]; then
    if [ "$alerted_node_giveup" = "0" ]; then
      local miner_note=""
      [ "$(flap_get "$MINER_STOP_KEY")" = "1" ] && miner_note=" The miner is left STOPPED until the node is fixed: systemctl start $MINER_UNIT afterwards."
      if [ "$confirmed" = "1" ]; then
        danger "zebra still ${lag} blocks behind after $NODE_HEAL_MAX tries (restart, clear peers, drop fork state); the network tip (${external}) confirms it. Likely a fork past the finalized tip: compare getblockhash with an explorer and reimport a snapshot (SNAPSHOTS.md).${miner_note}"; rc=$?
      else
        # ${miner_note} here too: an episode can be confirmed for its first attempts
        # (miner stopped, flag on disk) and lose its confirmation before the budget is
        # spent, or this process can have inherited the flag from the watchdog a deploy
        # replaced. Review reproduced both; the page then said "not stopped" over a
        # unit that was inactive, which told the operator there was nothing to bring back.
        danger "zebra reports itself ${lag} blocks behind its own estimate and the tip has not moved after $NODE_HEAL_MAX restarts, but no independent tip confirms it (external: ${external:-unknown}), so these restarts rewound nothing and did not stop the miner. A quiet testnet looks like this; so does an app, wallet RPC or tip oracle that cannot be reached (the height comes through /api/ready, which needs zallet's getwalletstatus to answer). Compare getblockhash with an explorer before touching state.${miner_note}"; rc=$?
      fi
      paged "$rc" && alerted_node_giveup=1
    fi
    return 0
  fi
  node_heal_attempts="$n"
  # Counted BEFORE the ladder runs, because what makes this attempt refundable is the evidence it
  # had, not what it managed to do.
  [ "$confirmed" != "1" ] && node_unconfirmed_attempts=$(( node_unconfirmed_attempts + 1 ))
  [ "$node_stall_lag" = "0" ] && node_stall_lag="$lag"

  # Stop the miner for the episode, once, and only if it is running, and only when the
  # lag is CONFIRMED. Every rewind below moves the node's tip backwards; a miner
  # submitting through that extends whatever it was on. But on an unconfirmed lag there
  # is no rewind, and stopping the miner on a quiet testnet parks the one thing that
  # would have ended the quiet; its own sync guard (the same 100) idles it if needed.
  if [ "$confirmed" != "1" ]; then
    log "not stopping $MINER_UNIT: zebra's own estimate says ${lag} behind but no independent tip confirms it (external: ${external:-unknown})"
  elif [ "$NODE_STOPS_MINER" != "1" ]; then
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

  if [ "$n" -ge "$NODE_CLEAR_CACHE_AFTER" ] && [ "$confirmed" != "1" ] && [ "$tipset" != "1" ]; then
    # The rung that would rewind, withheld: zebra's own estimate is the only evidence.
    log "zebra stalled ${stalled_for}s at height $blocks (${lag} behind per ${lag_src}, unconfirmed); restarting only, not rewinding state on an unconfirmed lag ($n/$NODE_HEAL_MAX)"
    docker restart "$name" >/dev/null 2>&1
    node_heal_what="Restarted it (lag unconfirmed, nothing rewound)"
  elif [ "$n" -ge "$NODE_CLEAR_CACHE_AFTER" ]; then
    # Both live on the chain volume: the peer cache at network/<net>.peers, and the
    # non-finalized state backup at non_finalized_state/. Stop FIRST: zebra rewrites both
    # on shutdown, so a delete before the stop is undone by the stop.
    local mp what
    mp="$(docker volume inspect "$ZEBRA_CHAIN_VOLUME" -f '{{.Mountpoint}}' 2>/dev/null || echo '')"
    log "zebra stalled ${stalled_for}s at height $blocks (${lag} behind per ${lag_src})${tipset_note}; clearing state ($n/$NODE_HEAL_MAX)"
    docker stop "$name" >/dev/null 2>&1
    if [ -n "$mp" ]; then
      rm -f "$mp"/network/*.peers 2>/dev/null
      what="cleared the peer cache"
      # The peers may go on a named wedge; the CHAIN may not. Dropping the non-finalized state
      # rewinds up to ~100 blocks and only an independent height earns that.
      if [ "$n" -ge "$NODE_DROP_NONFINAL_AFTER" ] && [ "$confirmed" = "1" ]; then
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
    log "zebra stalled ${stalled_for}s at height $blocks (${lag} behind per ${lag_src})${tipset_note}; restarting ($n/$NODE_HEAL_MAX); report follows once the tip moves"
    docker restart "$name" >/dev/null 2>&1
    node_heal_what="Restarted it"
  fi
  # Give the restart room to reconnect and pull a burst before it is judged again.
  node_stall_since=0
}

faucet_misses=0
alerted_faucet_app=0  # delivery of the step-3 page, per episode (#511)
faucet_restarts=0   # consecutive restarts with no healthy sweep in between
unready_since=0
alerted_unready=0
sends_failing_since=0
# The reason from the last UN-READY sweep. A flap usually ends on a good read, so ${reason}
# is empty exactly when the counting rung fires - the one field meant to explain the page
# would be 'unknown' every time. Loop state, not a flap_* key: that store sanitises anything
# non-numeric to 0 on the way back off disk.
fw_last_reason=""

# An unrecognized format still sends (a watchdog that dies on a config typo
# is worse than one that guesses), but say so, or a typo means alerts go out
# in a shape the channel rejects and nobody hears anything.
case "$ALERT_FORMAT" in
  slack|discord) : ;;
  *) log "WARNING: unknown WATCHDOG_ALERT_FORMAT '$ALERT_FORMAT', sending the slack shape (valid: slack, discord)" ;;
esac

# WHAT THE START LINE SAYS ABOUT ALERTING IS alert.sh's ANSWER, not this script's own
# variable (risk register II, R-24). Pages go through alert.sh, which reads
# /etc/faucet/alerts.env (FAUCET_ALERT_*); WATCHDOG_ALERT_URL is the fallback for a box
# without alert.sh. So "alert=none" printed here on a box paging Signal every day, and
# a URL, had one been set, would have gone into the journal. Now: the channel kind, and
# never the URL.
alert_channel="none"
if [ -x "$ALERT_SH" ]; then
  alert_channel="$("$ALERT_SH" --describe 2>/dev/null || echo unknown)"
elif [ -n "$ALERT_URL" ]; then
  alert_channel="inline/${ALERT_FORMAT}"
fi
log "starting: interval=${INTERVAL}s faucet=${FAUCET_URL} ready_grace=${READY_GRACE_SECS}s alert=${alert_channel}"

ticks=0
# STEP 8: A SELF-MINED FORK - OUR NODE AHEAD OF EVERY INDEPENDENT REFERENCE.
#
# 2026-09-15: a deploy restarted a miner the owner had stopped, the box mined its own chain,
# and Zallet eventually rewound 18,434 blocks. Nothing in the watchdog was watching for
# that direction. Step 7 asks "is the network past us"; this asks "are we past the network",
# which is the same fault seen from the side where money is built.
#
# WHAT IT READS, and why it can: /api/ready carries `usedHeight` beside `used` (#559, asked
# for while writing this) and `corroborated` beside it. Both are FLAT, because this script
# parses with grep, sed and cut by design - `sources[used].height` two levels down is out of
# reach and a brace-bounded grep for it is the #391 greedy-match trap volunteered. Our own
# height comes from step 7's reader, so one RPC shape lives in one place.
#
# THREE OUTCOMES AND ONE OF THEM IS SILENCE. Not corroborated (false, or `null` for a single
# source) or no usable reference at all is CANNOT-TELL: logged, never paged, nothing touched.
# Ahead by at most the limit is normal for a node that mines. Past the limit, on two
# references that agree with each other, is a fork - and then it writes the park marker and
# pages, in that order, because the marker is what stops the next auto-deploy tick from
# starting the miner and the page can wait two seconds behind it.
#
# IT DROPS NOTHING - see FORK_AHEAD_BLOCKS above for why a rewind here would be a lie.
# THE HISTORY HALF OF THE FORK DETECTOR (#533 step 2, risk register R-20).
#
# The rung above asks "are we ahead of a tip two references agree on". This asks a different and
# stronger question: at a height both sides have settled on, do we and the network have the SAME
# BLOCK. A hash mismatch at depth is proof of a split; being ahead is only evidence of one.
#
# DELIBERATELY NOT GATED ON `corroborated`, and that is the point of building it. #600 found that
# corroboration reads false most of the time on a fast-block day - the tolerance is a block COUNT
# absorbing a disagreement measured in SECONDS - and while it is false the rung above cannot act.
# Two independent sources agreeing about a TIP is what that rung needs; one source's hash at a
# settled HEIGHT needs no second opinion, because a wrong hash is not a matter of timing. So this
# keeps working in exactly the condition that paralyses the other, which is the condition
# 2026-09-15 happened in.
#
# FAIL ON PROOF, NOT ON CANNOT-VERIFY - the register's phrasing and the whole contract here. An
# unshipped app half, an absent field, an unreachable zebra and an unparseable hash all act on
# NOTHING and say so once. Only two hashes that both parsed and differ will park and page.
#
# IT DOES NOT STOP THE MINER. That is the ruling recorded below at the AHEAD rung (CTO red-team,
# finding 2): the marker gates STARTS, and stopping a running unit stays the owner's. #533's
# wording predates that ruling and I am not reversing it from an issue; the page leads with the
# stop INSTRUCTION when the unit is running, exactly as the other rung does.
#
# WHAT IT READS, and why the fields are flat: `referenceHeight` and `referenceHash` sit at the top
# level of /api/ready beside `usedHeight`, for the reason usedHeight is there at all - this script
# parses with grep, sed and cut, and two levels down is the #391 greedy-match trap. The app picks
# the height and publishes it; we do not derive our own, so the two processes cannot disagree about
# where they looked.
check_history_against_reference() {
  local name="$1" ref_h ref_hash ours_hash lower_ours lower_ref park stop_first hist_word
  [ "$FORK_HEAL_ENABLED" = "1" ] || return 0
  [ -n "$name" ] || return 0

  ref_h="$(printf '%s' "${ready_body:-}" | grep -o '"referenceHeight":[0-9][0-9]*' | head -n1 | cut -d: -f2)"
  ref_hash="$(printf '%s' "${ready_body:-}" | grep -o '"referenceHash":"[0-9a-fA-F]*"' | head -n1 | cut -d'"' -f4)"
  case "$ref_h" in ''|*[!0-9]*) ref_h="" ;; esac

  # NO REFERENCE IS THE NORMAL STATE UNTIL THE APP HALF SHIPS, so this lands dark and turns itself
  # on the day those fields appear. Said once per episode for the reason the rung below says its
  # cannot-tell once: a state repeated every 30 s is noise that trains an operator to skim.
  if [ -z "$ref_h" ] || [ -z "$ref_hash" ]; then
    if [ "$history_cannot_tell_logged" != "1" ]; then
      log "history check: no reference block on /api/ready (height=${ref_h:-absent}, hash=${ref_hash:+present}${ref_hash:-absent}), so nothing is compared and nothing is touched. Silent until this changes."
      history_cannot_tell_logged=1
    fi
    return 0
  fi

  ours_hash="$(zebra_block_hash "$name" "$ref_h")"
  if [ -z "$ours_hash" ]; then
    if [ "$history_cannot_tell_logged" != "1" ]; then
      log "history check: the reference says $ref_h but zebra did not give us a hash at that height, so nothing is compared. Silent until this changes."
      history_cannot_tell_logged=1
    fi
    return 0
  fi
  history_cannot_tell_logged=0

  # CASE-INSENSITIVE, inherited rather than rediscovered: chainIdentity.ts:94 already records that
  # sources differ on hex case and that a case difference is not a fork.
  lower_ours="$(printf '%s' "$ours_hash" | tr '[:upper:]' '[:lower:]')"
  lower_ref="$(printf '%s' "$ref_hash" | tr '[:upper:]' '[:lower:]')"
  if [ "$lower_ours" = "$lower_ref" ]; then alerted_history_fork=0; return 0; fi

  # PROOF. Same order as the rung below - marker first, then the page - and the page describes what
  # is TRUE by reading the marker back rather than trusting the write.
  if [ ! -f "$FORK_PARK_MARKER" ]; then
    mkdir -p "$FORK_PARK_DIR" 2>/dev/null
    if printf '%s history fork: at height %s ours %s, the independent reference %s\n' \
         "$(date -u +%FT%TZ)" "$ref_h" "$ours_hash" "$ref_hash" >> "$FORK_PARK_MARKER" 2>/dev/null; then
      log "wrote $FORK_PARK_MARKER; auto-deploy will refuse to start $MINER_UNIT until a human clears it"
    else
      log "ERROR: could not write $FORK_PARK_MARKER, so auto-deploy will NOT refuse to start $MINER_UNIT"
    fi
  fi

  # AND IT CARRIES SYSTEMD'S OWN WORD, like the rung twelve lines down (SDE-UI, review). My first
  # version said only "still running", which is the #571 -> #618 flattening reintroduced one
  # function along: three rounds established that a unit reported `activating` must not be
  # described to an operator as though it were `active`, and this rung undid it in the next PR.
  # Nobody caught it because nothing drove a running miner through this page - the absence of a
  # `systemctl stop` CALL was asserted and the presence of the stop INSTRUCTION was not.
  stop_first=""
  hist_word="$(systemctl is-active "$MINER_UNIT" 2>/dev/null)" || true
  if miner_unit_is_running "$hist_word"; then
    stop_first="The miner unit is still running (systemd says ${hist_word}) and extending this chain: stop it by hand FIRST (systemctl stop $MINER_UNIT). "
  fi
  if [ -f "$FORK_PARK_MARKER" ]; then
    park="${stop_first}A park marker is written ($FORK_PARK_MARKER): no deploy and no watchdog heal will START the miner while that file exists."
  else
    park="${stop_first}THE MINER IS NOT PARKED: $FORK_PARK_MARKER could not be written, so the next auto-deploy tick WILL start the miner again. Stop the miner by hand first."
  fi

  if [ "$alerted_history_fork" = "0" ]; then
    danger "at height $ref_h our node has block $ours_hash and an independent source has $ref_hash. Same height, different block: we are on a different chain, and this is PROOF rather than the ahead-by-N evidence the other check uses. $park Nothing has been rewound: a drop of the non-finalized state only reaches ~100 blocks and cannot undo a split at depth. WHAT TO DO: reimport a snapshot per SNAPSHOTS.md, then clear the marker per OPERATIONS.md once the node is back on the network's chain."; rc=$?
    paged "$rc" && alerted_history_fork=1
  fi
  return 0
}

heal_self_mined_fork() {
  local name="$1" blocks corr used_h ahead miner_word started_age who mins hosh_h lwd_h spread spread_s spb agree_b
  [ "$FORK_HEAL_ENABLED" = "1" ] || return 0
  [ -n "$name" ] || return 0

  # THE SWEEP'S ONE HEIGHT READING, handed in rather than fetched. Empty means zebra did
  # not answer, and no answer is steps 1-2's business, never evidence of a fork.
  blocks="${2%% *}"
  case "$blocks" in ''|*[!0-9]*) return 0 ;; esac

  # THE SAME GATE STEP 7 USES, called rather than copied. It was copied, and the copy in
  # step 7 was a different field; one definition is the fix for that, not two careful ones.
  used_h="$(corroborated_tip_height)"

  if [ -z "$used_h" ]; then
    # Read again for the MESSAGE only - the decision above has already been made - so the
    # line can say which of the three cannot-tell shapes this was.
    corr="$(printf '%s' "${ready_body:-}" | grep -o '"corroborated":[a-z]*' | head -n1 | cut -d: -f2)"
    used_h="$(printf '%s' "${ready_body:-}" | grep -o '"usedHeight":[0-9][0-9]*' | head -n1 | cut -d: -f2)"
    case "$used_h" in ''|*[!0-9]*) used_h="" ;; esac
    # An absent field reads the same as a null one here, on purpose: a body that predates
    # #559 must not be turned into a height by this function, and "no number" is never 0.
    # WHAT THE TWO SOURCES ACTUALLY SAID (#600 step 3). "cannot tell" names the verdict and not
    # the evidence, so an operator reading the journal has to go to the app to find out whether
    # the references disagreed or one of them was simply absent - and #600 is about this line
    # firing often. Both heights and the spread are FLAT on /api/ready for exactly this reader
    # (SDE-App, #630): `sources.hosh.height` is two levels down and a brace-bounded grep for it
    # is the #391 greedy-match trap, which is why `usedHeight` was flattened first.
    #
    # NULL MEANS NEVER ANSWERED, NOT STALE. A stale source keeps the height it last reported and
    # is excluded by `used`, so "hosh=4349918" beside "highest usable reference=none" is a
    # reference that answered and is not trusted - a different fact from "hosh=none", which is a
    # reference that has not answered at all. The line has to be readable as those two states
    # rather than collapsing them, because only the first says anything about the chain.
    hosh_h="$(printf '%s' "${ready_body:-}" | grep -o '"hoshHeight":[0-9][0-9]*' | head -n1 | cut -d: -f2)"
    lwd_h="$(printf '%s' "${ready_body:-}" | grep -o '"lightwalletdHeight":[0-9][0-9]*' | head -n1 | cut -d: -f2)"
    spread="$(printf '%s' "${ready_body:-}" | grep -o '"spreadBlocks":[0-9][0-9]*' | head -n1 | cut -d: -f2)"
    # AND IN THE UNIT THAT NOW DECIDES (#600 step 3, after step 2 landed). Since #651 the app
    # judges agreement on spreadSeconds, not on a block count, so a line naming only blocks
    # cannot be used to reproduce the verdict: 32 blocks is inside tolerance at one cadence
    # and far outside it at another. secondsPerBlock is a DECIMAL, unlike every other number
    # here - a [0-9]* grep silently truncates 32.26 to 32 and the three figures stop
    # reconciling, which is the "500 x 0 is not 200" bug one file over.
    spread_s="$(printf '%s' "${ready_body:-}" | grep -o '"spreadSeconds":[0-9][0-9]*' | head -n1 | cut -d: -f2)"
    spb="$(printf '%s' "${ready_body:-}" | grep -o '"secondsPerBlock":[0-9][0-9.]*' | head -n1 | cut -d: -f2)"
    agree_b="$(printf '%s' "${ready_body:-}" | grep -o '"agreeBlocks":[0-9][0-9]*' | head -n1 | cut -d: -f2)"
    case "$hosh_h" in ''|*[!0-9]*) hosh_h="" ;; esac
    case "$lwd_h"  in ''|*[!0-9]*) lwd_h=""  ;; esac
    case "$spread" in ''|*[!0-9]*) spread="" ;; esac
    case "$spread_s" in ''|*[!0-9]*) spread_s="" ;; esac
    case "$spb" in ''|*[!0-9.]*) spb="" ;; esac
    case "$agree_b" in ''|*[!0-9]*) agree_b="" ;; esac
    # ONCE PER EPISODE, not once per sweep (CTO red-team, finding 7): a single-sourced oracle,
    # an unreachable app or a body from before #559 is a STATE, and one line every 30 s for as
    # long as it lasts is the shape this file already refuses elsewhere (miner_waiting_logged).
    if [ "$fork_cannot_tell_logged" != "1" ]; then
      log "fork check: cannot tell, so nothing is paged and nothing is touched (corroborated=${corr:-absent}, highest usable reference=${used_h:-none}, ours $blocks; hosh=${hosh_h:-none}, lightwalletd=${lwd_h:-none}, spread=${spread:-unknown}b/${spread_s:-unknown}s at ${spb:-unknown}s a block, tolerance ${agree_b:-unknown}b). Silent until this changes."
      fork_cannot_tell_logged=1
    fi
    return 0
  fi

  fork_cannot_tell_logged=0
  ahead=$(( blocks - used_h ))
  # AND THE WAY BACK TO ZERO (SDE-App, review of #560). Every other alert flag in this script
  # has one and this did not, so the rung would have paged once per watchdog PROCESS and gone
  # quiet for ever - a channel that dies after first use, which is the shape that let an
  # internet-reachable wallet RPC sit through 36 nightly audits.
  #
  # Reset here, on a DEFINITE not-a-fork, and not on the cannot-tell branch above: two
  # sources agreeing that we are NOT ahead is the same standard the rung uses to act, while
  # resetting on cannot-tell would let a flapping oracle re-page on every swing - exactly
  # what the corroboration gate exists to stop.
  if [ "$ahead" -le "$FORK_AHEAD_BLOCKS" ]; then alerted_fork=0; return 0; fi

  # ATTRIBUTION, SEPARATELY FROM DETECTION. The fork is established by the heights; who
  # built it is a different question, and the answer changes what the page tells a human to
  # look at. The miner's own heartbeat is the witness rather than the unit's state, because
  # a unit can be active with a wedged process that has templated nothing for hours.
  miner_word="$(systemctl is-active "$MINER_UNIT" 2>/dev/null)" || true
  started_age="$(ts_age "$(hb_field startedAt)")"
  local age_said="unreadable"; [ -n "$started_age" ] && age_said="${started_age}s"
  # "activating" IS a unit that is about to extend this chain (red-team, same review): keying the
  # stop line on the word being exactly "active" left a starting miner with no instruction at all.
  local miner_running=0
  miner_unit_is_running "$miner_word" && miner_running=1
  if [ "$miner_running" = "1" ] && [ -n "$started_age" ] && [ "$started_age" -gt "$FORK_MINER_MIN_SECS" ]; then
    mins=$(( started_age / 60 ))
    who="our miner is ${miner_word} and its heartbeat says it started ${mins} min ago, so this chain is most likely ours"
  elif [ "$miner_running" = "1" ]; then
    # ONE SUBSTITUTION, NOT TWO GLUED TOGETHER (CTO red-team, review of #560 r3). My fix for
    # "unreadables" emitted BOTH halves when the variable was set - ${v:+...}${v:-...} is not an
    # if/else, it is two expansions, and 120 rendered as "120s120". Computed once, above.
    who="our miner is ${miner_word} but its heartbeat cannot show it has been running long (startedAt age: ${age_said}), so what built $ahead blocks is unexplained"
  else
    who="our miner is ${miner_word:-not running}, so what built $ahead blocks is unexplained"
  fi

  # THE MARKER BEFORE THE PAGE, and a failure to write it is its own sentence: without the
  # file, auto-deploy does NOT refuse, and a human reading a page that says "parked" while
  # nothing is parked is worse off than one who knows the park failed.
  if [ ! -f "$FORK_PARK_MARKER" ]; then
    mkdir -p "$FORK_PARK_DIR" 2>/dev/null
    if printf '%s fork: ours %s, highest corroborated reference %s, ahead %s. %s\n' \
         "$(date -u +%FT%TZ)" "$blocks" "$used_h" "$ahead" "$who" >> "$FORK_PARK_MARKER" 2>/dev/null; then
      log "wrote $FORK_PARK_MARKER; auto-deploy will refuse to start $MINER_UNIT until a human clears it"
    else
      log "ERROR: could not write $FORK_PARK_MARKER, so auto-deploy will NOT refuse to start $MINER_UNIT"
    fi
  fi
  # THE PAGE DESCRIBES WHAT IS TRUE, NOT WHAT WAS ATTEMPTED. Read the marker back rather
  # than trusting the write: a page that says "the miner is parked" while the file is
  # missing would send a human away calm from the one state that needs them, and a failed
  # mkdir on /var/lib is exactly the kind of thing that happens on a full disk.
  #
  # AND "PARKED" IS NOT WHAT A MARKER DOES TO A RUNNING MINER (CTO red-team, finding 2). The
  # rung does not stop the miner - that is the ruling - and the marker gates STARTS only. So
  # over an ACTIVE unit the old wording described a state nobody was in: the box keeps
  # extending the private chain at ~10 blocks a minute while the page says it is parked, and
  # the one command the 2026-09-15 record puts first was missing from the list. The active
  # case now leads with the stop.
  local park stop_first=""
  [ "$miner_running" = "1" ] && stop_first="The miner unit is still running (systemd says ${miner_word}) and extending this chain: stop it by hand FIRST (systemctl stop $MINER_UNIT). "
  if [ -f "$FORK_PARK_MARKER" ]; then
    park="${stop_first}A park marker is written ($FORK_PARK_MARKER): no deploy and no watchdog heal will START the miner while that file exists."
  else
    park="${stop_first}THE MINER IS NOT PARKED: $FORK_PARK_MARKER could not be written, so the next auto-deploy tick WILL start the miner again. Stop the miner by hand first."
  fi

  if [ "$alerted_fork" = "0" ]; then
    danger "our node is $ahead blocks AHEAD of the highest reference two independent sources agree on (ours $blocks, reference $used_h). That is our own chain, not the network's. $who. $park Nothing has been rewound: a drop of the non-finalized state only reaches ~100 blocks and cannot undo this. WHAT TO DO: confirm with an explorer (compare getblockhash at $used_h), then reimport a snapshot per SNAPSHOTS.md, then clear the marker per OPERATIONS.md once the node is back on the network's chain."; rc=$?
    paged "$rc" && alerted_fork=1
  fi
  return 0
}

while true; do
  ticks=$((ticks + 1))
  wd_clock_tick
  zebra="$(find_container "$ZEBRA_MATCH")"
  zallet="$(find_container "$ZALLET_MATCH")"
  faucet="$(find_container "$FAUCET_MATCH")"
  signal="$(find_container "$SIGNAL_MATCH")"
  caddy="$(find_container "$CADDY_MATCH")"

  # 1 + 2: keep restart policy set and bring back anything that fell over. The bridge is
  # in this list because it is the thing the FIXED for its own recovery travels through;
  # caddy because it is the thing every visitor travels through.
  for c in "$zebra" "$zallet" "$faucet" "$signal" "$caddy"; do
    ensure_restart_policy "$c"
    recover_if_down "$c"
  done

  # 3: web-app liveness. Only restart when the container claims to be running
  # but the app has stopped answering - a genuine hang, not a cold start.
  #
  # ASKED IN THE CONTAINER, NOT THROUGH THE EDGE (risk register II, R-15). The compose
  # file gives the faucet a healthcheck that fetches /api/health on loopback, and docker
  # runs it every 30 s with three retries. When it is there, its verdict is the liveness verdict:
  # `unhealthy` is the app not answering its own port, which a restart addresses.
  # The public URL used to be the probe, and OBSERVABILITY.md tells the operator to
  # point it through caddy, so a caddy, TLS or DNS fault read as a hung app and the
  # watchdog restarted a healthy faucet every 90 s for as long as the edge was down,
  # wiping the in-memory send log, the tip cache and the chain-identity cache each time,
  # and paging about the wrong thing. A container with no healthcheck (one run by hand
  # outside compose, or a dev box) keeps the URL probe, and `starting` (inside docker's
  # start_period) counts as neither, since a cold start is not a hang. The cost: a
  # genuinely hung app is restarted about three minutes in (docker's three retries,
  # then three sweeps here) rather than 90 s, and an edge fault is paged by readiness
  # at the 30-minute grace with its transport class, rather than mis-paged at 3 min.
  if [ -n "$faucet" ] && [ "$(docker inspect -f '{{.State.Status}}' "$faucet" 2>/dev/null)" = "running" ]; then
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$faucet" 2>/dev/null)"
    case "$health" in
      healthy)   answering=1; liveness_via="docker health" ;;
      unhealthy) answering=0; liveness_via="docker health" ;;
      starting)  answering=2; liveness_via="docker health" ;;
      *)         liveness_via="$FAUCET_URL/api/health"
                 if curl -fsS --max-time 5 "$FAUCET_URL/api/health" >/dev/null 2>&1; then answering=1; else answering=0; fi ;;
    esac
    if [ "$answering" = "2" ]; then
      log "faucet liveness: container health is 'starting', not counted either way"
    elif [ "$answering" = "1" ]; then
      # The one report, and only now: it has been SEEN answering again after a restart.
      if [ "$faucet_restarts" -gt 0 ]; then
        fixed "faucet app hung. Restarted it ($faucet_restarts time(s)); answering again."
      fi
      faucet_misses=0; faucet_restarts=0; alerted_faucet_app=0
    else
      faucet_misses=$((faucet_misses + 1))
      log "faucet liveness miss $faucet_misses/$FAUCET_FAIL_LIMIT (via $liveness_via)"
      if [ "$faucet_misses" -ge "$FAUCET_FAIL_LIMIT" ]; then
        faucet_restarts=$((faucet_restarts + 1))
        log "restarting hung $faucet (restart $faucet_restarts this episode); report follows once it answers"
        docker restart "$faucet" >/dev/null 2>&1 || log "docker restart failed for $faucet"
        faucet_misses=0
        # A second restart with no healthy sweep in between is a loop, not a fix: page once
        # there, then only periodically, the same shape as the container crash-loop page.
        # AT OR PAST TWO AND NOT YET DELIVERED, rather than AT exactly two (#511). The threshold
        # page is retried every sweep until one leaves; the periodic re-alert keeps its cadence.
        # Unlike the crash-loop and readiness pages after #507, this one was never gated on
        # delivery, so a failed send at restart 2 meant silence until restart 22 - and the only
        # other signal is step 4's NOT READY page thirty minutes later.
        if { [ "$faucet_restarts" -ge 2 ] && [ "$alerted_faucet_app" = "0" ]; } \
           || { [ "$faucet_restarts" -gt 2 ] && [ $(( (faucet_restarts - 2) % 20 )) -eq 0 ]; }; then
          danger "faucet app not answering /api/health after $faucet_restarts restart(s). Not recovering."; rc=$?
          paged "$rc" && alerted_faucet_app=1
        fi
      fi
    fi
  fi

  # 4: readiness alerting. Not-ready is normal during first sync / refill, so we
  # only page when it persists past the grace window, and only once per episode.
  now="$(wd_now)"
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
  # Named by class, not only by number: the readiness page is the one place the edge is
  # probed through now (liveness is in-container, above), so "TLS handshake failed" or
  # "DNS lookup failed" is what tells the operator this is caddy or the certificate and
  # not the app (R-15).
  if [ "$ready_rc" -ne 0 ]; then
    case "$ready_rc" in
      6)  klass="DNS lookup failed" ;;
      7)  klass="connection refused, nothing is listening" ;;
      28) klass="timed out" ;;
      35) klass="TLS handshake failed" ;;
      51|60) klass="certificate rejected" ;;
      *)  klass="transport error" ;;
    esac
    reason="no answer from /api/ready (curl $ready_rc: $klass)"
  fi
  case "$ready_code" in 2*) ready_ok=1 ;; *) ready_ok=0 ;; esac
  # A 200 whose body says canBuildTx:false is a faucet that is serving and refusing every
  # drip: the send gate cannot verify the chain tip, so it fails closed, and /api/ready
  # keeps its 200 on purpose so an oracle blip cannot roll back a deploy. For PAGING it
  # is not ready. Nobody is getting coins, and before this line nobody was told.
  if [ "$ready_ok" = "1" ] && printf '%s' "$ready_body" | grep -q '"canBuildTx":false'; then
    ready_ok=0
    gate_reason="$(printf '%s' "$ready_body" | grep -o '"shield":{[^}]*}' | grep -o '"reason":"[^"]*"' | head -n1 | cut -d'"' -f4)"
    reason="drips refused: ${gate_reason:-the chain tip cannot be verified}"
  fi
  if [ "$ready_rc" -eq 0 ] && [ "$ready_ok" = "1" ]; then
    if [ "$alerted_unready" = "1" ]; then fixed "faucet is READY again."; fi
    unready_since=0
    alerted_unready=0
    sends_failing_since=0
  else
    [ "$unready_since" = "0" ] && unready_since="$now"
    elapsed=$((now - unready_since))
    if [ "$elapsed" -ge "$READY_GRACE_SECS" ] && [ "$alerted_unready" = "0" ]; then
      danger "faucet NOT READY for $((elapsed / 60)) min. Reason: ${reason:-unknown}."; rc=$?
      paged "$rc" && alerted_unready=1
    fi
    # 4b: SENDS FAILING → one zallet restart (R-18). Keyed on the app's own readiness
    # reason, "sends failing: ..." (readiness.ts); since #531 a recipient the wallet
    # refuses is the visitor's 400 and never counts toward it, so this reason is the
    # wallet itself. Any other reason resets the clock, because a restart is only the
    # right move for this one shape. The restart time is on disk with the flap counts,
    # so a watchdog restart cannot hand out a second one inside the budget. -t 30: the
    # wallet is sqlite-backed and docker's default is 10 s before SIGKILL.
    case "$reason" in
      "sends failing"*)
        [ "$sends_failing_since" = "0" ] && sends_failing_since="$now"
        if [ $((now - sends_failing_since)) -ge "$SENDS_RESTART_AFTER" ] && [ -n "$zallet" ]; then
          last_restart="$(flap_get "sends.zallet_restart_at")"
          if [ $((now - last_restart)) -ge "$SENDS_RESTART_BUDGET" ]; then
            log "sends failing for $(( (now - sends_failing_since) / 60 )) min ($reason): restarting $zallet once (next allowed in $((SENDS_RESTART_BUDGET / 60)) min)"
            if docker restart -t 30 "$zallet" >/dev/null 2>&1; then
              flap_set "sends.zallet_restart_at" "$now"
            else
              # Not stamped, so a daemon that refuses the restart is asked again next
              # sweep, one log line each, rather than the episode losing its one try.
              log "docker restart failed for $zallet (budget not spent)"
            fi
          fi
        fi ;;
      *) sends_failing_since=0 ;;
    esac
  fi

  # 4a: THE SAME QUESTION ASKED SO A FLAPPING ANSWER CANNOT HIDE FROM IT. Counted, not timed:
  # sweeps and un-ready sweeps accumulate over a window and a good read cannot reset them. All four
  # keys are NUMERIC because flap_get sanitises anything that is not all digits to 0 - a compound
  # value read back as 0 across a process boundary is a defect I have already shipped once.
  fw_start="$(flap_get ready.flap_start)"
  # A start in the FUTURE is what a restart reads back after the clock is corrected BACKWARDS, and
  # then now - fw_start is negative: the window never closes and this rung says nothing until wall
  # time catches up, which for an NTP step of an hour is an hour. The continuous rung re-arms itself
  # on the next good read; this one has no such path, so it needs the guard and that rung does not.
  # A check that reports by silence cannot be told apart from one that was never wired in.
  if [ "$fw_start" = "0" ] || [ "$now" -lt "$fw_start" ]; then fw_start="$now"; flap_set ready.flap_start "$now"; fi
  fw_sweeps=$(( $(flap_get ready.flap_sweeps) + 1 ))
  fw_unready="$(flap_get ready.flap_unready)"
  if [ "$ready_rc" -eq 0 ] && [ "$ready_ok" = "1" ]; then
    :
  else
    fw_unready=$((fw_unready + 1))
    fw_last_reason="${reason:-unknown}"
  fi
  flap_set ready.flap_sweeps "$fw_sweeps"
  flap_set ready.flap_unready "$fw_unready"
  if [ $((now - fw_start)) -ge "$READY_FLAP_WINDOW_SECS" ]; then
    fw_pct=0
    [ "$fw_sweeps" -gt 0 ] && fw_pct=$(( fw_unready * 100 / fw_sweeps ))
    if [ "$fw_sweeps" -ge "$READY_FLAP_MIN_SWEEPS" ] && [ "$fw_pct" -ge "$READY_FLAP_PCT" ]; then
      # ONE EVENT, ONE PAGE. A continuous outage trips this too - it is 100% of the window - and the
      # rung above has already said so in the words that fit it. This one speaks only for the shape
      # that rung cannot see, so it stays quiet when that page is already standing.
      if [ "$alerted_unready" = "0" ] && [ "$(flap_get ready.flap_paged)" != "1" ]; then
        danger "faucet NOT READY on $fw_unready of the last $fw_sweeps checks ($fw_pct%) over $((READY_FLAP_WINDOW_SECS / 60)) min. It recovers between checks, so it never trips the $((READY_GRACE_SECS / 60))-minute continuous alarm - and it is refusing that share of visitors meanwhile. Last un-ready reason: ${fw_last_reason:-unknown}."; rc=$?
        paged "$rc" && flap_set ready.flap_paged 1
      fi
    # THE SAME SAMPLE RULE, APPLIED TO THE GOOD NEWS. A window too small to have revealed a flap
    # is too small to clear one, and this file exists because 812 "recovered" alerts were sent for a
    # container that was never up. Neither page nor un-page: the counters reset and the next full
    # window says something true. A steady faucet is still announced, one window later.
    elif [ "$fw_sweeps" -ge "$READY_FLAP_MIN_SWEEPS" ] && [ "$(flap_get ready.flap_paged)" = "1" ]; then
      fixed "faucet readiness is steady again ($fw_unready of $fw_sweeps checks un-ready in the last $((READY_FLAP_WINDOW_SECS / 60)) min)."
      flap_set ready.flap_paged 0
    fi
    flap_set ready.flap_start "$now"
    flap_set ready.flap_sweeps 0
    flap_set ready.flap_unready 0
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
  # STEP 5b: THE SAME POISON IN ITS QUIET FORM, NOTICED AND NOT ACTED ON (#601 step 4).
  #
  # Zallet asks zebra for transactions it is tracking on every new block. For one it can no longer
  # fetch, the answer used to be classified UNRECOVERABLE and the process exited - that is the
  # crash-loop the rung below heals. On the current build the same condition comes back as
  # "(will retry)" and nothing exits. The wallet keeps up, readiness is true, no drip is refused,
  # and three failed RPCs a block go on for ever with nothing in the system aware of it.
  #
  # WHY THIS ONLY WRITES A JOURNAL LINE, which is a decision the issue asked for rather than an
  # omission. This file has exactly two kinds of message and says why: one report per RESOLVED
  # episode, and one page when it cannot fix something. This is neither. It is not an outage - a
  # page marked NEEDS YOU for three wasted RPCs a block trains a reader to stop looking at the
  # channel, which is the cost that comment is about.
  #
  # AND IT DELIBERATELY DOES NOT HEAL. The repair tools rewrite wallet.db. Running them against a
  # wallet that is working, to save three RPCs a block, is the more dangerous of the two options -
  # the same argument the give-up branch below already makes for the crashing case. If this state
  # is ever to be cleared it should be a human with the read-only look first.
  #
  # ONCE PER EPISODE, ON DISK. The condition is measured in DAYS, and the watchdog restarts on
  # every deploy - so a shell flag would re-announce it every deploy and teach the reader the line
  # is noise. flap state outlives the process, which is the lifetime this state actually has.
  if [ -n "$zallet" ]; then
    # AND THE POINTER IS RUNNABLE WHERE IT IS READ. It said `deploy/z3/zallet-...`, a repo-relative
    # path, and this line is read through journalctl from wherever the operator is standing - the
    # checkout is /opt/zcash-faucet and /opt/faucet is the install dir, so the obvious guess is the
    # wrong one. HEAL_TOOLS_DIR is where this file already looks for those tools, so it is correct
    # on any box by construction and carries no literal path.
    # ANCHORED TO THE POISON, NOT TO THE WORDS "will retry" (SDE-App, review of #644). Counting any
    # line carrying that phrase counts a peer backoff or an ordinary RPC retry, and the note then
    # asserts "zallet retried unfetchable transactions N times" and sends the reader to
    # zallet-abandon-expired-txs.sh - a false sentence pointing at the wrong tool. One regex over
    # the pair works because "will retry" comes BEFORE the sentence on the real line.
    retry_n="$(docker logs --since "$RETRY_WINDOW" "$zallet" 2>&1 | grep -cE "will retry.*($ZALLET_POISON_RE)" || true)"
    case "$retry_n" in ''|*[!0-9]*) retry_n=0 ;; esac
    if [ "$retry_n" -ge "$RETRY_MIN" ]; then
      if [ "$(flap_get zallet.retryloop)" != "1" ]; then
        log "note: zallet retried unfetchable transactions $retry_n times in the last $RETRY_WINDOW. Nothing is refused and the wallet is keeping up, so this is not being healed: the repair tools rewrite wallet.db and this wallet is working. Read it with \`bash $HEAL_TOOLS_DIR/zallet-abandon-expired-txs.sh --read-only\` before deciding (#601)."
        flap_set zallet.retryloop 1
      fi
    elif [ "$(flap_get zallet.retryloop)" = "1" ]; then
      log "zallet is no longer retrying unfetchable transactions ($retry_n in the last $RETRY_WINDOW)"
      flap_set zallet.retryloop 0
    fi
  fi

  if [ -n "$zallet" ] && [ "$HEAL_ENABLED" = "1" ]; then
    # BOTH PHRASINGS, BECAUSE THE WALLET HAS CHANGED ITS WORDS (#601). This matched one literal
    # string. The owner's log of 2026-09-16 shows the current build answering the same condition -
    # code -5, a transaction that is in neither the mempool nor the chain - as
    #     RPC Error (code: -5): Transaction not found in mempool or best chain
    # which this grep does not match. That wording appears NOWHERE in this repo; the watchdog, the
    # suite that pins it and all three repair tools know only the older sentence.
    #
    # THE FAILURE IS SILENT IN BOTH DIRECTIONS, which is why it is worth widening rather than
    # waiting for certainty. A signature this cannot see is a poison episode the heal never runs
    # for; and because the ABSENCE of the line while zallet runs is what proves a heal worked, an
    # unrecognised wording also reads as permanently clean. The 2026-08-17 episode this rung exists
    # for was 162 restarts and about ten hours of a gated faucet.
    #
    # WHAT I DO NOT KNOW, said here rather than implied: the log I am going by is the RETRY form,
    # which does not crash. Whether the crash path on this build emits the old sentence or the new
    # one has not been observed. Matching both costs nothing and removes the question.
    #
    # NOT MATCHING BARE `code: -5`: other -5s are ordinary (an unknown address, a bad txid) and
    # healing on those would rewrite wallet.db for a typo. If zallet changes the words a third
    # time, add the phrase here - the repo suite pins both of these so a silent drop is caught.
    # AND THE RETRY LINES ARE EXCLUDED, which widening the match made necessary. The quiet form
    # (step 5b above) carries the SAME sentence with "(will retry)" on it - so without this filter
    # the heal would fire on a wallet that is working and keeping up, stop it, and rewrite
    # wallet.db to save three RPCs a block. That is the regression the widening would otherwise
    # have introduced, and it is worse than the blindness it fixes. What this rung is for is the
    # FATAL classification: the same condition with no retry, which is what kills the process.
    if docker logs --tail 40 "$zallet" 2>&1 | grep -v "will retry" \
         | grep -qE "$ZALLET_POISON_RE"; then
      if [ "$heal_attempts" -ge "$HEAL_MAX_ATTEMPTS" ]; then
        if [ "$alerted_heal_giveup" = "0" ]; then
          danger "zallet poison persists after $heal_attempts repairs. Not retrying. Reason: ${reason:-unknown}."; rc=$?
          paged "$rc" && alerted_heal_giveup=1
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
            # THE WHOLE OUTPUT REACHES THE JOURNAL, not the last three lines. These tools print
            # the backup path and the `to undo:` block in the MIDDLE of the run, before the delete,
            # so `tail -3` kept the sign-off and threw away the only record of which backup exists
            # and how to put it back - on the one path that runs them unattended, which is the path
            # they were written for. Measured before changing it: 22 lines in, 3 out.
            # Logged line by line rather than pattern-matched, deliberately. A grep for `to undo:`
            # here would make the watchdog depend on the tools' output format, and a tool that
            # renamed that line would go quiet without failing - the same silence, one layer up.
            # This file is `set -uo pipefail` with no -e, so a repair tool exiting non-zero does not
            # abort the sweep; dropping the pipeline does not change that.
            tool_out="$(bash "$HEAL_TOOLS_DIR/$tool" 2>&1)"
            [ -n "$tool_out" ] && printf '%s\n' "$tool_out" | while IFS= read -r ln; do log "  $tool: $ln"; done
            heal_out="$heal_out $(printf '%s\n' "$tool_out" | tail -3 | tr '\n' ' ')"
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

  # 6b: THE MINER IS ALIVE, TEMPLATING, AND COMPLETING NOTHING. Separate from step 6 on purpose:
  # that rung heals, this one only says. A restart cannot fix a miner whose work is being invalidated
  # from outside, and an auto-healer thrashing it every few minutes would bury the signal under its
  # own noise.
  miner_completing_nothing

  # 6: miner stall recovery. Independent of the faucet's readiness - the miner funds the
  # reserve but a stalled miner does not gate drips, so this runs every sweep on its own
  # signal (the heartbeat) rather than off /api/ready.
  heal_miner_if_stalled

  # ZEBRA'S HEIGHTS, ONCE, FOR BOTH RUNGS. Not an optimisation and not tidiness: asking
  # twice gave steps 7 and 8 different numbers, since the tip can move between two calls,
  # so one sweep could act on two different worlds. It also doubled the RPC load on a node
  # whose RPC thread is already starved by its own miner (16-45 s recency answers). And
  # reading it HERE rather than inside step 7 keeps the two rungs independent: step 7 is
  # switchable off (WATCHDOG_NODE_HEAL_ENABLED=0) and fork detection must not switch off
  # with it. The suite found the double read the blunt way - the zebra stub advances the
  # height once per CALL, so a second caller doubled every step-7 case's sync progress and
  # 22 of them failed at once.
  zebra_heights="$(zebra_chain_heights "$zebra")"

  # 7: node sync-stall recovery. Reads zebra directly, so it is independent of whether the
  # watchdog can reach the app, and acts only on behind-AND-stuck.
  heal_node_if_stalled "$zebra" "$zebra_heights"

  # 8: a self-mined fork. AFTER step 7, because the two are opposite directions and step 7
  # may have just restarted the node; reads this sweep's /api/ready body (fetched in 4) and
  # zebra directly.
  heal_self_mined_fork "$zebra" "$zebra_heights"
  check_history_against_reference "$zebra"

  # Bounded only under test. Production leaves MAX_TICKS at 0 and never exits,
  # and the sleep is skipped on the final tick so a suite is not paying for it.
  if [ "$MAX_TICKS" -gt 0 ] && [ "$ticks" -ge "$MAX_TICKS" ]; then
    break
  fi
  sleep "$INTERVAL"
done

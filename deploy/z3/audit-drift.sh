#!/usr/bin/env bash
# Reports where this box and the repo disagree. Read-only, no --apply: see the
# Config drift section of OPERATIONS.md for why, and for the exit codes.
set -uo pipefail

REPO_DIR="${AUDIT_REPO_DIR:-/opt/zcash-faucet}"
OVERLAY_DIR="${AUDIT_OVERLAY_DIR:-$REPO_DIR/deploy/z3}"
UNIT_DIR="${AUDIT_UNIT_DIR:-/etc/systemd/system}"
INSTALL_DIR="${AUDIT_INSTALL_DIR:-/opt/faucet}"
ENV_DIR="${AUDIT_ENV_DIR:-/etc/faucet}"
# Injectable so tests can simulate a host without systemd hermetically,
# rather than by manipulating PATH on a runner that has it.
SYSTEMCTL="${AUDIT_SYSTEMCTL:-systemctl}"
VERBOSE=0
[ "${1:-}" = "--verbose" ] && VERBOSE=1

drift=0
# A skipped check must never read as a passed one, so these force exit 2.
unverified=""
note_unverified() { unverified="${unverified}${unverified:+
}  - $1"; }
say()   { echo "$*"; }
ok()    { [ "$VERBOSE" = "1" ] && echo "  ok       $*"; return 0; }
# $2 is the fix command, optional where the fix is a judgement call.
found() {
  drift=1
  echo "  DRIFT    $1"
  [ -n "${2:-}" ] && echo "           fix: $2"
  return 0
}
note()  { echo "  note     $*"; }

[ -d "$OVERLAY_DIR" ] || { echo "cannot audit: no overlay dir at $OVERLAY_DIR (set AUDIT_REPO_DIR)"; exit 2; }
have_systemctl=1
if ! command -v "$SYSTEMCTL" >/dev/null 2>&1; then
  have_systemctl=0
  note_unverified "whether any unit is ENABLED: no systemctl on this host, so reboot-survival was not checked"
fi

say "auditing $(hostname 2>/dev/null || echo this box) against $REPO_DIR"
say ""

# Installed, matching, and enabled. A disabled unit is drift: it dies at reboot.
say "systemd units the repo ships"
for src in "$OVERLAY_DIR"/*.service "$OVERLAY_DIR"/*.timer; do
  [ -e "$src" ] || continue
  unit="$(basename "$src")"
  installed="$UNIT_DIR/$unit"
  if [ ! -f "$installed" ]; then
    found "$unit is not installed in $UNIT_DIR" \
      "cp $OVERLAY_DIR/$unit $UNIT_DIR/ && systemctl daemon-reload && systemctl enable --now $unit"
    continue
  fi
  if cmp -s "$src" "$installed"; then
    ok "$unit installed and matches the repo"
  else
    found "$unit differs from the repo copy" \
      "diff $src $installed   # then either cp the repo copy over it, or commit the box's version"
  fi
  if [ "$have_systemctl" = "1" ]; then
    if "$SYSTEMCTL" is-enabled --quiet "$unit" 2>/dev/null; then
      ok "$unit is enabled"
    else
      found "$unit is installed but NOT enabled, so it will not survive a reboot" \
        "systemctl enable --now $unit"
    fi
  fi
done
say ""

# Union of two signals, because each misses what the other catches: the repo's
# own unit names (so a rename cannot fall outside a prefix list) and our
# conventions (so a hand-installed unit the repo never had is still seen).
ours_re="$(for f in "$OVERLAY_DIR"/*.service "$OVERLAY_DIR"/*.timer; do
             [ -e "$f" ] && basename "$f"; done | paste -sd'|' -)"
in_repo()  { [ -n "$ours_re" ] && printf '%s' "$1" | grep -qxE "$ours_re"; }
is_ours() {
  in_repo "$1" && return 0
  local stem="${1%.*}"
  in_repo "$stem.service" || in_repo "$stem.timer" && return 0
  case "$1" in faucet-*|zsnap-*|zcash-*) return 0 ;; esac
  return 1
}

say "state on the box that the repo does not describe"
for installed in "$UNIT_DIR"/*.service "$UNIT_DIR"/*.timer; do
  [ -e "$installed" ] || continue
  unit="$(basename "$installed")"
  # A unit the repo ships is checked above. Anything else is only ours if it
  # shares a stem with something we ship, e.g. a hand-added faucet-x.timer
  # beside our faucet-x.service.
  in_repo "$unit" && continue          # already checked above
  is_ours "$unit" || continue
  [ -f "$OVERLAY_DIR/$unit" ] \
    || found "$unit is installed but the repo has no copy of it, so a rebuild loses it" \
         "cp $installed $OVERLAY_DIR/ && git -C $REPO_DIR add deploy/z3/$unit   # then commit it"
done
for dropin_dir in "$UNIT_DIR"/*.d; do
  [ -d "$dropin_dir" ] || continue
  unit="$(basename "$dropin_dir" .d)"
  # Drop-ins matter only for units we ship; the box has others of its own.
  is_ours "$unit" || continue
  for conf in "$dropin_dir"/*.conf; do
    [ -e "$conf" ] || continue
    found "drop-in $unit.d/$(basename "$conf") exists on the box and is not in the repo" \
      "fold its directives into $OVERLAY_DIR/$unit (or add the drop-in to the repo), then commit"
    # Allowlist: only KEY= lines print, so nothing can slip through a rule
    # that does not exist. Continuation lines and comments carry secrets too.
    if [ "$VERBOSE" = "1" ]; then
      sed -nE 's/^[[:space:]]*(Environment=[A-Za-z_][A-Za-z0-9_]*=).*/             | \1<redacted>/p
               t
               s/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=).*/             | \1<redacted>/p' "$conf"
    fi
  done
done
say ""

# --- compose overrides --------------------------------------------------------
say "compose overrides"
for f in "$OVERLAY_DIR"/docker-compose.override.y*ml "$OVERLAY_DIR"/*.override.y*ml; do
  [ -e "$f" ] || continue
  name="$(basename "$f")"
  if git -C "$REPO_DIR" ls-files --error-unmatch "deploy/z3/$name" >/dev/null 2>&1; then
    ok "$name is tracked in git"
  else
    found "$name is untracked, so a rebuild will not have it" \
      "git -C $REPO_DIR add deploy/z3/$name   # then commit it"
  fi
done
say ""

# A stale copy in $INSTALL_DIR means the box runs code nobody reviewed.
say "scripts in $INSTALL_DIR"
for src in "$OVERLAY_DIR"/*.sh; do
  [ -e "$src" ] || continue
  script="$(basename "$src")"
  installed="$INSTALL_DIR/$script"
  referenced=0
  grep -qs "$INSTALL_DIR/$script" "$OVERLAY_DIR"/*.service && referenced=1

  if [ ! -f "$installed" ]; then
    # Not installed is only drift when a unit expects to run it. An overlay
    # script nobody deployed is just not deployed.
    [ "$referenced" = "1" ] && found "$script is referenced by a unit but missing from $INSTALL_DIR" \
      "cp $src $INSTALL_DIR/ && chmod +x $installed"
    continue
  fi

  # It IS installed, so it has to match whether or not a .service names it.
  # Keying this off unit references meant the scripts a unit calls INDIRECTLY
  # were never compared: drift-report.sh runs audit-access.sh and
  # audit-drift.sh, so stale copies of the auditors themselves were invisible
  # to the auditor. The tool that reports staleness has to check itself.
  if cmp -s "$src" "$installed"; then
    ok "$script matches the repo"
  else
    found "$script in $INSTALL_DIR differs from the repo (the box is running unreviewed code)" \
      "diff $src $installed   # then cp the repo copy over it, or get the box's version reviewed"
  fi
done

# The other direction. The loop above walks the REPO, so it can only ask what the
# box did with each script we ship, and a script that exists ONLY on the box is
# invisible to it. That is the worst case of the two: entirely unreviewed code
# that a rebuild silently drops. Units and drop-ins are already checked both
# ways, so this is the missing symmetry rather than a new idea.
for installed in "$INSTALL_DIR"/*.sh; do
  [ -e "$installed" ] || continue
  script="$(basename "$installed")"
  [ -f "$OVERLAY_DIR/$script" ] \
    || found "$script is in $INSTALL_DIR but the repo has no copy of it, so a rebuild loses it" \
         "cp $installed $OVERLAY_DIR/ && git -C $REPO_DIR add deploy/z3/$script   # then commit it"
done
say ""

# These hold secrets, so presence only. Values are never read.
say "env files (presence only, values are never read)"
for f in "$ENV_DIR/watchdog.env" "$ENV_DIR/zsnap.env" "$ENV_DIR/backup.env" \
         "$ENV_DIR/metrics.env" "$ENV_DIR/miner.env" /etc/faucet-domain; do
  if [ -f "$f" ]; then
    ok "$f present"
  else
    note "$f absent (fine if the feature it configures is unused)"
  fi
done
say ""

# --- env completeness, both directions -----------------------------------------
#
# The app reads env vars the DEPLOYMENT never mentions, and that gap has cost us
# twice. FAUCET_MINER_ACTIVE gated the reserve loop and appeared nowhere in deploy/,
# so nobody reading the deployment could know it existed. Then FAUCET_SHIELD_COINBASE
# was added to faucet.env.example - and write_env only copies the example onto a
# FRESH box, so on an existing one the new line is inert forever. A key can
# therefore be missing in two independent ways, hence two checks:
#
#   repo side  the app reads a key the contract never declares -> invisible to
#              anyone reading the deployment rather than the source
#   box side   the contract declares a key the live faucet.env lacks (or holds a
#              placeholder for) -> documented but never delivered
#
# The contract is faucet.env.example PLUS the compose environment: block, because
# some keys are injected rather than operator-supplied and reporting those as
# missing would be noise that gets the whole check ignored.
say "env completeness (app reads vs deployment declares)"

CONFIG_TS="$REPO_DIR/src/lib/config.ts"
ENV_EXAMPLE="$OVERLAY_DIR/faucet.env.example"
COMPOSE="$OVERLAY_DIR/docker-compose.faucet.yml"
LIVE_ENV="$OVERLAY_DIR/faucet.env"

# Keys that legitimately need no declaration: pure tuning with a safe default, or
# belonging to a sender/database mode this deploy does not use. Anything that GATES
# BEHAVIOUR stays off this list - that is the whole point. Written out rather than
# pattern-matched so adding one is a visible, reviewable decision.
env_optional() {
  case "$1" in
    # injected by the framework, never by us: Next sets NEXT_RUNTIME itself, and
    # NEXT_PUBLIC_SITE_URL is inlined at build time. Declaring either in
    # faucet.env would be misleading rather than helpful.
    NEXT_RUNTIME|NEXT_PUBLIC_SITE_URL) return 0 ;;
    # alternate database backend, unused by the z3 deploy
    DB_BACKEND|D1_PROXY_URL|D1_PROXY_SECRET) return 0 ;;
    # a seed for a sender mode this deploy does not run
    FAUCET_WALLET_SEED) return 0 ;;
    # ZALLET_PASSPHRASE is NOT "a mode we do not run" - zallet IS our sender and
    # this key gates walletpassphrase. It is optional because the default is empty
    # and zalletsend skips unlocking when it is unset, which is the configuration
    # we actually run. Stating the real reason matters: a wrong justification in an
    # allowlist is how the next entry gets waved through on its coat-tails (SDE-App).
    ZALLET_PASSPHRASE) return 0 ;;
    # timeouts and poll intervals, all with defaults that work
    ZALLET_OP_TIMEOUT_MS|ZALLET_POLL_MS|ZALLET_RPC_TIMEOUT_MS|ZALLET_UNLOCK_SECONDS) return 0 ;;
    SEND_TASK_DEADLINE_MS|TX_LOOKUP_RATE_MAX|TX_LOOKUP_RATE_WINDOW_SECONDS) return 0 ;;
    # anti-abuse tuning; the MODE (FAUCET_CHALLENGE) is NOT optional, these knobs are
    FAUCET_POW_BITS|FAUCET_POW_ESCALATE_BITS|FAUCET_POW_MAX_BITS|FAUCET_POW_TTL_SECONDS) return 0 ;;
    *) return 1 ;;
  esac
}

if [ ! -d "$REPO_DIR/src" ]; then
  note_unverified "env completeness: no $REPO_DIR/src, cannot list what the app reads"
elif [ ! -f "$ENV_EXAMPLE" ]; then
  note_unverified "env completeness: no $ENV_EXAMPLE, cannot tell what the deployment declares"
else
  # Every env name the app reads, ANYWHERE under src/ - not just config.ts.
  #
  # Scanning only config.ts was this check's own false pass: it made the acceptance
  # test (FAUCET_MINER_ACTIVE, which lives in config.ts) succeed while the check was
  # blind to seven keys read elsewhere, including three thresholds added by #171 that
  # REFUSE TO BOOT on a bad value. It proved the mechanism while missing the
  # coverage, which is the same shape as every false pass we chased today, aimed at
  # the guard itself (SDE-App).
  # Test files are excluded, and that is a correctness fix rather than a
  # convenience. A test reads the environment for its OWN harness - the clearest
  # case is `env: { PATH: process.env.PATH }` when spawning a child - and PATH is
  # not deployment configuration. Left in, the check reported PATH as undeclared
  # on every box forever, and a check that always reports drift is a check people
  # learn to ignore. Verified against main: excluding tests drops exactly one key,
  # PATH, and keeps all six behaviour-gating ones (FAUCET_SHIELD_MAX_LAG_BLOCKS,
  # FAUCET_FREEZE_BLOCKS, FAUCET_TIP_STALL_MS, FAUCET_CHALLENGE, RATE_LIMIT_SALT,
  # HOSH_URL), so the coverage this check exists for is untouched.
  app_keys="$(grep -rhoE 'process\.env\.[A-Z_][A-Z0-9_]*|\b(num|str|bool|env)\("[A-Z_][A-Z0-9_]*"' \
      "$REPO_DIR/src" --include='*.ts' --include='*.tsx' \
      --exclude='*.test.ts' --exclude='*.test.tsx' 2>/dev/null \
    | grep -oE '[A-Z_][A-Z0-9_]{3,}' | sort -u)"
  # The contract is the set of keys actually ASSIGNED somewhere, not every key
  # NAMED somewhere. Matching raw text let a key mentioned only in a comment count
  # as declared - including comments that exist to explain why the key matters, so
  # documenting the problem would have silenced the check for it. Caught by removing
  # a key and watching the check stay quiet.
  #
  #   faucet.env.example   KEY=...  (a commented-out `# KEY=` still documents it)
  #   compose              `- KEY=` or `KEY:` inside an environment: block
  # One key per LINE, and compared whole-line below. Stripping the separators into a
  # single blob let `case *KEY*` match across a junction - FOO plus BARBAZ reading as
  # a declaration of OOBAR. No live false positive today, but it is the same
  # mentions-versus-assignments trap one level down, so it gets closed the same way
  # (SDE-App).
  contract="$(
    grep -oE '^[[:space:]]*#?[[:space:]]*[A-Z_][A-Z0-9_]*=' "$ENV_EXAMPLE" 2>/dev/null | sed 's/[#[:space:]=]//g'
    grep -oE '^[[:space:]]*-?[[:space:]]*[A-Z_][A-Z0-9_]*[:=]' "$COMPOSE" 2>/dev/null | sed 's/[-[:space:]:=]//g'
  )"

  # A key count of zero means the grep broke, not that the app reads nothing. Say so
  # rather than reporting a clean pass on an empty list.
  if [ -z "$app_keys" ]; then
    note_unverified "env completeness: found no env keys in $CONFIG_TS, which means the scan failed"
  else
    for key in $app_keys; do
      env_optional "$key" && continue
      # Whole-line match, so a key is only "declared" if it is declared, not merely
      # a substring of something else that is.
      printf '%s\n' "$contract" | grep -qxF "$key" && continue
      found "$key is read by the app but declared nowhere in the deployment, so an operator reading deploy/ cannot know it exists" \
            "add $key to $ENV_EXAMPLE (with its default and a one-line why), then commit"
    done

    # Box side. Only meaningful when the live file exists; on a machine that is not
    # the faucet host its absence is not drift.
    if [ -f "$LIVE_ENV" ]; then
      declared="$(grep -oE '^[[:space:]]*[A-Z_][A-Z0-9_]*=' "$ENV_EXAMPLE" | tr -d ' =' | sort -u)"
      for key in $declared; do
        line="$(grep -E "^[[:space:]]*$key=" "$LIVE_ENV" 2>/dev/null | head -n1)"
        if [ -z "$line" ]; then
          found "$key is declared in faucet.env.example but absent from $LIVE_ENV, so the box never received it" \
                "add $key= to $LIVE_ENV   # write_env only seeds the example on a FRESH box"
          continue
        fi
        value="${line#*=}"
        case "$(printf '%s' "$value" | tr 'A-Z' 'a-z')" in
          *__fill_me__*|*change-me*|*changeme*|*paste_the*|*replace_me*)
            found "$key in $LIVE_ENV still holds a placeholder value, which is as good as unset" \
                  "set a real value for $key in $LIVE_ENV" ;;
        esac
      done
    else
      note "$LIVE_ENV absent (not the faucet host, or a fresh box before first deploy)"
    fi
  fi
fi
say ""

# --- node stack versions -------------------------------------------------------
#
# The node and wallet images come from a third-party compose file beside ours, so
# with no override we inherit somebody else's default and the version our funds
# depend on never passes through review. stack-versions.env is that override and
# the reviewable record; this compares it against what is actually running, so a
# box that stops matching is reported rather than found during an incident (#247).
say "node stack versions (declared vs running)"

VERSIONS_FILE="${AUDIT_VERSIONS_FILE:-$OVERLAY_DIR/stack-versions.env}"
DOCKER="${AUDIT_DOCKER:-docker}"

# Reuse the container name substrings watchdog.sh and zsnap-export.sh already use
# rather than inventing a third naming scheme that can drift from those two.
stack_match() {
  case "$1" in
    Z3_ZEBRA_IMAGE)  echo zebra ;;
    Z3_ZALLET_IMAGE) echo zallet ;;
    Z3_ZAINO_IMAGE)  echo zaino ;;
  esac
}

# A reference can be repo:tag, repo@sha256:..., or repo:tag@sha256:... . Only the
# digest half is an identity; the tag half is a moveable label.
ref_digest() { case "$1" in *@sha256:*) printf 'sha256:%s\n' "${1##*@sha256:}" ;; *) printf '\n' ;; esac; }

if [ ! -f "$VERSIONS_FILE" ]; then
  note_unverified "stack versions: no $VERSIONS_FILE, so nothing records which node and wallet images we intend to run"
elif ! command -v "$DOCKER" >/dev/null 2>&1; then
  note_unverified "stack versions: no docker on this host, so running images were not compared against $VERSIONS_FILE"
else
  for key in Z3_ZEBRA_IMAGE Z3_ZALLET_IMAGE Z3_ZAINO_IMAGE; do
    match="$(stack_match "$key")"
    declared="$(grep -E "^[[:space:]]*$key=" "$VERSIONS_FILE" 2>/dev/null | head -n1)"
    declared="${declared#*=}"
    name="$("$DOCKER" ps --filter "name=$match" --format '{{.Names}}' 2>/dev/null | head -n1)"

    if [ -z "$declared" ]; then
      # An unpinned component is a gap rather than a pass, but only worth saying
      # when it is actually running. The overlay does not start zaino by default,
      # and a check that reports an absent optional component forever is one
      # people learn to ignore.
      [ -n "$name" ] && note_unverified "stack versions: $name is running but $key is not pinned in $VERSIONS_FILE, so nothing reviews its version"
      continue
    fi
    if [ -z "$name" ]; then
      found "$key pins $declared but no container matching '$match' is running" \
        "start the stack, or drop the pin if this component is no longer part of the deploy"
      continue
    fi
    running="$("$DOCKER" inspect -f '{{.Config.Image}}' "$name" 2>/dev/null)"
    declared_digest="$(ref_digest "$declared")"
    running_digest="$(ref_digest "$running")"
    if [ -z "$running" ]; then
      # Distinct from a mismatch on purpose: we did not learn that they differ,
      # we learned nothing, and those must not print the same way.
      note_unverified "stack versions: docker inspect returned nothing for $name, so $key was not compared"
    elif [ "$running" = "$declared" ]; then
      ok "$key matches: $running"
    elif [ -n "$declared_digest" ] && [ "$declared_digest" = "$running_digest" ]; then
      # Same bytes, different way of writing them. A digest identifies content, so
      # once two references carry the same one the tag text cannot disagree.
      ok "$key matches by digest: $declared_digest"
    elif [ -n "$declared_digest" ] && [ -z "$running_digest" ]; then
      # The interesting case, and the reason this is not a string compare. We pin a
      # digest because a tag can be re-pushed under us, but the container was created
      # from a plain tag, so .Config.Image records the tag and the two strings differ
      # while the image may be identical. Comparing text here would report drift on
      # every run and teach people to ignore the line.
      #
      # So ask what the image actually is. RepoDigests is what the registry served.
      repo_digests="$("$DOCKER" inspect -f '{{join .RepoDigests ","}}' "$running" 2>/dev/null)"
      if [ -z "$repo_digests" ]; then
        # A locally built or never-pushed image has no RepoDigests at all. We did not
        # learn that it differs, so this is not drift and not a pass.
        note_unverified "stack versions: $name runs $running, which has no registry digest, so it could not be compared against the digest $key pins"
      # Compared as the whole field after the '@', not as a substring. A digest is
      # fixed length so a substring match would almost always be right, and "almost
      # always" is not what this line is for.
      elif printf '%s' "$repo_digests" | tr ',' '\n' |
           awk -v want="$declared_digest" -F@ 'NF>1 && $NF == want { hit=1 } END { exit !hit }'; then
        ok "$key matches by digest: $name was started from the tag $running, which is $declared_digest"
      else
        found "$name runs $running, whose digest is not the $declared_digest that $VERSIONS_FILE pins" \
          "the tag has moved or the box was never recreated: pull and restart the stack, or update $key"
      fi
    else
      found "$name runs $running but $VERSIONS_FILE pins $declared" \
        "pull and restart the stack, or update $key if the box is intentionally ahead"
    fi
  done

  # ORPHANS. Everything above asked "is the right version running", using the FIRST
  # container whose name matches. That question cannot see a second one.
  #
  # A container outside the compose project is invisible to the tooling that manages
  # the stack: `compose up -d` will not recreate it, `compose down` will not stop it,
  # and a pin bump cannot reach it, so it keeps running the old image while every check
  # above reports the new one, having looked at the sibling. It can also hold the port
  # or the data volume the real one needs. deploy.sh already treats a missing compose
  # label as the signature of a hand-started container, which is how it knows to remove
  # a squatting faucet-web and leave an unrelated tool alone, so this reuses that fact
  # rather than inventing a second rule.
  for key in Z3_ZEBRA_IMAGE Z3_ZALLET_IMAGE Z3_ZAINO_IMAGE; do
    match="$(stack_match "$key")"
    # Every match, not the first. Labels come back on the same line as the name so a
    # container cannot be read against another container's project.
    listing="$("$DOCKER" ps --filter "name=$match" \
      --format '{{.Names}} {{.Label "com.docker.compose.project"}}' 2>/dev/null)"
    [ -n "$listing" ] || continue
    count=0
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      count=$((count + 1))
      cname="${line%% *}"
      project=""
      case "$line" in *" "*) project="${line#* }" ;; esac
      if [ -z "$project" ]; then
        found "$cname matches '$match' but belongs to no compose project" \
          "it was started by hand, so compose cannot recreate or stop it: docker rm -f $cname once the stack owns the real one"
      fi
    done <<EOF
$listing
EOF
    # Two containers answering to one component is worth saying even when both are in
    # the project, because every version line above silently picked one of them.
    [ "$count" -gt 1 ] && found "$count containers match '$match', so the version reported above describes only one of them" \
      "remove the ones that are not part of the running stack"
  done
fi
say ""

if [ -n "$unverified" ]; then
  say "NOT VERIFIED"
  say "$unverified"
  say ""
fi

if [ "$drift" = "0" ]; then
  if [ -n "$unverified" ]; then
    # Clean is a claim about everything, and something was skipped.
    say "no drift found in what could be checked, but the audit was INCOMPLETE (see NOT VERIFIED)"
    exit 2
  fi
  say "no drift: this box matches the repo"
  exit 0
fi
say "DRIFT FOUND. The fix is to put these into the repo, not to change the box:"
say "  - a hand-installed unit or drop-in belongs in deploy/z3/ and in the install docs"
say "  - an untracked override belongs in git"
say "  - a stale script in $INSTALL_DIR means re-copying it, or the box is ahead of review"
say "Nothing was changed by this audit."
exit 1

# shellcheck shell=bash

# Shared helpers for the deploy/z3 test suites. Sourced by run-tests.sh,
# never run on its own. Suites add checks through ok/bad/check/check_order
# and share one pass/fail tally so the runner can report a single total.

pass=0; fail=0

# Scratch-dir handling, both halves of #161. Register every dir and remove them
# all on exit so a run stops leaking one per env. AND refuse to continue if a dir
# cannot be created: an empty T (mktemp failed, e.g. a full disk) makes every
# derived path absolute at / and the suite KEEPS SCORING, printing ok for
# assertions whose redirect silently failed. Cleanup only makes ENOSPC rare;
# this guard is what stops a fake green when the disk fills for reasons unrelated
# to us. mk_scratch sets the global T directly rather than via $(...), so the
# exit runs in the real shell instead of a command-substitution subshell.
_TEST_TMPDIRS=()
_cleanup_test_tmpdirs() { [ "${#_TEST_TMPDIRS[@]}" -gt 0 ] && rm -rf "${_TEST_TMPDIRS[@]}"; }
trap _cleanup_test_tmpdirs EXIT
mk_scratch() {  # sets global T
  T="$(mktemp -d "$1")" || true
  if [ -z "$T" ] || [ ! -d "$T" ]; then
    echo "  FATAL: could not create scratch dir ($1), disk full? refusing to score" >&2
    # Exit 2, not 1: a disk-full abort is could-not-run, not tests-failed, per the
    # preflight's exit-code contract (#151). CI can then tell "fix the runner
    # image" from "someone broke the code".
    exit 2
  fi
  _TEST_TMPDIRS+=("$T")
}

ok()   { pass=$((pass+1)); echo "  ok: $1"; }
bad()  { fail=$((fail+1)); echo "  FAIL: $1"; }
check(){ if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# Asserts the first log line matching $2 comes before the first matching $3.
check_order() {
  local a b
  a="$(grep -n "$2" "$STUB_LOG" | head -1 | cut -d: -f1)"
  b="$(grep -n "$3" "$STUB_LOG" | head -1 | cut -d: -f1)"
  if [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]; then ok "$1"; else bad "$1 (got '$2'@${a:-none} vs '$3'@${b:-none})"; fi
}

# Environment for the zsnap and backup suites: stub zebrad, docker, systemctl
# and curl on PATH, fake docker volumes on disk, everything under TMPDIR so a
# read-only checkout works.
fresh_env() {
  mk_scratch "${TMPDIR:-/tmp}/zsnap-test.XXXXXX"
  export STUB_LOG="$T/stub.log"; : > "$STUB_LOG"
  export STUB_VOLROOT="$T/volumes"; mkdir -p "$STUB_VOLROOT"
  export STUB_CONTAINERS="$T/containers"; mkdir -p "$STUB_CONTAINERS"
  export STUB_SYSTEMD="$T/systemd"; mkdir -p "$STUB_SYSTEMD"
  export PATH="$SCRATCH/stubs:$BASE_PATH"
  export ZSNAP_DIR="$T/zsnap"
  export ZSNAP_ZEBRAD="$SCRATCH/stubs/zebrad-stub"
  export ZSNAP_RETRY_WAIT=1
  export STUB_CACHE_DIR="$STUB_VOLROOT/z3-testnet-chain"
  unset ZSNAP_SOURCE ZSNAP_EXPECT_HASH ZSNAP_ALLOW_UNVERIFIED ZSNAP_MODE \
        STUB_IMPORT_FAIL STUB_EXPORT_FAIL STUB_EXPORT_FAIL_ONCE STUB_READY STUB_WD_STUCK 2>/dev/null
  export ZSNAP_SOURCE_FILE="$T/restore-url"   # keep /etc out of the tests
}
with_chain() { mkdir -p "$STUB_CACHE_DIR"; head -c 100000 /dev/urandom > "$STUB_CACHE_DIR/some.sst"; }

# Environment for the deploy.sh suite. Different stub docker (it models
# compose, one-off runs and container labels rather than zsnap's volumes), so
# it gets its own PATH entry rather than sharing stubs/.
deploy_fresh_env() {
  mk_scratch "${TMPDIR:-/tmp}/deploy-test.XXXXXX"
  export STUB_LOG="$T/stub.log"; : > "$STUB_LOG"
  export STUB_CONTAINERS="$T/containers"; mkdir -p "$STUB_CONTAINERS"
  export STUB_VOLROOT="$T/volumes"; mkdir -p "$STUB_VOLROOT"
  export PATH="$SCRATCH/deploy-stubs:$BASE_PATH"
  # Writable copy of deploy/ so faucet.env, .zallet-rpc-password and the
  # fake z3 checkout land outside the (read-only) repo mount.
  cp -r "$REPO/deploy" "$T/deploy"
  D="$T/deploy"
  # Pre-seed the z3 clone so `git clone` and setup-network are skipped, and
  # give it the two scripts deploy.sh calls. The readiness one logs a marker
  # so tests can assert what came before the sync wait.
  mkdir -p "$D/z3-stack/scripts" "$D/z3-stack/config/testnet"
  touch "$D/z3-stack/config/testnet/zebra.toml" "$D/z3-stack/config/testnet/zallet.toml"
  # $STUB_LOG must land literally, the stub expands it at run time.
  # shellcheck disable=SC2016
  printf '#!/usr/bin/env bash\necho "readiness-wait" >> "$STUB_LOG"\n' > "$D/z3-stack/scripts/check-zebra-readiness.sh"
  printf '#!/usr/bin/env bash\nexit 0\n' > "$D/z3-stack/scripts/setup-network.sh"
  chmod +x "$D/z3-stack/scripts/"*.sh
}
run_deploy() { NONINTERACTIVE=1 NETWORK=testnet bash "$D/deploy.sh"; }
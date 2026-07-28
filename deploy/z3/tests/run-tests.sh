#!/usr/bin/env bash
# The single entrypoint for the deploy/z3 shell-tooling tests. Runs every
# suite in suites/ and reports one total, so CI needs exactly one line.
#
#   suites/zsnap.sh   zsnap-export.sh and zsnap-import.sh
#   suites/backup.sh  backup.sh and restore-backup.sh
#   suites/deploy.sh  deploy.sh (bring-up order, wallet init, re-runs)
#
# Docker, zebrad, systemctl and curl are stubbed (tests/stubs for zsnap and
# backup, tests/deploy-stubs for deploy, which needs a different docker
# model). sqlite, tar, gpg and every hash check run for real.
#
# Needs Linux (flock, GNU find) plus zstd, gnupg, python3, curl, and openssh-server
# for the access suite. Missing ones are named and refused rather than reported as
# failures, so trust the refusal over guessing. From a Mac or a clean room:
#   docker run --rm -v "$(git rev-parse --show-toplevel)":/repo:ro ubuntu:24.04 \
#     bash -c 'set -e; apt-get update -qq
#              apt-get install -y -qq zstd curl gnupg python3 openssh-server
#              bash /repo/deploy/z3/tests/run-tests.sh'
# The `set -e` matters. An install that fails behind >/dev/null looks like the
# suite found real bugs.
# Scratch state goes under TMPDIR, never into the repo.
#
# Suites are chosen with the SUITES env var, NOT positional arguments:
#   SUITES=deploy ./run-tests.sh          one suite
#   SUITES="drift alerts" ./run-tests.sh  a few
# `./run-tests.sh drift` silently runs all of them, which is easy to misread as
# a huge failure count from one suite.
set -uo pipefail

SCRATCH="${TEST_SCRATCH:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
REPO="${TEST_REPO:-$(cd "$SCRATCH/../../.." && pwd)}"
# The script paths and BASE_PATH below are read by the sourced suites, which
# the linter cannot see from here.
# shellcheck disable=SC2034
EXPORT="$REPO/deploy/z3/zsnap-export.sh"
# shellcheck disable=SC2034
IMPORT="$REPO/deploy/z3/zsnap-import.sh"
# shellcheck disable=SC2034
BACKUP="$REPO/deploy/z3/backup.sh"
# shellcheck disable=SC2034
RESTORE="$REPO/deploy/z3/restore-backup.sh"
# Each suite prepends its own stub dir to this, rather than to whatever the
# previous suite left on PATH.
# shellcheck disable=SC2034
BASE_PATH="$PATH"

# shellcheck source=lib.sh
. "$SCRATCH/lib.sh"

SELECTED="${SUITES:-zsnap backup deploy metrics redeploy drift alerts access}"

# A missing dependency used to look exactly like broken code. With no sshd on
# PATH the access suite reports 3 plain FAILs, and an `apt-get install` that
# quietly failed behind >/dev/null reported 25 at me, none of which named a
# cause. So refuse up front and say what to install, because a harness that
# cannot tell "not installed" from "defect" makes every number it prints
# suspect. Commands assumed present: coreutils, tar, flock, sed, awk.
suite_deps() { # $1 suite name -> commands it needs beyond the base set
  case "$1" in
    zsnap)    echo "zstd python3 curl" ;;
    backup)   echo "gpg zstd python3" ;;
    redeploy) echo "curl" ;;
    # audit-access.sh asks sshd what it enforces. Without sshd the audit is
    # right to report NOT VERIFIED, but the suite asserts the resolved path.
    access)   echo "sshd" ;;
    # alert.sh encodes JSON with jq or python3, either one, so it is not a hard
    # requirement here. The suites read the refusal path deliberately.
    drift|alerts) echo "python3" ;;
    *)        echo "" ;;
  esac
}

missing=""
for suite in $SELECTED; do
  [ -f "$SCRATCH/suites/$suite.sh" ] || continue
  for cmd in $(suite_deps "$suite"); do
    command -v "$cmd" >/dev/null 2>&1 && continue
    case " $missing " in *" $cmd "*) ;; *) missing="$missing $cmd" ;; esac
  done
done

if [ -n "$missing" ]; then
  echo "REFUSING TO RUN: these suites need commands this host does not have:" >&2
  for cmd in $missing; do echo "  missing: $cmd" >&2; done
  echo >&2
  echo "Running anyway would report them as test failures, which reads as broken" >&2
  echo "code rather than a missing package. On Ubuntu:" >&2
  echo "  apt-get update && apt-get install -y zstd curl gnupg python3 openssh-server" >&2
  echo >&2
  echo "Use 'set -e' on that install. A silently failed one is how 25 phantom" >&2
  echo "failures happen. Narrow the run instead with SUITES=\"drift alerts\"." >&2
  exit 2
fi

for suite in $SELECTED; do
  file="$SCRATCH/suites/$suite.sh"
  [ -f "$file" ] || { bad "no such suite: $suite"; continue; }
  echo
  echo "### suite: $suite"
  # shellcheck source=/dev/null
  . "$file"
done

echo
# pass/fail are assigned in lib.sh, sourced above.
# shellcheck disable=SC2154
echo "$pass passed, $fail failed"
# shellcheck disable=SC2154
[ "$fail" -eq 0 ]

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
# Needs Linux (flock, GNU find) plus zstd, gnupg, python3. From a Mac or a
# clean room:
#   docker run --rm -v "$(git rev-parse --show-toplevel)":/repo:ro ubuntu:24.04 \
#     bash -c 'apt-get update -qq && apt-get install -y -qq zstd curl gnupg python3 \
#              && bash /repo/deploy/z3/tests/run-tests.sh'
# Scratch state goes under TMPDIR, never into the repo.
#
# Run one suite while iterating:  SUITES=deploy ./run-tests.sh
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

for suite in ${SUITES:-zsnap backup deploy metrics redeploy drift alerts access}; do
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

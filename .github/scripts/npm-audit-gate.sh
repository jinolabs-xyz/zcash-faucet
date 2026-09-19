#!/usr/bin/env bash
# THE AUDIT GATE, AND THE ONE DISTINCTION IT EXISTS TO MAKE.
#
# `npm audit --audit-level=high` exits 1 for TWO completely different things:
#   - it reached the registry and found a high or critical advisory   -> the gate working
#   - it could not reach the registry at all                          -> the gate NOT RUNNING
# The old step could not tell them apart, so on 2026-09-19 npm returned
#   503 Service Unavailable - POST .../security/advisories/bulk  (maintenance)
# and main went red with a message that reads like a security finding. The control was already in
# the run history: the SAME sha ran green at 17:03 and red at 17:15, with no change to the tree.
#
# A security gate that goes red for a reason unrelated to security is one people learn to skim,
# and skimming is how a real advisory gets waved through. So this names which of the two happened.
#
# IT DOES NOT MAKE AN UNREACHABLE REGISTRY PASS. That would turn an npm outage into a free ride
# past the gate, which is the false-green shape this tree files lessons about. Not-measured stays
# non-zero; it just says so in words nobody can mistake for an advisory, and it exits 2 rather than
# 1 for the reason deploy/z3/tests/lib.sh already documents: a could-not-run is not a failure, and
# CI should be able to tell "fix the runner" from "someone broke the code".
#
# THE DISCRIMINATOR IS STRUCTURAL, NOT A MESSAGE STRING. `npm audit --json` emits an object with an
# `error` key when the endpoint fails and a `metadata.vulnerabilities` object when it succeeds.
# Matching on "503" or on "endpoint returned an error" would break the day npm rewords it - which it
# has already done once this year, retiring the quick endpoint with a 400 whose text says so.
set -uo pipefail

# Overridable so the suite can drive both branches from fixtures without a network.
AUDIT_CMD="${NPM_AUDIT_CMD:-npm audit --json}"
ATTEMPTS="${NPM_AUDIT_ATTEMPTS:-3}"
BACKOFF="${NPM_AUDIT_BACKOFF:-10}"

command -v jq >/dev/null || { echo "audit gate: jq is not installed, so this gate cannot run"; exit 2; }

out=""
for attempt in $(seq 1 "$ATTEMPTS"); do
  out="$($AUDIT_CMD 2>/dev/null)"
  # A non-zero exit here is EXPECTED when advisories exist, so the exit code is not the signal.
  if printf '%s' "$out" | jq -e 'has("error")' >/dev/null 2>&1; then
    summary="$(printf '%s' "$out" | jq -r '.error.summary // .error.code // "unknown"')"
    echo "audit gate: attempt $attempt/$ATTEMPTS could not reach the advisory endpoint: $summary"
    [ "$attempt" -lt "$ATTEMPTS" ] && sleep "$BACKOFF"
    continue
  fi
  if ! printf '%s' "$out" | jq -e 'has("metadata")' >/dev/null 2>&1; then
    echo "audit gate: attempt $attempt/$ATTEMPTS got an answer that is neither an error nor a report"
    [ "$attempt" -lt "$ATTEMPTS" ] && sleep "$BACKOFF"
    continue
  fi
  high="$(printf '%s' "$out" | jq -r '.metadata.vulnerabilities.high // 0')"
  crit="$(printf '%s' "$out" | jq -r '.metadata.vulnerabilities.critical // 0')"
  if [ "$((high + crit))" -gt 0 ]; then
    echo "AUDIT FAILED: $crit critical and $high high advisories in the dependency tree."
    echo "This IS a security result. Read them with: npm audit"
    exit 1
  fi
  echo "audit gate: no high or critical advisories ($crit critical, $high high)."
  exit 0
done

# Every attempt failed to produce a report. Say so in words that cannot be read as a finding.
echo "================================================================"
echo "AUDIT DID NOT RUN - THIS IS NOT A SECURITY RESULT."
echo "The advisory endpoint could not be reached after $ATTEMPTS attempts, so nothing about this"
echo "tree's dependencies has been checked. It is not a finding and it is not a clean bill either."
echo "Check https://status.npmjs.org, then re-run this job."
echo "================================================================"
exit 2

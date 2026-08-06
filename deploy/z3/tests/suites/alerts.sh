# shellcheck shell=bash
# alert.sh: the shared sender used by watchdog.sh and every OnFailure hook.
# A real HTTP receiver records what arrives, so the body shape is checked
# rather than assumed.

ALERT="$REPO/deploy/z3/alert.sh"

alerts_env() {
  mk_scratch "${TMPDIR:-/tmp}/alerts-test.XXXXXX"
  export STUB_LOG="$T/stub.log"; : > "$STUB_LOG"
  mkdir -p "$T/bin"
  export PATH="$T/bin:$BASE_PATH"
  export FAUCET_ALERT_URL="http://127.0.0.1:$HOOK_PORT/hook"
  export FAUCET_ALERT_FORMAT=slack
  unset WATCHDOG_ALERT_URL WATCHDOG_ALERT_FORMAT FAUCET_ALERT_PREFIX 2>/dev/null
  : > "$HOOK_LOG"
}

HOOK_PORT="${ALERT_TEST_PORT:-18921}"
HOOK_LOG="${TMPDIR:-/tmp}/alert-hook.log"
python3 - "$HOOK_PORT" "$HOOK_LOG" <<'PY' >/dev/null 2>&1 &
import http.server,sys
port,logf=int(sys.argv[1]),sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n=int(self.headers.get('content-length',0)); body=self.rfile.read(n).decode()
        open(logf,'a').write(body+"\n")
        code=500 if 'FAIL' in self.path else 204
        self.send_response(code); self.end_headers()
    def log_message(self,*a): pass
http.server.HTTPServer(("127.0.0.1",port),H).serve_forever()
PY
HOOK_PID=$!
for _ in $(seq 1 40); do curl -sf -o /dev/null -X POST -d '{}' "http://127.0.0.1:$HOOK_PORT/warmup" && break; sleep 0.25; done
: > "$HOOK_LOG"

echo "== alerts: a plain message reaches the webhook in slack shape"
alerts_env
bash "$ALERT" "disk is nearly full" > "$T/plain.log" 2>&1
check "exits 0" "[ $? -eq 0 ]"
check "webhook received it" "grep -q 'disk is nearly full' '$HOOK_LOG'"
check "slack key used" "grep -q '\"text\"' '$HOOK_LOG'"
check "prefixed so the channel shows the source" "grep -q 'zcash-faucet' '$HOOK_LOG'"

echo "== alerts: discord gets the other key, because each rejects the other's"
alerts_env; export FAUCET_ALERT_FORMAT=discord
bash "$ALERT" "hello" > /dev/null 2>&1
check "discord key used" "grep -q '\"content\"' '$HOOK_LOG'"
check "no slack key" "! grep -q '\"text\"' '$HOOK_LOG'"

echo "== alerts: an unknown format still sends, and says so"
alerts_env; export FAUCET_ALERT_FORMAT=telegram
bash "$ALERT" "hello" > "$T/unk.log" 2>&1
check "still sent" "grep -q hello '$HOOK_LOG'"
check "warns about the unknown format" "grep -q 'unknown FAUCET_ALERT_FORMAT' '$T/unk.log'"

echo "== alerts: quotes and newlines in the message cannot break the JSON"
alerts_env
bash "$ALERT" 'container "faucet-web" died
second line' > /dev/null 2>&1
check "webhook got valid JSON" "python3 -c \"import json,sys;[json.loads(l) for l in open('$HOOK_LOG') if l.strip()]\""
check "the quoted name survived" "grep -q 'faucet-web' '$HOOK_LOG'"

echo "== alerts: unconfigured is loud locally and exits 3, never silent"
alerts_env; unset FAUCET_ALERT_URL
bash "$ALERT" "nobody will hear this" > "$T/noconf.log" 2>&1
check "exits 3" "[ $? -eq 3 ]"
check "says NOT SENT with the reason" "grep -q 'NOT SENT (no FAUCET_ALERT_URL' '$T/noconf.log'"
check "nothing reached the webhook" "! grep -q 'nobody will hear' '$HOOK_LOG'"

echo "== alerts: self-test uses the real send path and reports honestly"
alerts_env
bash "$ALERT" --self-test > "$T/st.log" 2>&1
check "passes when configured" "[ $? -eq 0 ] && grep -q 'SELF-TEST PASSED' '$T/st.log'"
check "the channel actually received it" "grep -q 'self-test from' '$HOOK_LOG'"
alerts_env; unset FAUCET_ALERT_URL
bash "$ALERT" --self-test > "$T/st2.log" 2>&1
check "fails when unconfigured" "[ $? -ne 0 ] && grep -q 'SELF-TEST FAILED' '$T/st2.log'"
check "and names the file to edit" "grep -q '/etc/faucet/alerts.env' '$T/st2.log'"
alerts_env; export FAUCET_ALERT_URL="http://127.0.0.1:$HOOK_PORT/FAIL"
bash "$ALERT" --self-test > "$T/st3.log" 2>&1
check "fails when the webhook rejects" "[ $? -ne 0 ] && grep -q 'webhook rejected' '$T/st3.log'"

echo "== alerts: the OnFailure hook names the unit and quotes its logs"
alerts_env
printf '#!/usr/bin/env bash\necho "boom: something exploded"\n' > "$T/bin/journalctl"
chmod +x "$T/bin/journalctl"
bash "$ALERT" --unit zsnap-export.service > /dev/null 2>&1
check "names the failing unit" "grep -q 'unit FAILED: zsnap-export.service' '$HOOK_LOG'"
check "includes the journal tail, so no SSH needed to triage" "grep -q 'something exploded' '$HOOK_LOG'"

echo "== alerts: the older WATCHDOG_ALERT_URL still works after upgrade"
alerts_env; unset FAUCET_ALERT_URL
export WATCHDOG_ALERT_URL="http://127.0.0.1:$HOOK_PORT/hook"
bash "$ALERT" "legacy config" > /dev/null 2>&1
check "legacy var honoured" "grep -q 'legacy config' '$HOOK_LOG'"

# NOTE: these sit ABOVE `kill $HOOK_PID` on purpose. Appended after it, they ran
# against a dead receiver: nothing arrived, and the negative assertion
# "does not use the wake-someone wording" PASSED on an empty file. A vacuous pass
# is why the positive assertions beside it are not optional.
# ── BEST-EFFORT TIER: a feature-net stall must not read like an outage (#327) ────────
#
# Every failure on this box routes through one handler with one wording, so a Crosslink
# node wobbling at 3am arrives looking exactly like the TAZ faucet being down. One means
# nobody can get testnet coins; the other means an experimental chain hiccupped.
#
# The repo decides which is which, the same way enabled-units decides enablement, so the
# tiering goes through review rather than being edited on the box.

echo "== alert: a best-effort unit does not read like a faucet outage"
alerts_env
BE="$T/best-effort"
printf '# comment\nctaz-node.service\nctaz-rpc@.service\n' > "$BE"
FAUCET_BEST_EFFORT_UNITS="$BE" bash "$ALERT" --unit ctaz-node.service > "$T/be.log" 2>&1
check "it still alerts, rather than swallowing the failure" "[ -s '$HOOK_LOG' ]"
check "and says it is NOT an outage" "grep -q 'NOT a faucet outage' '$HOOK_LOG'"
check "and does not use the wake-someone wording" "! grep -q 'unit FAILED' '$HOOK_LOG'"
check "the unit is still named, or the alert costs an SSH session to act on" \
  "grep -q 'ctaz-node.service' '$HOOK_LOG'"

echo "== alert: A UNIT NOT ON THE LIST IS STILL LOUD"
# The mirror, and the one that matters: without it the tier could be applied to
# everything and these tests would still pass.
alerts_env
printf 'ctaz-node.service\n' > "$BE"
FAUCET_BEST_EFFORT_UNITS="$BE" bash "$ALERT" --unit faucet-watchdog.service > "$T/loud.log" 2>&1
check "an unlisted unit uses the outage wording" "grep -q 'unit FAILED' '$HOOK_LOG'"
check "and is not softened" "! grep -q 'NOT a faucet outage' '$HOOK_LOG'"

echo "== alert: a TEMPLATE INSTANCE matches the template line"
# ctaz-rpc@3-172.17.0.2:9.service must match `ctaz-rpc@.service`. Without stripping the
# instance, the one unit type that produces the most failures could never be tiered and
# the list would silently do nothing for it.
alerts_env
printf 'ctaz-rpc@.service\n' > "$BE"
FAUCET_BEST_EFFORT_UNITS="$BE" bash "$ALERT" --unit 'ctaz-rpc@3-172.17.0.2:9.service' > "$T/inst.log" 2>&1
check "an instance is tiered by its template" "grep -q 'NOT a faucet outage' '$HOOK_LOG'"

echo "== alert: FAILS LOUD when the list cannot be read"
# Under-alerting is the worse failure, so every ambiguity resolves toward noise. A
# missing file must not quietly make everything best-effort.
alerts_env
FAUCET_BEST_EFFORT_UNITS="$T/no-such-file" bash "$ALERT" --unit ctaz-node.service > "$T/nofile.log" 2>&1
check "no list means nothing is best-effort" "grep -q 'unit FAILED' '$HOOK_LOG'"
check "and the cTAZ unit is loud, despite being the one we would tier" \
  "! grep -q 'NOT a faucet outage' '$HOOK_LOG'"

echo "== alert: a separate best-effort channel is used when one is configured"
# The harness runs ONE receiver, so this asserts the URL SWITCH rather than a second
# inbox: pointing the best-effort channel at a dead port must send there and fail, not
# quietly fall back to the paging channel. A fallback would defeat the whole tier.
alerts_env
printf 'ctaz-node.service\n' > "$BE"
FAUCET_BEST_EFFORT_UNITS="$BE" \
  FAUCET_ALERT_BESTEFFORT_URL="http://127.0.0.1:1/nope" \
  bash "$ALERT" --unit ctaz-node.service > "$T/split.log" 2>&1
check "the paging channel received NOTHING" "[ ! -s '$HOOK_LOG' ]"
check "and the failure to reach the best-effort channel is reported" \
  "grep -q 'POST FAILED' '$T/split.log'"

kill "$HOOK_PID" 2>/dev/null

echo "== alerts: the webhook URL never reaches the log (it is a credential)"
alerts_env
export FAUCET_ALERT_URL="http://127.0.0.1:$HOOK_PORT/hook?token=SUPERSECRETTOKEN"
bash "$ALERT" --self-test > "$T/leak.log" 2>&1
check "the token is absent from the log" "! grep -q 'SUPERSECRETTOKEN' '$T/leak.log'"
check "it says set, not the value" "grep -q 'url=set' '$T/leak.log'"
alerts_env; unset FAUCET_ALERT_URL
bash "$ALERT" --self-test > "$T/leak2.log" 2>&1
check "unconfigured still says UNSET" "grep -q 'url=UNSET' '$T/leak2.log'"

echo "== alerts: a tab in the body is encoded, not silently mangled"
# Journal output is full of tabs and JSON forbids raw control characters, so
# this gets its own receiver rather than sharing the suite's.
alerts_env
TAB_PORT=$((HOOK_PORT + 1)); TAB_LOG="$T/tabhook.log"; : > "$TAB_LOG"
python3 - "$TAB_PORT" "$TAB_LOG" <<'TABPY' >/dev/null 2>&1 &
import http.server,sys
port,logf=int(sys.argv[1]),sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n=int(self.headers.get('content-length',0))
        open(logf,'a').write(self.rfile.read(n).decode()+"\n")
        self.send_response(204); self.end_headers()
    def log_message(self,*a): pass
http.server.HTTPServer(("127.0.0.1",port),H).serve_forever()
TABPY
TAB_PID=$!
for _ in $(seq 1 40); do curl -sf -o /dev/null -X POST -d '{}' "http://127.0.0.1:$TAB_PORT/up" && break; sleep 0.25; done
: > "$TAB_LOG"
export FAUCET_ALERT_URL="http://127.0.0.1:$TAB_PORT/hook"
bash "$ALERT" "$(printf 'unit failed\ncolumn1\tcolumn2')" > "$T/tab.log" 2>&1
check "the send succeeded" "[ $? -eq 0 ]"
check "the tab and newline survive as real characters after decoding" "python3 -c \"import json;b=[json.loads(l) for l in open('$TAB_LOG') if l.strip()][-1];t=b.get('text','');assert chr(9) in t and chr(10) in t, repr(t)\""
kill "$TAB_PID" 2>/dev/null

echo "== alerts: with no JSON encoder it refuses loudly instead of sending junk"
alerts_env
mkdir -p "$T/nobin"
# A PATH with neither jq nor python3, but with the tools alert.sh still needs.
# bash itself must be reachable, plus what alert.sh actually calls.
for b in bash curl date hostname sed tr cat; do
  src="$(command -v $b 2>/dev/null)"; [ -n "$src" ] && ln -sf "$src" "$T/nobin/$b"
done
PATH="$T/nobin" bash "$ALERT" "would be malformed" > "$T/noenc.log" 2>&1
check "exits nonzero" "[ $? -ne 0 ]"
check "says it cannot encode" "grep -q 'CANNOT SEND' '$T/noenc.log'"
check "explains the refusal is deliberate" "grep -q 'Refusing rather than sending a malformed body' '$T/noenc.log'"
check "nothing reached the webhook" "! grep -q 'would be malformed' '$HOOK_LOG'"

echo "== alerts: a quote in the operator prefix cannot break the body"
alerts_env
FAUCET_ALERT_PREFIX='[fau"cet]' bash "$ALERT" "hello" > /dev/null 2>&1
check "body is still valid JSON" "python3 -c \"import json;[json.loads(l) for l in open('$HOOK_LOG') if l.strip()]\""

echo "== alerts: self-test names the real cause, not a plausible one"
# rc=4 (no encoder) used to print "the webhook rejected the POST", sending an
# operator to debug Slack when the fix is installing jq.
alerts_env
mkdir -p "$T/nobin2"
for b in bash curl date hostname sed tr cat; do
  src="$(command -v $b 2>/dev/null)"; [ -n "$src" ] && ln -sf "$src" "$T/nobin2/$b"
done
PATH="$T/nobin2" bash "$ALERT" --self-test > "$T/st4.log" 2>&1
check "exits 4, distinct from a rejected webhook" "[ $? -eq 4 ]"
check "blames the missing encoder" "grep -q 'no jq and no python3' '$T/st4.log'"
check "does NOT blame the webhook" "! grep -q 'webhook rejected' '$T/st4.log'"

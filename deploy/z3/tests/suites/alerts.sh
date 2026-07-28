# shellcheck shell=bash
# alert.sh: the shared sender used by watchdog.sh and every OnFailure hook.
# A real HTTP receiver records what arrives, so the body shape is checked
# rather than assumed.

ALERT="$REPO/deploy/z3/alert.sh"

alerts_env() {
  T="$(mktemp -d "${TMPDIR:-/tmp}/alerts-test.XXXXXX")"
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
python3 - "$HOOK_PORT" "$HOOK_LOG" >/dev/null 2>&1 &
HOOK_PID=$!
sleep 0
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

kill "$HOOK_PID" 2>/dev/null

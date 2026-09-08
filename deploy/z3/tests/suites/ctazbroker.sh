# shellcheck shell=bash
# ctaz-rpc-broker.sh: one connection, one answer, and THE EXIT CODE IS THE ALERT. The
# unit carries OnFailure=, so every non-zero exit pages a phone. The broker's contract is
# therefore that every outcome it understands exits 0 - a refused method, a node that
# will not answer, a caller that is no longer there - and that only a broker that died
# in a new way reaches the handler.
#
# Why this suite exists. The broker had no suite, and on 2026-09-08 the first page the
# new Signal channel ever delivered was this unit: 104 failures in a day, every one of
# them exit 120, every one of them the broker dying while WRITING a correct answer to a
# caller that a deploy had just killed. The node was parked on purpose. Nothing was
# wrong, and a phone said something was.

BROKER="$REPO/deploy/z3/ctaz-rpc-broker.sh"
REQ='{"jsonrpc":"2.0","id":7,"method":"getblockchaininfo","params":[]}'

br_env() {
  mk_scratch "${TMPDIR:-/tmp}/ctazbroker.XXXXXX"
  # Port 1 on loopback: nothing listens there anywhere this suite runs, so the connect is
  # refused immediately, which is exactly what a parked node looks like.
  export CTAZ_RPC_URL="http://127.0.0.1:1/"
  unset CTAZ_BROKER_METHODS CTAZ_BROKER_TIMEOUT CTAZ_BROKER_MAX_BYTES 2>/dev/null
}

# A node double that answers every POST with one fixed result and records the body it
# was sent, so pass-through can be asserted on bytes rather than on "it did not crash".
NODE_PORT="${CTAZ_BROKER_TEST_PORT:-18931}"
NODE_LOG="${TMPDIR:-/tmp}/ctaz-broker-node.log"
python3 - "$NODE_PORT" "$NODE_LOG" <<'PY' >/dev/null 2>&1 &
import http.server,sys
port,logf=int(sys.argv[1]),sys.argv[2]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        n=int(self.headers.get('content-length',0)); body=self.rfile.read(n).decode()
        open(logf,'a').write(body+"\n")
        out=b'{"jsonrpc":"2.0","id":7,"result":{"blocks":424242}}'
        self.send_response(200); self.send_header('content-type','application/json')
        self.send_header('content-length',str(len(out))); self.end_headers(); self.wfile.write(out)
    def log_message(self,*a): pass
http.server.HTTPServer(("127.0.0.1",port),H).serve_forever()
PY
NODE_PID=$!
# bash's /dev/tcp rather than curl: this suite must run in an image with only python3.
for _ in $(seq 1 40); do (exec 3<>"/dev/tcp/127.0.0.1/$NODE_PORT") 2>/dev/null && break; sleep 0.25; done
: > "$NODE_LOG"

echo "== ctaz-broker: a node that refuses the connection is an ANSWER, not a failure"
br_env
printf '%s' "$REQ" | bash "$BROKER" > "$T/out" 2> "$T/err"; echo $? > "$T/rc"
check "exits 0" "[ \"\$(cat '$T/rc')\" = 0 ]"
check "answers a JSON-RPC error that names the node" "grep -q '\"code\": -32000' '$T/out' && grep -q 'did not answer' '$T/out'"
check "keeps the caller's id" "grep -q '\"id\": 7' '$T/out'"
check "one journal line, no traceback" "grep -q 'node did not answer' '$T/err' && ! grep -q Traceback '$T/err'"

echo "== ctaz-broker: A CALLER THAT HUNG UP IS NOT A BROKER FAILURE (the page of 2026-09-08)"
br_env
# \`true\` exits before python has started, so the read end of the pipe is gone by the time
# the broker writes its answer and the write gets EPIPE - the deploy-killed-the-app shape.
# PIPESTATUS[1] is the broker's own exit code; without the fix it is 120.
printf '%s' "$REQ" | bash "$BROKER" 2> "$T/err" | true; echo "${PIPESTATUS[1]}" > "$T/rc"
check "exits 0, not 120" "[ \"\$(cat '$T/rc')\" = 0 ]"
check "says what happened in one line" "grep -q 'caller hung up before the reply' '$T/err'"
check "no traceback for the journal to page about" "! grep -q 'Traceback\|BrokenPipeError' '$T/err'"

echo "== ctaz-broker: the node's answer passes through untouched"
br_env
export CTAZ_RPC_URL="http://127.0.0.1:$NODE_PORT/"
printf '%s' "$REQ" | bash "$BROKER" > "$T/out" 2> "$T/err"; echo $? > "$T/rc"
check "exits 0" "[ \"\$(cat '$T/rc')\" = 0 ]"
check "the node's bytes are the reply" "grep -q '\"blocks\":424242' '$T/out'"
check "the node was sent the allowlisted method, rebuilt" "grep -q '\"method\": \"getblockchaininfo\"' '$NODE_LOG'"
check "nothing on stderr for a clean call" "[ ! -s '$T/err' ]"

echo "== ctaz-broker: a caller that hung up on a GOOD answer is still not a failure"
br_env
export CTAZ_RPC_URL="http://127.0.0.1:$NODE_PORT/"
printf '%s' "$REQ" | bash "$BROKER" 2> "$T/err" | true; echo "${PIPESTATUS[1]}" > "$T/rc"
check "exits 0 on the success path too" "[ \"\$(cat '$T/rc')\" = 0 ]"
check "same one-line explanation" "grep -q 'caller hung up before the reply' '$T/err'"

echo "== ctaz-broker: a method outside the allowlist is refused, named, and still exit 0"
br_env
printf '%s' '{"jsonrpc":"2.0","id":3,"method":"stop","params":[]}' | bash "$BROKER" > "$T/out" 2> "$T/err"; echo $? > "$T/rc"
check "exits 0" "[ \"\$(cat '$T/rc')\" = 0 ]"
check "JSON-RPC method-not-permitted" "grep -q '\"code\": -32601' '$T/out'"
check "the journal names the method, not the params" "grep -q \"refused method 'stop'\" '$T/err'"
check "the node was never asked" "! grep -q '\"stop\"' '$NODE_LOG'"

kill "$NODE_PID" 2>/dev/null; wait "$NODE_PID" 2>/dev/null

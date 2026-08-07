#!/usr/bin/env bash
# One JSON-RPC call from the faucet container to the Crosslink node (#409).
#
# WHY THIS EXISTS AT ALL. The faucet container has no route to the node's RPC, and that
# is deliberate: the node binds loopback only because it holds funds. Measured from
# inside zcash-faucet-faucet-1 - the container's loopback is its own, 172.17.0.1 times
# out, host.docker.internal is not defined here.
#
# ctaz-status.sh already solved READING with a file. Paying cannot use a file: it needs a
# request/response, so it needs a channel. This is that channel, and it is a unix socket
# in the volume the container already mounts, which means NO new host, NO new port, NO
# new listener on any network interface, and nothing new to pay for.
#
# THE REJECTED ALTERNATIVE, again, for the next person who reaches for it: binding the
# node's RPC to the docker bridge. It is one config line and it is worse. It turns a
# loopback-only surface into one reachable by every container on the box, on a node that
# holds faucet funds, and it needs firewall care forever to stay off the public
# interface. A permanent widening to save a socket file.
#
# ONE CONNECTION PER INVOCATION. systemd's socket unit runs with Accept=yes, so each
# connection gets its own short-lived instance with the socket already wired to stdin and
# stdout. No server loop to leak, no concurrency to manage, and a wedged call cannot
# block the next one.
#
# THE ALLOWLIST IS THE POINT, NOT A FORMALITY. The thing on the other end of this socket
# is an internet-facing web app. Forwarding whatever it sends would mean an app
# compromise becomes full control of a funded node, which is strictly worse than the
# bridge binding this was written to avoid. Five methods, which is everything the faucet
# needs and nothing else.
set -uo pipefail

CTAZ_RPC_URL="${CTAZ_RPC_URL:-http://127.0.0.1:19232/}"
# 30s. The node is slow to answer its first request under mining - measured at 11.9s on a
# cold hit, then milliseconds - and a payment refused because we gave up at five seconds
# would look to a user exactly like an empty wallet.
CTAZ_BROKER_TIMEOUT="${CTAZ_BROKER_TIMEOUT:-30}"
# Refuse a body that is not a plausible JSON-RPC call before parsing it. 64 KiB is far
# more than any request here needs; the largest is an address plus envelope.
CTAZ_BROKER_MAX_BYTES="${CTAZ_BROKER_MAX_BYTES:-65536}"

# Everything the faucet needs, and deliberately nothing else. Adding a method here is a
# decision about what a compromised web app could do, so it is a list rather than a
# prefix match or a regex.
#
#   get_tfl_recency_status   the readiness gate
#   getinfo                  sync position
#   getblockchaininfo        sync position, and the tip this build actually reports
#   requestfaucetdonation    THE MONEY PATH, the only reason this socket exists
#   getrawtransaction        confirming a drip landed
CTAZ_BROKER_METHODS="${CTAZ_BROKER_METHODS:-get_tfl_recency_status getinfo getblockchaininfo requestfaucetdonation getrawtransaction}"

log() { echo "$(date -u +%FT%TZ) ctaz-rpc-broker: $*" >&2; }

# python3 rather than jq: jq is not on this box's dependency list and python3 is, and this
# needs a real parser. A grep for the method name would match one inside an address.
prog="$(cat <<'PY'
import json, os, sys, urllib.request, urllib.error

ALLOWED = set(os.environ.get("CTAZ_BROKER_METHODS", "").split())
URL = os.environ.get("CTAZ_RPC_URL", "http://127.0.0.1:19232/")
TIMEOUT = float(os.environ.get("CTAZ_BROKER_TIMEOUT", "30"))
MAX = int(os.environ.get("CTAZ_BROKER_MAX_BYTES", "65536"))


def reply(obj):
    # Always a JSON-RPC shaped answer, even for our own refusals, so the caller has one
    # parse path. A broker that returns bare text on the error path makes the client
    # write a second parser, and the second one is the one nobody tests.
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()
    sys.exit(0)


raw = sys.stdin.buffer.read(MAX + 1)
if len(raw) > MAX:
    reply({"jsonrpc": "2.0", "id": None,
           "error": {"code": -32600, "message": "request too large"}})

try:
    req = json.loads(raw.decode("utf-8"))
except Exception:
    reply({"jsonrpc": "2.0", "id": None,
           "error": {"code": -32700, "message": "not JSON"}})

if not isinstance(req, dict):
    reply({"jsonrpc": "2.0", "id": None,
           "error": {"code": -32600, "message": "not a JSON-RPC object"}})

rid = req.get("id")
method = req.get("method")

# THE REFUSAL NAMES THE METHOD. An operator reading this in the journal after a
# compromise wants to know what was attempted, and the method name is not a secret. The
# params are NOT logged: an address is a user's, and this file goes to journald.
if not isinstance(method, str) or method not in ALLOWED:
    sys.stderr.write("refused method %r, not in the allowlist\n" % (method,))
    reply({"jsonrpc": "2.0", "id": rid,
           "error": {"code": -32601,
                     "message": "method not permitted over the faucet socket"}})

body = json.dumps({
    "jsonrpc": "2.0",
    "id": rid if rid is not None else 1,
    "method": method,
    "params": req.get("params", []),
}).encode()

# REBUILT, NEVER FORWARDED VERBATIM. Passing the caller's bytes through would let it
# smuggle extra fields to the node, and the allowlist check would then be describing a
# different request than the one that gets sent.
try:
    r = urllib.request.Request(URL, data=body,
                               headers={"content-type": "application/json"})
    with urllib.request.urlopen(r, timeout=TIMEOUT) as resp:
        sys.stdout.write(resp.read().decode("utf-8", "replace"))
        sys.stdout.flush()
except urllib.error.HTTPError as e:
    # The node answered, with a status. Its body is the useful part - a 401 says which
    # credential it wanted - so it is passed through rather than flattened to a code.
    sys.stdout.write(e.read().decode("utf-8", "replace"))
    sys.stdout.flush()
except Exception as e:
    sys.stderr.write("node did not answer: %s\n" % e)
    reply({"jsonrpc": "2.0", "id": rid,
           "error": {"code": -32000, "message": "the Crosslink node did not answer"}})
PY
)"

export CTAZ_BROKER_METHODS CTAZ_RPC_URL CTAZ_BROKER_TIMEOUT CTAZ_BROKER_MAX_BYTES
exec python3 -c "$prog"

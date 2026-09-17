#!/usr/bin/env bash
# Open the two ssh tunnels a local faucet needs to reach the box.
#
#   local 28232 -> box 127.0.0.1:40232   zallet RPC (TAZ sends)
#   local 19232 -> box 127.0.0.1:19232   Crosslink zebrad (cTAZ requestfaucetdonation)
#
# Both are loopback-bound on the box on purpose, and this does not change that: the
# tunnel binds 127.0.0.1 on THIS machine too. Nothing becomes reachable from the network
# at either end.
#
# Runs in the foreground so Ctrl-C closes the tunnels. Backgrounding an ssh -f leaves a
# process that outlives the terminal, and the next run then fails on a bound port with an
# error that reads like the box is down.
set -euo pipefail

# THE BOX IS NOT IN THIS FILE. It was, twice, and was removed twice (#95, #250): this repo
# is public, and while DNS already resolves the faucet hostname to the address, a committed
# "root@<ip>" also publishes the user it is reached as, permanently, in history.
# Set it in your shell: export FAUCET_BOX=root@your-box
BOX="${FAUCET_BOX:?set FAUCET_BOX first, e.g. export FAUCET_BOX=root@your-box}"

for port in 28232 19232; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is already bound locally." >&2
    echo "  another tunnel or process has it. Close it first:  lsof -nP -iTCP:$port -sTCP:LISTEN" >&2
    exit 1
  fi
done

echo "tunnelling to $BOX"
echo "  127.0.0.1:28232 -> zallet RPC"
echo "  127.0.0.1:19232 -> crosslink zebrad"
echo "Ctrl-C to close. Leave this running while you use the local faucet."
echo

# ExitOnForwardFailure so a port that cannot be forwarded fails HERE rather than leaving
# a live session whose tunnels silently do nothing - the app would then report the node
# as unreachable and the tunnel would look fine.
#
# THE ZALLET PORTS ARE NOT THE SAME ON BOTH SIDES. zallet binds 28232 inside its
# container, but docker publishes it on the box as 127.0.0.1:40232. Forwarding
# 28232 -> 28232 connects to nothing and reads as "the wallet is down".
exec ssh -N \
  -o ConnectTimeout=25 \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -L 127.0.0.1:28232:127.0.0.1:40232 \
  -L 127.0.0.1:19232:127.0.0.1:19232 \
  "$BOX"

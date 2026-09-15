#!/bin/sh
# Root for one job, then never again (risk register II, R-10).
#
# The app used to run as root in a writable container on the wallet's network, so an
# RCE in a route was root there. It runs as `node` now. The one thing root has to do
# first is make the ledger volume writable by that user: every image before this one
# created /app/data root-owned, and a named volume keeps the ownership it was created
# with, so a plain USER node would have met EACCES on the first claim after the deploy
# and rolled back. `setpriv` (util-linux, in the slim image) drops to node and execs, so
# node stays PID 1 and the SIGTERM drain (R-27) is untouched.
set -eu
if [ "$(id -u)" = "0" ]; then
  [ -d /app/data ] && chown -R node:node /app/data
  exec setpriv --reuid=node --regid=node --clear-groups -- "$@"
fi
exec "$@"

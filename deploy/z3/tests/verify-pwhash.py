#!/usr/bin/env python3
"""Does the pwhash in zallet.toml verify against the password in faucet.env?

Usage: verify-pwhash.py <zallet.toml> <faucet.env>
Exits 0 when they correspond, 1 when they do not, 2 when a value is missing.

This is the assertion that catches a silent break. A hash the faucet's password does
not verify against means the wallet rejects every request, and nothing else in the
suite would notice: both files exist, both look plausible, and they simply do not
correspond. It lives in its own file because expressing it inline meant a regex
travelling through a bash double-quoted `check` string into a `python3 -c` argument,
and the escaping failed silently in a way that looked like a product bug.

The scheme is Bitcoin Core's, as zallet-core implements it in
components/json_rpc/server/authorization.rs, and confirmed against the wallet's own
`add-rpc-user` output: the HMAC key is the ASCII text of the hex salt, not the 16 raw
bytes it encodes. Those two readings produce different hashes, so this is a real check
rather than one that agrees with whatever it is given.
"""

import hashlib
import hmac
import re
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print(f"usage: {sys.argv[0]} <zallet.toml> <faucet.env>", file=sys.stderr)
        return 2
    cfg_path, env_path = sys.argv[1], sys.argv[2]

    try:
        cfg = open(cfg_path).read()
        env = open(env_path).read()
    except OSError as e:
        print(f"cannot read: {e}", file=sys.stderr)
        return 2

    m = re.search(r'^\s*pwhash\s*=\s*"([0-9a-f]+)\$([0-9a-f]+)"', cfg, re.M)
    if not m:
        print(f"no pwhash line in {cfg_path}", file=sys.stderr)
        return 2
    salt, want = m.group(1), m.group(2)

    pw = re.search(r"^ZALLET_RPC_PASSWORD=(.*)$", env, re.M)
    if not pw or not pw.group(1):
        print(f"no ZALLET_RPC_PASSWORD in {env_path}", file=sys.stderr)
        return 2

    got = hmac.new(salt.encode(), pw.group(1).encode(), hashlib.sha256).hexdigest()
    if got == want:
        return 0
    # Never print the password. The salt and hashes are not secrets.
    print(
        f"pwhash does not verify: salt={salt} config={want} recomputed={got}",
        file=sys.stderr,
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Remove the orphan transaction rows that crash-loop zallet.

zallet keeps a row in `transactions` for every txid it learns of. Some of them end up
with raw = NULL and mined_height = NULL: transactions it saw in the mempool that never
confirmed and that zebra has since dropped. On every boot zallet asks zebra for their
bytes, gets back

    RPC Error (code: -5): No such mempool or main chain transaction

classifies it UNRECOVERABLE, and exits. systemd restarts it into the identical death.
On 2026-08-07 that was 183 restarts and a public 503 (`wallet balance unknown`) for
about three hours. It cannot self-heal, because the input that kills it is stored state.

THESE ROWS CARRY NO MONEY INFORMATION. Every table that can reference a transaction does
so with ON DELETE CASCADE, and on the incident wallet all twelve had zero rows pointing
at the ten orphans: no sent_notes, no received notes in any pool, no spends. Deleting
them removes a txid the wallet could never resolve and nothing else.

The check is re-run here against the live file rather than trusted from the incident,
and the script ABORTS instead of deleting if any reference has appeared since. That is
the whole safety argument, so it must be evaluated now, not quoted from a past run.

Stop zallet first, or sqlite and the wallet will fight over the file:

    docker stop z3-testnet-zallet-1
    cp -f /var/lib/docker/volumes/z3-testnet-zallet/_data/wallet.db{,.bak-$(date +%s)}
    python3 deploy/z3/zallet-drop-orphan-txs.py
    docker start z3-testnet-zallet-1

VERIFIED ON THE 2026-08-07 INCIDENT: ten rows removed, wallet went 1393 -> 1383, no
other table moved, integrity ok, foreign_key_check clean. zallet came up, scanned from
4,243,553 to the tip, and /api/ready returned ready=true with a 1000.62 TAZ balance
about four minutes later.

ONE BOOT AFTER THE DELETE STILL CRASHED, on the same txid, and reading that log line
alone said the fix had failed. It had not - that boot was already superseded by the next
one, which recovered. Check `docker ps` and the newest log, not the first crash you find
in `docker logs`, or you will chase a fix that already worked.

WHAT THIS DOES NOT FIX: why sends reach the mempool and expire unmined in the first
place. Ten in ~8,000 blocks says it recurs, so this script is a mop, not a repair. The
durable fix is upstream - zallet treating an unfetchable mempool transaction as fatal is
the actual bug, and a wallet should drop a request it can never satisfy.
"""

import sqlite3
import sys

DB = sys.argv[1] if len(sys.argv) > 1 else "/var/lib/docker/volumes/z3-testnet-zallet/_data/wallet.db"

# A transaction id can be referenced under any of these column names. Collected by
# scanning the schema rather than hardcoding table names, so a pool added later (this
# schema already carries ironwood_* alongside sapling and orchard) is covered without
# anyone remembering to update a list here.
REF_COLUMNS = ("transaction_id", "spending_transaction_id", "dependent_transaction_id")


def main() -> int:
    conn = sqlite3.connect(DB)
    conn.execute("pragma foreign_keys=ON")
    q = lambda sql, *args: list(conn.execute(sql, args))

    stuck = [r[0] for r in q("select id_tx from transactions where raw is null and mined_height is null")]
    if not stuck:
        print("nothing to do: every unmined transaction still has its bytes")
        return 0
    print(f"candidates (raw NULL, never mined): {stuck}")
    placeholders = ",".join("?" * len(stuck))

    tables = [t for (t,) in q("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]

    referenced = 0
    for table in tables:
        for row in q(f"pragma table_info({table})"):
            column = row[1]
            if column in REF_COLUMNS:
                n = q(f"select count(*) from {table} where {column} in ({placeholders})", *stuck)[0][0]
                if n:
                    print(f"  REFERENCED: {table}.{column} = {n}")
                    referenced += n
    if referenced:
        print(f"ABORT: {referenced} reference(s) exist, so these are not orphans and deleting them would cascade")
        return 1
    print("  confirmed: 0 references from any table")

    before = {t: q(f"select count(*) from {t}")[0][0] for t in tables}
    conn.execute(f"delete from transactions where id_tx in ({placeholders})", stuck)
    conn.commit()
    after = {t: q(f"select count(*) from {t}")[0][0] for t in tables}

    # Report every table that moved, not just the one we aimed at. A cascade we did not
    # predict is exactly the failure this needs to surface, and "transactions went down
    # by ten" on its own would hide it.
    print("\nwhat actually changed:")
    for t in tables:
        if before[t] != after[t]:
            print(f"  {t}: {before[t]} -> {after[t]} (delta {after[t] - before[t]})")
    print(f"  integrity: {q('pragma integrity_check')[0][0]}")
    print(f"  foreign_key_check: {q('pragma foreign_key_check') or 'clean'}")
    print(f"  remaining raw-NULL unmined: {q('select count(*) from transactions where raw is null and mined_height is null')[0][0]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

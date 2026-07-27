# Chain snapshots: fast rebuild instead of a day-long resync

Zebra's initial sync is the one thing on this box that takes a day. If the box
dies, every other piece comes back in minutes (compose is `restart:
unless-stopped`, the watchdog restarts strays, the wallet account is
recreatable), but the chain state historically meant a full resync. zsnap
closes that gap: a scheduled export snapshots the synced state, and a fresh box
imports the latest snapshot before zebra ever starts. Recovery becomes minutes
of download plus a short catch-up sync from the snapshot tip.

The snapshot commands come from our zebra fork
([Giri-Aayush/zebra](https://github.com/Giri-Aayush/zebra), branch
`feat/snapshot-sync`). The build on the box lives at `/opt/zebrad-miner`.

## Cold vs hot: how the export coexists with a live node

By design, `export-snapshot` opens the state in RocksDB **read-only secondary
mode** (`disk_db.rs` at fork commit 21512fe calls
`open_cf_descriptors_as_secondary`): it follows the running node's files,
sees a view frozen at open time, and by construction cannot write to the
primary. In practice we saw one hot export against a mid-initial-sync,
CPU-pegged node die in the `Busy | IOError` panic arm with a misleading
"database already open" hint. The plausible mechanism is the secondary open
losing a race with the primary's WAL and MANIFEST rotation, a transient
failure that is likeliest under initial-sync write load and rare at tip
(one block per 75s).

So the script has two modes, `ZSNAP_MODE` in `/etc/faucet/zsnap.env`:

- **hot** (default): export against the live node, zero downtime. The export
  is retried (`ZSNAP_RETRIES`, default 3) because of the transient race
  above, which retry is the correct remedy for.
- **cold**: the fallback if hot still flakes at tip. Stop the zebra
  container, export with exclusive access, restart. The window is stop +
  export + start, minutes. The script pauses the stack watchdog first
  (otherwise it would docker-start zebra 30s into the window), refuses the
  window if the watchdog cannot be confirmed stopped, and restarts both
  through an exit trap plus a `recover` pass that systemd runs via
  `ExecStopPost` even if the export is killed, so no failure mode leaves
  zebra down or the watchdog paused. The window ends before compression
  starts, zstd needs nothing from the database.

Either way the secondary instance keeps its scratch outside the live state
dir (zebra puts it under `TMPDIR`, the script points `TMPDIR` at its private
workdir so the scratch is cleaned up with it), and the service runs under
`Nice=10` and `IOSchedulingClass=idle` so hot exports never compete with a
serving node.

One caveat: the export reads the state through the fork's database code, so
`/opt/zebrad-miner` must be format-compatible with the zebra writing the
state. A major format bump in one without the other makes the export refuse
to open, not corrupt anything. You do not have to reason about that from
version numbers, `preflight` answers it directly (below).

## When the export binary and the node disagree

The export binary and the node are two separate builds, and only one thing
about them matters: whether the binary can open the state the node wrote.
Ask it directly rather than comparing release numbers:

```bash
/opt/faucet/zsnap-export.sh preflight
```

`GO` means an export will work. `NO-GO` prints the binary's own error and
exits nonzero. It opens the state read-only through the same path the export
uses (`zebrad tip-height`), so it is safe on a live node and costs a second.
Run it before the first export on a box, and after upgrading either the node
image or the export binary.

**Compatibility as it stands.** The deployed `/opt/zebrad-miner` is built
from the fork at 6.0.0 and the node currently runs `zfnd/zebra:6.2.0`. Those
are compatible: zebra v6.0.0, v6.2.0 and the fork all declare state format
`28.0.0` (`zebra-state/src/constants.rs` is byte-identical between v6.2.0 and
the fork, as is `disk_format/upgrade.rs`), and their column family lists in
`finalized_state.rs` match exactly, which is what a read-only secondary open
actually requires. The state directory the node writes, `state/v28/testnet`,
is the one the binary looks for. A different release number is not by itself
a reason to rebuild.

**What would break it.** Moving either side onto a zebra release that bumps
the state format major version. At that point the export binary has to be
rebuilt from a fork rebased onto the node's release, and `preflight` says
`NO-GO` until it is. The rule is that the two move together, not that they
carry the same version string.

**If preflight says NO-GO.** Rebuild the export binary from the fork
(`github.com/Giri-Aayush/zebra`, branch `feat/snapshot-sync`) rebased onto
the node's zebra release, `cargo build --release -p zebrad`, drop it at
`/opt/zebrad-miner`, and re-run preflight. Snapshots taken before the bump
stay importable only by a binary of their own vintage, so take a fresh one
after the upgrade rather than trusting the old archive.

## Where the state actually lives

z3 keeps zebra's cache in a **named docker volume**, not a host directory.
Per z3's contract file the testnet volume is `z3-testnet-chain`, mounted at
`/home/zebra/.cache/zebra` inside the container. The scripts never assume a
host path: they resolve the real one with

```bash
docker volume inspect -f '{{.Mountpoint}}' z3-testnet-chain
```

and hand that to `--cache-dir`. Override the volume name with
`ZSNAP_CHAIN_VOLUME` if the compose project name ever changes.

## Scheduled export

`zsnap-export.sh` runs `export-snapshot` against the live volume, compresses
the result with zstd, writes a `.manifest-hash` sidecar, updates the `latest`
symlinks, and rotates old archives. Install (same pattern as the watchdog):

```bash
cd /opt/zcash-faucet/deploy/z3
cp zsnap-export.sh zsnap-import.sh /opt/faucet/ && chmod +x /opt/faucet/zsnap-*.sh
cp zsnap-export.service zsnap-export.timer /etc/systemd/system/
/opt/faucet/zsnap-export.sh preflight     # confirm the binary can read this state
systemctl daemon-reload && systemctl enable --now zsnap-export.timer
```

Watch it: `journalctl -u zsnap-export -f`. Run one now: `systemctl start
zsnap-export`.

Snapshots land in `/var/lib/zsnap/snapshots/`:

```
zsnap-testnet-3652108-a1b2c3d4e5f6.tar.zst                the snapshot
zsnap-testnet-3652108-a1b2c3d4e5f6.tar.zst.manifest-hash  its identity
latest.tar.zst -> zsnap-testnet-3652108-a1b2c3d4e5f6.tar.zst
latest.manifest-hash -> ...
```

Two gates protect the box, both bypassed with `ZSNAP_FORCE=1`: zebra must
report ready on its health port (a mid-sync snapshot would evict a better one
from rotation), and the snapshot filesystem must have about 1.5x the state
size free (raw export plus archive at peak), so a full disk cannot wedge the
node. `ZSNAP_KEEP` (default 2) bounds how many archives stay around. A flock
means overlapping timer fires skip instead of stacking.

Config goes in `/etc/faucet/zsnap.env` (both scripts and the units read it):
`ZSNAP_NETWORK`, `ZSNAP_CHAIN_VOLUME`, `ZSNAP_ZEBRAD`, `ZSNAP_DIR`,
`ZSNAP_KEEP`, `ZSNAP_UPLOAD_CMD`, `ZSNAP_EXPECT_HASH`, `ZSNAP_ZEBRAD_URL`.

## Restore on a fresh box

`zsnap-import.sh` is wired into `faucet-up` ahead of `deploy.sh`, so it runs
on every boot, including the very first one under cloud-init. It is a no-op
unless both hold: a source is configured, and the chain volume has no state
yet. That makes it safe to leave in the boot path forever.

To have a new box seed itself, uncomment and fill two files in
`deploy/cloud-init.yaml` before pasting it into the provider:

```
/etc/zsnap-restore-url     the snapshot archive URL (or on-box path)
/etc/faucet/zsnap.env      ZSNAP_ZEBRAD_URL (fresh boxes have no
                           /opt/zebrad-miner) and ZSNAP_EXPECT_HASH
```

The import accepts a local archive, a local exported directory, an
`https://...tar.zst` URL (resumable download, sidecar hash fetched from
`<url>.manifest-hash` if present), or a directory-style URL serving
`MANIFEST.json` and `chunks/`, which is handed to `zebrad import-snapshot
--url` and is also resumable.

Verification is zebrad's, not the script's: every chunk is hashed against the
manifest, and the manifest itself is authenticated against `--expect-hash`
(from `ZSNAP_EXPECT_HASH` or the sidecar) or a hash embedded in the binary.
With no trusted hash at all it refuses, unless `ZSNAP_ALLOW_UNVERIFIED=1`,
which is only for snapshots you exported yourself. The import is atomic: the
database is built in a temp dir inside the volume and renamed into place only
after every check passes, so a crash mid-import can never leave state that
zebra would open. On failure `faucet-up` logs it and falls through to a
normal full sync.

Manual restore on an existing box (state must be absent, wipe it first if you
mean it):

```bash
/opt/faucet/zsnap-import.sh /var/lib/zsnap/snapshots/latest.tar.zst
```

## Where snapshots live, and real disaster recovery

Locally: `/var/lib/zsnap/snapshots` on the box, rotated to the newest
`ZSNAP_KEEP`. That covers the common cases (bad upgrade, corrupted state,
rebuilding the stack in place) but not the box itself dying, which is the
scenario this exists for.

For that, get the artifact off the box. The pieces are already there:

- `ZSNAP_UPLOAD_CMD` in `/etc/faucet/zsnap.env` runs after every export with
  the archive path as its argument. Point it at anything that copies a file:
  `rclone copyto`, `s3cmd put`, a curl upload. Upload failures do not fail
  the export, the snapshot is still good locally.
- Host the archive plus its `.manifest-hash` sidecar (and `zebrad-miner`
  itself) anywhere plain HTTPS can serve them. Linode Object Storage in the
  same region is the obvious choice, a bucket URL works as-is with the
  cloud-init flow above.
- Keep the manifest hash somewhere that survives the box AND the bucket (it
  is one line, put it in the team notes). The hash is what makes a restored
  snapshot trustworthy rather than merely present.

Then a dead box is: create a new Linode, paste `cloud-init.yaml` with the two
zsnap files filled in, wait for the import and the catch-up sync, fund
nothing, reconfigure nothing. The wallet side is separate and smaller: back up
the `z3-testnet-zallet` volume or recreate the account and re-fund, see
"Operating notes" in [README.md](README.md).

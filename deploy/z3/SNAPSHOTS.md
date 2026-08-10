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

## Hosting: served from the box we already pay for (#7)

A verified snapshot is hardlinked into a publish directory and served by the Caddy that
already fronts the faucet:

    https://<domain>/snapshots/latest-testnet.txt              the pointer, 3 lines
    https://<domain>/snapshots/zsnap-testnet-<h>-<hash12>.tar.zst
    https://<domain>/snapshots/<same>.tar.zst.sha256           transport checksum
    https://<domain>/snapshots/<same>.manifest-hash            the identity

Read the pointer, download what it names, and hand the hash to `zsnap-import.sh` or
`zebrad import-snapshot --expect-hash`. No account, no credential: chain state is public.

### Why the box and not object storage

Every other option costs money for a file that is public data. Object storage is a
monthly bill that grows with each generation kept; GitHub Releases caps a single asset at
**2 GB** against an **8.5 GB** archive, so it is not merely expensive but unusable.

**The bandwidth math, because this is the one part that can become a charge.** Measured
**45 GB of egress in 10 days** (~135 GB/month) against Linode's ~1 TB included transfer,
with each download at **8.5 GB**. That leaves headroom for roughly **100 downloads a
month** - ample for disaster recovery, and nowhere near enough to survive being treated
as a public mirror. If that headroom ever starts disappearing, the transfer graph is the
place it will show, and object storage becomes the honest answer at that point rather
than this one.

There is **no directory listing**. You need the pointer to know what to ask for, which
keeps a crawler from walking three 8.5 GB archives for fun.

### Only verified snapshots are reachable

`/var/lib/zsnap/snapshots` also holds `.unverified` archives - the ones the export's own
check **rejected**. Caddy does not serve that directory. `zsnap-publish.sh` hardlinks the
verified artefacts into a separate `public` directory and Caddy serves only that, so an
archive we refused to trust cannot be handed to someone rebuilding a box.

Hardlinks rather than copies: same filesystem, so publishing 8.5 GB costs **zero extra
disk** on a box with 46 GB free.

### Disk, which is the other budget

One generation at 8.5 GB is 8.5 GB, and publishing adds nothing on top. `ZSNAP_KEEP`
is what to turn UP if you want more history; it must stay at least 1, and the export
refuses 0 rather than rotating away the snapshot it just made.

This defaulted to 3 and nothing on the box ever set it, so three archives accumulated
and the disk reached 85% on a 157 GB volume that has taken the box down before. A
default that silently overrides the operator's instruction is worth naming as the bug it
was.

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

It opens up to `ZSNAP_PREFLIGHT_TRIES` times (default 3) before saying
NO-GO, on purpose. A read-only open on a busy node can lose a race with the
primary's WAL rotation and fail transiently, and that error reads exactly
like a format mismatch. Preflight exists to stop people guessing between
those two, so it settles it rather than reporting it: a real mismatch fails
every attempt, a race does not.

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
report ready on its health port, **waited for rather than sampled once**
(`ZSNAP_READY_TRIES`, default 10 probes 30s apart). A single un-ready reading
used to abort the run and cost the whole six-hour cycle, and on testnet a
momentary lag past `READY_MAX_BLOCKS_BEHIND` is normal during min-difficulty
bursts (a mid-sync snapshot would evict a better one
from rotation), and the snapshot filesystem must have about 1.5x the state
size free (raw export plus archive at peak), so a full disk cannot wedge the
node. `ZSNAP_KEEP` (default 1) bounds how many archives stay around. A flock
means overlapping timer fires skip instead of stacking.

Config goes in `/etc/faucet/zsnap.env` (both scripts and the units read it):
`ZSNAP_NETWORK`, `ZSNAP_CHAIN_VOLUME`, `ZSNAP_ZEBRAD`, `ZSNAP_DIR`,
`ZSNAP_KEEP`, `ZSNAP_UPLOAD_CMD`, `ZSNAP_EXPECT_HASH`, `ZSNAP_ZEBRAD_URL`.

## One generation, and the restore still walks what is there

Retention is one archive: when a new snapshot lands the previous one is deleted.
The ordering is what makes that safe - verify, repoint `latest`, THEN rotate - so a
good archive is never traded for an unchecked one. A snapshot is only removed once
its replacement has decompressed, had every chunk checked against its manifest, and
matched the hash zebrad reported.

The import still walks newest to oldest rather than assuming a single file, because
`ZSNAP_KEEP` is configurable and a box set higher should restore correctly. What one
generation gives up is a snapshot that verifies but captures a BAD MOMENT: nothing
detects that, and there is no older copy to fall back on. Resync from genesis stays
possible, and import fails loudly rather than silently.

The second guarantee only holds because the restore path uses it.
`zsnap-import.sh` tries the newest generation, and if it fails its sha256, its
manifest verification, or the import itself, it says so loudly and tries the
next older one, then the one before. Only after **all** of them fail does it
exit nonzero, which lets `faucet-up` fall through to a normal genesis sync.
Three stored archives with a restore path that only reads the first would be
one layer wearing three costumes.

Point `/etc/zsnap-restore-url` at the snapshots **directory** (or a published
`latest-<net>.txt`, which lists every generation) to get the whole chain. A
single archive path or URL is still one candidate, deliberately: naming one
archive means you want that archive.

**`ZSNAP_EXPECT_HASH` pins one archive, not a chain.** A hash describes a
single snapshot, so when the source resolves to several generations the pin is
ignored with a log line and each generation is verified against its own hash:
`manifest_hash<N>=` from the pointer, or its `.manifest-hash` sidecar. Applying
one pin across a chain would verify generation 2 against generation 1's hash,
fail every fallback, and blame the archives. Set the pin when you name a single
archive; leave it unset for a chain and the per-generation hashes do the work.

### Disk

The peak is one raw export plus the archive being written, while all three
generations still exist. The export measures rather than guesses: the raw
export is about the state size, and the new archive is sized from the largest
existing one. It refuses when that peak will not fit, and separately warns when
the filesystem cannot hold the steady state at all, because the export still
helps today and the operator needs the number.

`faucet-metrics.sh` reports `faucet_disk_free_bytes`, `faucet_disk_free_percent`
and `faucet_disk_below_floor` per filesystem, and pages through the shared
alert sender under `METRICS_DISK_FLOOR_PCT` (default 10). A full disk stops
exports, backups and the chain at once, so it is worth its own alert.

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

## Publishing a snapshot so a replacement box can find it

`ZSNAP_UPLOAD_CMD` copies an archive off-box, but a pile of timestamped
archives in a bucket is not a recovery path: whoever rebuilds the box has to
know which file to take and which hash to trust, and usually only the person
who set it up does.

`zsnap-publish.sh` uploads the whole set a stranger needs, and a pointer:

```bash
cp zsnap-publish.sh /opt/faucet/ && chmod +x /opt/faucet/zsnap-publish.sh
# in /etc/faucet/zsnap.env
ZSNAP_PUBLISH_CMD=rclone copyto
ZSNAP_PUBLISH_BASE=linode:zcash-faucet-snapshots

/opt/faucet/zsnap-publish.sh --dry-run    # see exactly what it would do
/opt/faucet/zsnap-publish.sh              # publish the newest local snapshot
```

That puts four things in the remote: the archive, its `.manifest-hash`, a
`.sha256` for transport integrity, and `latest-<net>.txt`:

```
file=zsnap-testnet-4204800-deadbeefcafe.tar.zst
height=4204800
manifest_hash=<the hash import verifies against>
sha256=<of the archive>
published=2026-07-28T09:14:02Z
```

Three lines of plain text on purpose. Someone rebuilding a dead box at 3am
reads it with `curl` and knows what to fetch and what `--expect-hash` to
pass, without parsing anything or asking anyone.

The pointer is uploaded **last**, after the archive and both hashes have
landed. A pointer naming a half-uploaded archive is worse than a stale
pointer, so the ordering is deliberate and tested. Any upload failing aborts
with a message saying what did and did not make it up, and a rerun is safe.

Restoring from it on a fresh box:

```bash
curl -fsS https://<bucket>/latest-testnet.txt          # read file= and manifest_hash=
ZSNAP_EXPECT_HASH=<manifest_hash> /opt/faucet/zsnap-import.sh https://<bucket>/<file>
```

Or wire both values into `cloud-init.yaml` (`/etc/zsnap-restore-url` and
`ZSNAP_EXPECT_HASH` in `/etc/faucet/zsnap.env`) and a new box restores itself
on first boot with no operator at all.

Chain state is public, so nothing here is sensitive and the bucket can be
world-readable. The manifest hash is what makes a downloaded snapshot
trustworthy rather than merely present, which is why it belongs in your team
notes as well as next to the archive.

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

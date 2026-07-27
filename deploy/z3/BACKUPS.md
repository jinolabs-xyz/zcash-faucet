# Backups: the two things this box cannot regrow

Chain state re-syncs (and [SNAPSHOTS.md](SNAPSHOTS.md) makes that fast).
Containers rebuild. Config is in git. Exactly two things on this box exist
nowhere else:

1. **The wallet**: the age identity (`identity.txt`, the name z3's shipped
   `zallet.toml` configures, override with `BACKUP_IDENTITY_FILE` if yours
   differs) and `wallet.db`, both in the `z3-testnet-zallet` volume.
   Together they are the faucet's spending keys and funds. Lose them and
   the faucet's balance is gone for good. Inside the archive the identity
   always travels under the constant name `encryption-identity.txt`, so
   archives restore unchanged across config renames.
2. **The rate-limit ledger**: `faucet.db` in the `zcash-faucet_faucet_data`
   volume. Cooldown and daily-cap history. Losing it costs nothing but a
   window where users can re-claim early, second tier but free to include.

`backup.sh` bundles those, encrypts, rotates. `restore-backup.sh` puts them
back. Both read `/etc/faucet/backup.env`.

## Install

```bash
cd /opt/zcash-faucet/deploy/z3
cp backup.sh restore-backup.sh /opt/faucet/ && chmod +x /opt/faucet/*.sh
cp faucet-backup.service faucet-backup.timer /etc/systemd/system/
printf 'BACKUP_PASSPHRASE=%s\n' "$(openssl rand -base64 30)" > /etc/faucet/backup.env
chmod 600 /etc/faucet/backup.env
systemctl daemon-reload && systemctl enable --now faucet-backup.timer
```

**Now copy the passphrase somewhere that survives this box** (team password
store). The archives are AES256-encrypted with it and nothing else. An
off-box backup plus an on-box-only passphrase equals no backup.

Watch it: `journalctl -u faucet-backup -f`. Run one now: `systemctl start
faucet-backup`.

## What a run does

Every 6 hours (`:45`, offset from zsnap's `:20`) the timer produces

```
/var/lib/faucet-backups/archives/faucet-backup-testnet-<utc-stamp>.tar.gz.gpg
/var/lib/faucet-backups/archives/faucet-backup-testnet-<utc-stamp>.sha256
```

keeping the newest `BACKUP_KEEP` (default 14, ~3.5 days of history). The
databases are copied with sqlite's online backup API while the services
run, a plain `cp` of a live sqlite file can tear mid-checkpoint. Inside the
archive a `MANIFEST` records content hashes, which the restore verifies
after decryption. The `zaino/` indexer dir is excluded on purpose: it is
re-syncable chain data, not wallet material.

Gates: refuses to run without `BACKUP_PASSPHRASE` (never writes plaintext),
quiet no-op when the zallet volume does not exist yet (fresh box), loud
failure when the volume exists but the wallet files are missing (that is
never normal). A flock skips overlapping runs.

## Getting archives off the box

Local archives cover bad upgrades and fat fingers, not a dead box. Set

```
BACKUP_UPLOAD_CMD=rclone copyto        # or s3cmd put, or a curl wrapper
```

in `/etc/faucet/backup.env` and every run ships the fresh archive off-box
(called as `<cmd> <archive-path>`, upload failure never fails the backup).
The blob is already encrypted, any dumb storage is fine. Remember the
passphrase rule above.

## Restore

On the box (or a replacement box with docker up):

```bash
# stop everything that holds the databases open
docker compose -f docker-compose.faucet.yml down
docker compose --env-file .env.testnet down          # in the z3 dir

/opt/faucet/restore-backup.sh                        # newest local archive
/opt/faucet/restore-backup.sh /path/to/archive.tar.gz.gpg   # or a specific one

# bring the stack back
./deploy/deploy.sh    # or compose up -d both projects
```

The restore refuses while a zallet or faucet container is running, refuses
to overwrite an existing `wallet.db` or `faucet.db` unless `FORCE=1`, and
refuses any payload whose hashes do not match its manifest. Files land with
the right ownership (zallet's uid 1000, the ledger matching its volume).
Zallet re-scans from the wallet's stored birthday on first start, so expect
a short catch-up before balances look right.

## What this deliberately does not cover

Chain state (zsnap's job), the z3 and faucet config TOMLs (git and
deploy.sh regenerate them, the zallet RPC password is re-created by
deploy.sh on a fresh box), and Caddy's TLS material (re-issued
automatically). If the whole box is gone: new box via cloud-init, restore
the wallet with this script before first `up`, done.

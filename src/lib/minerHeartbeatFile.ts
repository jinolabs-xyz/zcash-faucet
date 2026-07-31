/**
 * Reads the miner heartbeat the box writes into the faucet's data volume.
 *
 * WHY A FILE. The miner is a systemd unit on the host and the faucet runs in a
 * container, so there is no shared process space and no journal to read. `/app/data`
 * is already a writable volume on the faucet container, so the writer drops the file
 * on the host side of that same volume and no compose change is needed.
 *
 * Every failure here returns `readable: false` rather than throwing or guessing. The
 * classifier turns that into `unknown`, which is the honest answer: we were told to
 * mine and cannot see whether we are.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MinerHeartbeat } from "./minerHeartbeat.ts";

const PATH = process.env.FAUCET_MINER_HEARTBEAT_PATH ?? join(process.cwd(), "data", "miner-heartbeat.json");

export function readMinerHeartbeat(): MinerHeartbeat | null {
  try {
    const raw = readFileSync(PATH, "utf8");
    const j = JSON.parse(raw) as { height?: unknown; at?: unknown; readable?: unknown };

    // The writer says readable:false when it could not determine template activity,
    // e.g. journald gave it nothing. Trust that over inventing a verdict.
    if (j.readable === false) return { height: null, at: null, readable: false };

    const at = typeof j.at === "number" && Number.isFinite(j.at) ? j.at : null;
    const height = typeof j.height === "number" && Number.isFinite(j.height) ? j.height : null;
    // A timestamp is the one field the verdict actually needs. Without it we know
    // nothing, so say so rather than reporting a heightless "mining".
    if (at === null) return { height: null, at: null, readable: false };
    return { height, at, readable: true };
  } catch {
    // Missing file, unreadable, or malformed JSON. All the same answer: cannot say.
    return null;
  }
}

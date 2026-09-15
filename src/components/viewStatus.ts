/**
 * What the Status, Analytics and Tools views read out of /api/status.
 *
 * DELIBERATELY NARROWER THAN THE PAGE'S OWN `Status`, and structurally compatible with
 * it, so the page passes `status` straight in. Two reasons for a separate declaration
 * rather than exporting the page's:
 *
 *   - page.tsx is being rewritten slice by slice by another seat right now, and a type
 *     exported out of it is a merge conflict in a file that already has three authors.
 *   - a view should declare what it reads. Handing every card the whole response makes
 *     it impossible to tell from the type which fields a change can safely touch.
 *
 * EVERY FIELD IS OPTIONAL AND EVERY NUMBER IS NULLABLE, which is not defensiveness. A
 * deploy older than any given field answers without it, the page polls a box that can be
 * mid-restart, and this file's whole job is to make "we were not told" a state the views
 * can render rather than a crash or a zero.
 */
import type { MinerReading } from "@/lib/miner/heartbeat";

export interface ViewDripDay {
  day: string;
  sent: number;
}

export interface ViewStatus {
  dripTaz: number;
  cooldownSeconds?: number;
  balanceTaz: number | null;
  drips?: { allTime: number; last7d: number; last30d: number; byDay?: ViewDripDay[] } | null;
  backend: { reachable: boolean; endpoint: string };
  node?: {
    ready: boolean;
    syncPercent: number | null;
    nodeHeight: number | null;
    externalHeight?: number | null;
  };
  miner?: Partial<MinerReading> & { active?: boolean };
  box?: { state: string; minerUnit?: string | null };
  sends?: { state: string; ok: number; failed: number; unknown: number; refused?: number; reason: string };
  reserve?: {
    targetTaz: number | null;
    lowTaz: number | null;
    refilling?: boolean;
    spendableTaz: number | null;
  };
}

/** The tones the cards paint with. "unknown" is a state, never a shade of ok. */
export type Tone = "ok" | "warn" | "bad" | "unknown";

/**
 * The word for a state we have not been given.
 *
 * One constant rather than a literal in nine places, because the failure it guards
 * against is one of those nine quietly becoming "–" or "" or "ok" in a later edit.
 */
export const UNKNOWN = "unknown";

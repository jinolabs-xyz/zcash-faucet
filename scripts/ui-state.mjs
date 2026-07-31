// Put the local UI into any state, in one command.
//
//   node scripts/ui-state.mjs                        healthy everything
//   node scripts/ui-state.mjs miner-stalled
//   node scripts/ui-state.mjs miner-stalled box-incomplete empty
//   node scripts/ui-state.mjs --list
//
// WHY THIS EXISTS. Every UI bug we have shipped was in a state nobody could reach
// without effort: the faucet empty, the miner alive but fetching nothing, the box
// missing a unit. The happy path gets tested because it is the one that appears when
// you run the thing. Everything else got found by the user. A state that takes a
// paragraph of setup to reach is a state that rots.
//
// THE FIXTURES ARE REFRESHED ON A TIMER, not written once. That is not tidiness. The
// miner heartbeat is judged on its own age, so a file written once reads "running"
// for thirty seconds and then silently becomes "no signal", which is a different
// state from the one you asked for. Writing once looks like it works and then lies.
//
// Run `npm run build` first. This starts the built app, not a dev server, because
// `npm run dev` does not bundle a `node:` import in src/lib/zcash/t2z.ts.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), ".ui-state");
const PORT = process.env.PORT ?? "3120";
const ZALLET_PORT = "28299";
const HOSH_PORT = "28324";

/**
 * Each dimension is independent and defaults to healthy, so `miner-stalled` alone
 * means "everything fine except the miner". Composing them is the point: the states
 * that bite are combinations nobody pictured.
 */
const DIMENSIONS = {
  miner: {
    "miner-running": "mining normally, recent template",
    "miner-proposal": "running in proposal mode, never submits",
    "miner-stalled": "alive and beating, but no template in 70 minutes (the real outage)",
    "miner-not-writing": "heartbeat file has not been updated in 15 minutes",
    "miner-unknown": "no heartbeat file at all, so the state is unverifiable",
  },
  box: {
    "box-complete": "every file the repo ships is installed and enabled",
    "box-incomplete": "two files missing and one unit installed but not enabled",
    "box-unknown": "no report, so we cannot say what the box has",
  },
  wallet: {
    ready: "balance well above the low mark",
    empty: "no balance at all",
    "topping-up": "balance inside the hysteresis band with shielding permitted",
  },
};

const DEFAULTS = { miner: "miner-running", box: "box-complete", wallet: "ready" };

function usage() {
  console.log("Put the local UI into a named state. Dimensions are independent and compose.\n");
  for (const [dim, states] of Object.entries(DIMENSIONS)) {
    console.log(`  ${dim}  (default ${DEFAULTS[dim]})`);
    for (const [name, why] of Object.entries(states)) console.log(`    ${name.padEnd(20)} ${why}`);
    console.log("");
  }
  console.log("  node scripts/ui-state.mjs miner-stalled box-incomplete");
}

const args = process.argv.slice(2);
if (args.includes("--list") || args.includes("-h") || args.includes("--help")) {
  usage();
  process.exit(0);
}

const chosen = { ...DEFAULTS };
for (const a of args) {
  const dim = Object.keys(DIMENSIONS).find((d) => a in DIMENSIONS[d]);
  if (!dim) {
    console.error(`unknown state "${a}". Run with --list to see them.`);
    process.exit(1);
  }
  chosen[dim] = a;
}

/* ── fixtures ─────────────────────────────────────────────────────────── */

const HEARTBEAT = join(DIR, "miner-heartbeat.json");
const BOX = join(DIR, "box-integrity.json");
const ago = (s) => new Date(Date.now() - s * 1000).toISOString();

// Thresholds are the writer's to publish, so the fixture carries them exactly as the
// real miner does. Hardcoding them in the reader is the drift this design removed.
const beat = (over) => ({
  schema: 1,
  writtenAt: ago(2),
  beatSeconds: 5,
  staleAfterSeconds: 30,
  templateSeconds: 60,
  templateStaleAfterSeconds: 360,
  mode: "submit",
  startedAt: ago(3600),
  lastTemplateAt: ago(20),
  lastTemplateHeight: 4_221_033,
  lastErrorStage: null,
  lastErrorAt: null,
  consecutiveErrors: 0,
  ...over,
});

function writeFixtures() {
  const miner = {
    "miner-running": beat({}),
    "miner-proposal": beat({ mode: "proposal" }),
    // Fresh writtenAt beside a stale lastTemplateAt. That divergence IS the outage:
    // anything keying off liveness alone calls this healthy.
    "miner-stalled": beat({
      lastTemplateAt: ago(70 * 60),
      lastTemplateHeight: 4_220_110,
      lastErrorStage: "getblocktemplate",
      lastErrorAt: ago(3),
      consecutiveErrors: 840,
    }),
    "miner-not-writing": beat({ writtenAt: ago(900), lastTemplateAt: ago(905) }),
    "miner-unknown": null,
  }[chosen.miner];

  const box = {
    "box-complete": { expected: 14, present: 14, notEnabled: 0, at: Date.now() },
    "box-incomplete": { expected: 14, present: 12, notEnabled: 1, at: Date.now() },
    "box-unknown": null,
  }[chosen.box];

  // A null fixture means NO FILE, which is not the same as an empty one. Both readers
  // treat absence as unverifiable, and writing `{}` would exercise a different path.
  if (miner) writeFileSync(HEARTBEAT, JSON.stringify(miner, null, 2));
  if (box) writeFileSync(BOX, JSON.stringify(box, null, 2));
}

// REFUSE TO START ALONGSIDE ANOTHER INSTANCE. Both would rewrite the same fixture
// files on their own timers, and the loser's state wins at random, so the UI shows a
// state nobody asked for while the command that asked looks like it worked. Found by
// doing exactly that: killing the listening ports leaves this parent alive, still
// refreshing the old fixtures, and the next run reported "healthy" while rendering a
// stalled miner. Port check rather than a lockfile, because a lockfile survives a
// SIGKILL and then blocks every later run for no reason.
try {
  await fetch(`http://127.0.0.1:${PORT}/api/status`, { signal: AbortSignal.timeout(1500) });
  console.error(
    `something is already serving port ${PORT}. If that is another ui-state.mjs, stop it\n` +
      "with ctrl-c rather than killing the port: this process owns the fixture files and\n" +
      "keeps rewriting them, so leaving it running makes the next state silently wrong.",
  );
  process.exit(1);
} catch { /* nothing there, which is what we want */ }

mkdirSync(DIR, { recursive: true });
writeFixtures();
const refresh = setInterval(writeFixtures, 2000);

/* ── the stack ────────────────────────────────────────────────────────── */

const wallet = {
  ready: { BALANCE_TAZ: "15" },
  empty: { BALANCE_TAZ: "0" },
  // Inside the band, and shielding permitted, so the reserve loop actually engages
  // rather than reporting that it is forbidden to act.
  "topping-up": { BALANCE_TAZ: "15", FAUCET_RESERVE_LOW_TAZ: "5", FAUCET_RESERVE_TARGET_TAZ: "30", FAUCET_SHIELD_COINBASE: "true", FAUCET_MINER_ACTIVE: "true" },
}[chosen.wallet];

const children = [];
const run = (label, cmd, argv, env) => {
  const c = spawn(cmd, argv, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  c.stdout.on("data", (d) => process.stdout.write(`[${label}] ${d}`));
  c.stderr.on("data", (d) => process.stderr.write(`[${label}] ${d}`));
  children.push(c);
  return c;
};

run("zallet", "node", ["scripts/fake-zallet.mjs"], { PORT: ZALLET_PORT, ...wallet });
// Must be answering BEFORE the app starts. If the app's first tip refresh misses it,
// the oracle caches the real network tip, decides our node is half a million blocks
// behind and refuses every claim for the rest of the run.
run("hosh", "node", ["scripts/fake-hosh.mjs"], { PORT: HOSH_PORT });

const waitFor = async (url, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

if (!(await waitFor(`http://127.0.0.1:${HOSH_PORT}/`))) {
  console.error("the tip oracle fixture never came up, so every claim would be refused. Stopping.");
  for (const c of children) c.kill();
  process.exit(1);
}

run("faucet", "npm", ["start"], {
  PORT,
  FAUCET_SENDER: "zallet",
  ZALLET_RPC_URL: `http://127.0.0.1:${ZALLET_PORT}/`,
  ZALLET_ACCOUNT: "fake-account",
  ZALLET_ADDRESS: "utest1fake",
  ZALLET_MIN_CONF: "0",
  ZALLET_POLL_MS: "250",
  FAUCET_CHALLENGE: "pow",
  FAUCET_POW_BITS: "12",
  RATE_LIMIT_SALT: "ui-state-not-a-secret",
  HOSH_URL: `http://127.0.0.1:${HOSH_PORT}/`,
  FAUCET_MINER_HEARTBEAT_PATH: HEARTBEAT,
  FAUCET_BOX_REPORT_PATH: BOX,
  FAUCET_RESERVE_CHECK_SECONDS: "5",
  ...wallet,
});

if (await waitFor(`http://127.0.0.1:${PORT}/api/status`)) {
  console.log(`\n  ${Object.values(chosen).join("  ")}\n  http://localhost:${PORT}\n`);
} else {
  console.error("\n  the app never answered /api/status. Did you run `npm run build`?\n");
}

const stop = () => {
  clearInterval(refresh);
  for (const c of children) c.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

//! Solo CPU miner for public Zcash testnet blocks, pointed at our own zebra.
//!
//! This is the faucet's funding path: blocks it wins pay the coinbase to the
//! address zebra is configured to mine to (ZEBRA_MINING__MINER_ADDRESS), and
//! that balance is what the faucet drips out.
//!
//! Loop: getblocktemplate, lay out the header, run tromp's Equihash 200,9
//! solver over nonces, check candidates against the target, submit. The
//! solver comes from librustzcash's equihash crate, the same one zebra's
//! internal miner uses, so no proof of work is hand-rolled here.
//!
//! It works on a CPU only because of testnet's minimum-difficulty rule: after
//! a gap between blocks the target drops to the floor, and at that point a
//! single core lands blocks. On mainnet this would be pointless.
//!
//! Modes:
//!   MINER_MODE=proposal   solve, then validate via getblocktemplate
//!                         mode=proposal. Nothing is ever submitted. This is
//!                         the offline acceptance gate.
//!   MINER_MODE=submit     the same, then submitblock for real.
//!
//! Config comes from the environment (see MINING.md), logs go to stdout for
//! journald.

mod block;
mod heartbeat;
mod rpc;
mod sync;
mod template;

use std::{
    env,
    path::PathBuf,
    process,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::json;

use block::{expand_target, meets_target, serialize_block, Header};
use rpc::Rpc;

/// One place that records a failed stage, so every call site passes a fixed token and none
/// of them can pass a formatted error. See deploy/z3/MINER-HEARTBEAT.md: the file is served
/// publicly and an error string is where an RPC URL with credentials would end up.
fn beat_error(hb: &Arc<Mutex<heartbeat::State>>, stage: &'static str) {
    if let Ok(mut g) = hb.lock() {
        g.error(stage);
    }
}
use template::Template;

struct Config {
    rpc_url: String,
    cookie_path: PathBuf,
    threads: usize,
    mode: Mode,
    poll_secs: u64,
    /// Give up on a template after this long and fetch a fresh one, so we are
    /// never grinding a height the chain has moved past.
    template_secs: u64,
    /// Refuse to mine while zebra is more than this many blocks behind its own estimate of
    /// the network. See sync.rs for why 100 and not 2. Bounded on both sides: 0 and
    /// anything past sync::MAX_LAG_CEILING are refused, because a miner on a node that is
    /// behind extends a fork with our work and there is no value that makes that safe.
    max_lag: u64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    Proposal,
    Submit,
}

/// Upper bound on solver threads, set by what the service unit's MemoryMax
/// affords: ~144 MB per thread against MemoryMax=1G. Keep the two in step.
const MAX_THREADS: usize = 4;

/// Solver memory per thread, and the MemoryMax in zcash-testnet-miner.service.
const SOLVER_MB_PER_THREAD: usize = 144;
const UNIT_MEMORY_MAX_MB: usize = 1024;

// The ceiling only means anything if the worst case fits under the unit's cap.
// Raising MAX_THREADS without raising MemoryMax would trade a clear config
// error for a cgroup kill in a 30s restart loop, so fail the build instead.
// The 128 MB is headroom for the runtime itself, not just the solvers.
const _: () = assert!(
    MAX_THREADS * SOLVER_MB_PER_THREAD < UNIT_MEMORY_MAX_MB - 128,
    "MAX_THREADS does not fit under MemoryMax in zcash-testnet-miner.service: \
     raise both together or lower the ceiling"
);

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn now_unix() -> u32 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as u32)
        .unwrap_or(0)
}

fn log(msg: &str) {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    println!("[{secs}] miner: {msg}");
}

fn load_config() -> Result<Config, String> {
    let mode = match env_or("MINER_MODE", "proposal").as_str() {
        "proposal" => Mode::Proposal,
        "submit" => Mode::Submit,
        other => return Err(format!("MINER_MODE must be proposal or submit, got '{other}'")),
    };
    let threads: usize = env_or("MINER_THREADS", "1")
        .parse()
        .map_err(|e| format!("MINER_THREADS: {e}"))?;
    if threads == 0 || threads > MAX_THREADS {
        return Err(format!(
            "MINER_THREADS must be 1..={MAX_THREADS}, got {threads}. Each solver thread holds \
             ~144 MB and the service unit caps MemoryMax=1G, so a higher count would be \
             cgroup-killed in a restart loop instead of failing here. Raise both together if \
             you really want more (CPUQuota=150% makes past 2 pointless anyway)."
        ));
    }
    Ok(Config {
        rpc_url: env_or("MINER_RPC_URL", "http://127.0.0.1:18232"),
        cookie_path: PathBuf::from(env_or("MINER_COOKIE_PATH", "/var/run/auth/.cookie")),
        threads,
        mode,
        poll_secs: env_or("MINER_POLL_SECS", "5")
            .parse()
            .map_err(|e| format!("MINER_POLL_SECS: {e}"))?,
        template_secs: env_or("MINER_TEMPLATE_SECS", "60")
            .parse()
            .map_err(|e| format!("MINER_TEMPLATE_SECS: {e}"))?,
        max_lag: {
            let n: u64 = env_or("MINER_MAX_LAG", &sync::DEFAULT_MAX_LAG.to_string())
                .parse()
                .map_err(|e| format!("MINER_MAX_LAG: {e}"))?;
            if n == 0 || n > sync::MAX_LAG_CEILING {
                return Err(format!(
                    "MINER_MAX_LAG must be 1..={}, got {n}. There is no off switch: a miner that \
                     works on a node that is behind extends a private fork with our own blocks, \
                     which is what happened on 2026-09-07.",
                    sync::MAX_LAG_CEILING
                ));
            }
            n
        },
    })
}

fn main() {
    let config = match load_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("miner: bad configuration: {e}");
            process::exit(2);
        }
    };

    let rpc = Rpc::new(&config.rpc_url, &config.cookie_path, 30);
    log(&format!(
        "starting: url={} mode={:?} threads={} cookie={}",
        config.rpc_url,
        config.mode,
        config.threads,
        if rpc.has_cookie() {
            config.cookie_path.display().to_string()
        } else {
            "none (unauthenticated)".to_string()
        }
    ));
    if config.mode == Mode::Proposal {
        log("proposal mode: solved blocks are validated, never submitted");
    }
    log(&format!(
        "sync guard: no mining while zebra is more than {} blocks behind its estimate (MINER_MAX_LAG)",
        config.max_lag
    ));

    // MINER_HEARTBEAT_PATH has no default that points anywhere real: a missing configuration
    // must not write to a stale path and must not be mistaken for a working heartbeat. Unset
    // means no file, and the reader then reports cannot-verify, which is the honest answer.
    let hb_path = env::var("MINER_HEARTBEAT_PATH").ok().filter(|p| !p.is_empty());
    match &hb_path {
        Some(p) => log(&format!("heartbeat: {p} (every {}s)", config.poll_secs.max(1))),
        None => log("heartbeat: MINER_HEARTBEAT_PATH is unset, so nothing will report whether this miner is working"),
    }
    let hb = heartbeat::start(
        hb_path.map(PathBuf::from),
        match config.mode {
            Mode::Submit => "submit",
            Mode::Proposal => "proposal",
        },
        config.poll_secs.max(1),
        config.template_secs,
    );

    // A node that is behind for hours would otherwise write a line every poll. One a minute
    // is enough for a journal to show the wait and its progress.
    let mut last_wait_log: Option<Instant> = None;
    loop {
        match mine_once(&rpc, &config, &hb) {
            Ok(Outcome::Waiting { why }) => {
                let due = last_wait_log.is_none_or(|t| t.elapsed() >= Duration::from_secs(60));
                if due {
                    log(&format!("not mining: {why}"));
                    last_wait_log = Some(Instant::now());
                }
                thread::sleep(Duration::from_secs(config.poll_secs.max(5)));
            }
            Ok(Outcome::Accepted { height }) => {
                if let Ok(mut g) = hb.lock() {
                    g.submitted(true);
                }
                log(&format!("block at height {height} ACCEPTED by zebra"));
            }
            Ok(Outcome::ProposalValid { height }) => {
                log(&format!(
                    "height {height}: proposal VALID (not submitted, MINER_MODE=submit to go live)"
                ));
            }
            Ok(Outcome::NoSolution { height }) => {
                log(&format!("height {height}: no solution in this window, refetching"));
            }
            Ok(Outcome::Rejected { height, reason }) => {
                if let Ok(mut g) = hb.lock() {
                    g.submitted(false);
                }
                // The reason is LOGGED, never written to the heartbeat: it is zebra's text and
                // the heartbeat is public.
                log(&format!("height {height}: zebra rejected the block: {reason}"));
            }
            Err(e) => {
                log(&format!("error: {e}"));
                thread::sleep(Duration::from_secs(config.poll_secs.max(5)));
            }
        }
    }
}

enum Outcome {
    /// The sync guard refused: the node is behind its own estimate by more than
    /// MINER_MAX_LAG, or has no peers, or fell behind between the template and the
    /// submit. Nothing was submitted; `why` is the sentence for the journal. See sync.rs.
    Waiting { why: String },
    Accepted { height: u32 },
    ProposalValid { height: u32 },
    Rejected { height: u32, reason: String },
    NoSolution { height: u32 },
}

// `hb` is written at the POINTS where things happen, not derived from the return value.
// Deriving it would misreport: a template fetched successfully followed by a failing
// submitblock returns Err, and recording that as "no template" would show a stall while
// templates were in fact flowing. A false alarm is not a safe direction either.
fn mine_once(rpc: &Rpc, config: &Config, hb: &Arc<Mutex<heartbeat::State>>) -> Result<Outcome, String> {
    // Timings for the orphan analysis (issue #32). The question is whether we
    // lose the network race because our block is late, or because a dominant
    // miner never builds on us. These numbers settle it: if template age and
    // solve-to-submit are small fractions of the block interval, latency is
    // not the cause and the answer is hashrate share. See MINING.md.
    // THE SYNC GUARD RUNS FIRST, before any template exists to be tempted by. Asking the
    // node where it stands costs two cheap calls per iteration; mining on a node that was
    // behind cost an afternoon of blocks on a private fork (2026-09-07).
    if let Some(why) = sync_guard(rpc, config, hb)? {
        return Ok(Outcome::Waiting { why });
    }

    let fetched_at = Instant::now();
    let raw = rpc
        .call("getblocktemplate", json!([{"mode": "template"}]))
        .inspect_err(|_| beat_error(hb, "getblocktemplate"))?;
    let t: Template =
        serde_json::from_value(raw).map_err(|e| format!("could not parse the template: {e}"))?;
    // The template is in hand and parsed: this is the moment that proves templates flow,
    // and it is the one the 70-minute outage would have contradicted.
    if let Ok(mut g) = hb.lock() {
        g.template_ok(u64::from(t.height));
    }
    let target = expand_target(&t.bits)?;
    let header = Header::from_template(&t)?;

    // curtime is when the node built the template. Wall-clock skew makes this
    // approximate, so it is reported as a floor rather than a precise age.
    let template_built_at_unix = t.cur_time;
    log(&format!(
        "template: height {} bits {} txs {} fetch {:.2}s",
        t.height,
        t.bits,
        t.transactions.len(),
        fetched_at.elapsed().as_secs_f64()
    ));

    let solve_started = Instant::now();
    let Some(solved) = solve(&header, &target, config) else {
        return Ok(Outcome::NoSolution { height: t.height });
    };
    if let Ok(mut g) = hb.lock() {
        g.solved();
    }
    let solve_secs = solve_started.elapsed().as_secs_f64();
    let solved_at = Instant::now();

    let block_hex = hex::encode(serialize_block(&solved, &t)?);
    // Template age at solve: how stale the parent we built on was by the time
    // we had a solution. If this is small relative to the block interval, a
    // faster poll cannot be what saves our blocks.
    let template_age_secs = now_unix().saturating_sub(template_built_at_unix);
    log(&format!(
        "height {}: found a block, hash {} solve {:.1}s template_age {}s",
        t.height,
        hex::encode(display_hash(&solved.hash_le())),
        solve_secs,
        template_age_secs
    ));

    // Always validate through proposal mode first: it runs zebra's full block
    // check without touching the chain, so a malformed block costs nothing.
    let verdict = rpc
        .call(
            "getblocktemplate",
            json!([{"mode": "proposal", "data": block_hex, "capabilities": ["proposal"]}]),
        )
        .inspect_err(|_| beat_error(hb, "proposal"))?;
    if !verdict.is_null() {
        return Ok(Outcome::Rejected {
            height: t.height,
            reason: format!("proposal check said {verdict}"),
        });
    }

    if config.mode == Mode::Proposal {
        return Ok(Outcome::ProposalValid { height: t.height });
    }

    // THE GUARD AGAIN, before the one call that changes the chain. Up to a minute passes
    // between the first check and here (the solve window plus two RPCs), and the watchdog's
    // deepest heal rewinds the node ~100 blocks inside that: a block built on the old tip
    // and submitted into the rewound node is exactly how a wedged tip "comes straight
    // back". A solved block is discarded rather than submitted into a node that is no
    // longer where it was.
    match sync_guard(rpc, config, hb) {
        Ok(None) => {}
        Ok(Some(why)) => {
            log(&format!(
                "height {}: solved block DISCARDED, the node moved under us before submit: {why}",
                t.height
            ));
            return Ok(Outcome::Waiting { why });
        }
        Err(e) => {
            // Still fail closed, and still say so: a node that cannot be re-read a minute
            // after it was fine is more likely a blip than a fork, and this is the one
            // place a won block is lost, so the journal must record the loss, not just
            // "error".
            log(&format!(
                "height {}: solved block DISCARDED, the node could not be re-checked before submit: {e}",
                t.height
            ));
            return Err(e);
        }
    }

    // null from submitblock means accepted, anything else is a rejection
    // reason ("duplicate", "rejected", ...).
    let submitted = rpc
        .call("submitblock", json!([block_hex]))
        .inspect_err(|_| beat_error(hb, "submitblock"))?;
    // Solve-to-submit covers serialization plus the proposal check plus the
    // submit call: the whole window between having a winning block and the
    // network hearing about it.
    log(&format!(
        "height {}: solve_to_submit {:.2}s",
        t.height,
        solved_at.elapsed().as_secs_f64()
    ));
    if submitted.is_null() {
        Ok(Outcome::Accepted { height: t.height })
    } else {
        Ok(Outcome::Rejected {
            height: t.height,
            reason: submitted.to_string(),
        })
    }
}

/// The two isolation checks, recorded in the heartbeat. `Ok(Some(why))` means do not mine
/// and says why; `Ok(None)` means the node is fit to build on; `Err` is a node that would
/// not answer or answered something unreadable, recorded under its own stage so the panel
/// can tell "would not answer" from "answered nonsense", and never mined on.
fn sync_guard(rpc: &Rpc, config: &Config, hb: &Arc<Mutex<heartbeat::State>>) -> Result<Option<String>, String> {
    let info = rpc
        .call("getblockchaininfo", json!([]))
        .inspect_err(|_| beat_error(hb, "getblockchaininfo"))?;
    let verdict = sync::verdict(&info, config.max_lag).inspect_err(|_| beat_error(hb, "syncstate"))?;
    let peers = rpc
        .call("getpeerinfo", json!([]))
        .inspect_err(|_| beat_error(hb, "getpeerinfo"))?;
    let alone = sync::isolated(&peers).inspect_err(|_| beat_error(hb, "syncstate"))?;
    match verdict {
        sync::Verdict::Wait { lag, blocks, estimated } => {
            if let Ok(mut g) = hb.lock() {
                g.node_lag(lag, Some("behind"));
            }
            Ok(Some(format!(
                "node is {lag} blocks behind its own estimate (verified {blocks}, estimated {estimated}); mining resumes within {} (MINER_MAX_LAG)",
                config.max_lag
            )))
        }
        sync::Verdict::Mine { lag } if alone => {
            if let Ok(mut g) = hb.lock() {
                g.node_lag(lag, Some("no-peers"));
            }
            Ok(Some("node has NO PEERS; a node with no peers believes it is at the tip and mines a fork of it".into()))
        }
        sync::Verdict::Mine { lag } => {
            if let Ok(mut g) = hb.lock() {
                g.node_lag(lag, None);
            }
            Ok(None)
        }
    }
}

/// Runs the solver across `threads` nonce ranges until something beats the
/// target or the window expires. Each thread owns a disjoint nonce space by
/// stamping its id into the high byte, so no two threads repeat work.
fn solve(header: &Header, target: &[u8; 32], config: &Config) -> Option<Header> {
    let deadline = Instant::now() + Duration::from_secs(config.template_secs);
    let found = Arc::new(AtomicBool::new(false));
    let mut handles = Vec::with_capacity(config.threads);

    for id in 0..config.threads {
        let mut header = header.clone();
        let target = *target;
        let found = Arc::clone(&found);
        handles.push(thread::spawn(move || {
            let mut counter: u64 = 0;
            while !found.load(Ordering::Relaxed) && Instant::now() < deadline {
                let mut nonce = [0u8; 32];
                nonce[0] = id as u8;
                nonce[1..9].copy_from_slice(&counter.to_le_bytes());
                counter += 1;
                header.nonce = nonce;

                // solve_200_9 takes the PARTIAL input (the 108-byte header
                // prefix) and appends the nonce its closure yields. Passing
                // the prefix+nonce here would hash 32 bytes too many and
                // every solution would fail consensus. One run per nonce, so
                // the closure yields once and then stops.
                let mut once = Some(nonce);
                let solutions = equihash::tromp::solve_200_9(&header.prefix, || once.take());

                for solution in solutions {
                    header.solution = solution;
                    if meets_target(&header.hash_le(), &target) {
                        found.store(true, Ordering::Relaxed);
                        return Some(header.clone());
                    }
                }
            }
            None
        }));
    }

    handles
        .into_iter()
        .filter_map(|h| h.join().ok().flatten())
        .next()
}

/// Wire order is little-endian, humans and block explorers read the reverse.
fn display_hash(hash_le: &[u8; 32]) -> [u8; 32] {
    let mut out = *hash_le;
    out.reverse();
    out
}

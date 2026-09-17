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
        Arc, Condvar, Mutex,
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
    let (hb, resumed) = heartbeat::start(
        hb_path.map(PathBuf::from),
        match config.mode {
            Mode::Submit => "submit",
            Mode::Proposal => "proposal",
        },
        config.poll_secs.max(1),
        config.template_secs,
    );
    // #645: the counts are LIFETIME figures resumed from the file, so the journal has to say
    // which of the two it got. "resumed 69" and "could not read it" produce the same page
    // otherwise, and only one of them means the number is trustworthy.
    if let Some(r) = &resumed {
        log(&r.journal());
    }

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
                    g.rejected(&reason);
                }
                // The TEXT is logged and never written to the heartbeat - that file is public and
                // an error string is where a credentialled URL ends up. A fixed token goes in, so
                // a rejection is a cause and not just a count from outside the box.
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

    // THE WATCHER RUNS FOR THE LENGTH OF THE SOLVE AND NO LONGER (#657). The parent is the
    // template's own previousblockhash - the block we are building on - so "has the tip moved" is
    // a string comparison against the thing we would be extending.
    let solve_started = Instant::now();
    let abandon = Arc::new(AtomicBool::new(false));
    let stop_watch = Arc::new(Shutdown::new());
    // A SCOPED THREAD, so the watcher can borrow the rpc client rather than forcing `Rpc` to be
    // Clone for the sake of a thread that outlives nothing. The scope joins it before returning,
    // which is also what guarantees no watcher survives the solve it belongs to.
    let solved = thread::scope(|scope| {
        let watcher = {
            let parent = t.previous_block_hash.as_str();
            let abandon = Arc::clone(&abandon);
            let stop = Arc::clone(&stop_watch);
            scope.spawn(move || {
                watch_tip(
                    parent.to_owned(),
                    abandon,
                    stop,
                    Duration::from_millis(1000),
                    || {
                        rpc.call("getbestblockhash", json!([]))
                            .ok()
                            .and_then(|v| v.as_str().map(str::to_owned))
                    },
                )
            })
        };
        let solved = solve(&header, &target, config, &abandon);
        // Stopped either way, so a solve that ends for any other reason does not leave a thread
        // polling the node for the rest of the process's life.
        stop_watch.stop();
        let _ = watcher.join();
        solved
    });
    if abandon.load(Ordering::Relaxed) {
        // COUNTED, not just logged (#660 shipped without this). An abandoned solve and a genuine
        // no-solution-in-window were identical from outside the box, so the panel could not say
        // whether the watcher was working or the miner was not solving at all.
        if let Ok(mut g) = hb.lock() {
            g.abandoned();
        }
        log(&format!(
            "abandoned height {} after {:.2}s: the tip moved off {} while we were solving",
            t.height,
            solve_started.elapsed().as_secs_f64(),
            &t.previous_block_hash[..16.min(t.previous_block_hash.len())]
        ));
        return Ok(Outcome::NoSolution { height: t.height });
    }
    let Some(solved) = solved else {
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
/// Watches the chain while a solve runs and reports whether the parent we are building on is
/// still the tip.
///
/// WHY THIS EXISTS (#657). `solve()` used to loop on exactly two conditions - a solution found, or
/// the window expired - and neither of them is "a new block arrived". Testnet produces a block
/// every 9-13s and our window is 8s, so the tip moved during roughly 80% of windows and everything
/// after that point was work against a dead parent. It is not theoretical: the one block we won was
/// refused by our own node with
/// `proposal-is-not-based-on-the-current-best-chain-tip`.
///
/// POLLED, NOT PUSHED, because zebra offers no subscription and one cheap call a second is well
/// inside what the node serves. `getbestblockhash` is the question actually being asked - a height
/// comparison would miss a same-height reorg, which is exactly the case that produces a rejected
/// proposal.
///
/// THE ABORT LANDS ON AN ITERATION BOUNDARY and that is deliberate. One `solve_200_9` call is
/// uninterruptible and took at least 2.4s on the box, so the flag is read between iterations and
/// waste is bounded at about one iteration rather than the whole window. Trying to interrupt
/// mid-Equihash would mean patching the solver.
/// The watcher's sleep, interruptible.
///
/// WHY NOT `thread::sleep` (SDE-UI, review of #660). A plain sleep is uninterruptible, so the main
/// thread's `stop` + `join()` blocked until the current 1s sleep ended - measured at **956ms**. The
/// abandon path was fine (the watcher returns immediately on a change), but the cost landed on the
/// two paths that matter most: a solve that hit its deadline paid ~1s of idle per pass, and A SOLVE
/// THAT FOUND A BLOCK held it for a second before submitting. In a race whose only previous win was
/// rejected for a stale parent, adding a window in which the tip can move AFTER we have won is the
/// opposite of what this PR is for.
pub struct Shutdown {
    stopped: Mutex<bool>,
    wake: Condvar,
}

impl Shutdown {
    pub fn new() -> Self {
        Self { stopped: Mutex::new(false), wake: Condvar::new() }
    }
    /// Ends any wait in progress immediately.
    pub fn stop(&self) {
        if let Ok(mut g) = self.stopped.lock() {
            *g = true;
        }
        self.wake.notify_all();
    }
    pub fn is_stopped(&self) -> bool {
        self.stopped.lock().map(|g| *g).unwrap_or(true)
    }
    /// Waits up to `d`, returning as soon as `stop()` is called. True when stopped.
    fn wait(&self, d: Duration) -> bool {
        let Ok(g) = self.stopped.lock() else { return true };
        if *g {
            return true;
        }
        // A POISONED LOCK ENDS THE WAIT rather than parking for ever: the watcher is a helper, and
        // a helper that cannot be stopped is the failure this whole struct exists to remove.
        match self.wake.wait_timeout(g, d) {
            Ok((g, _)) => *g,
            Err(_) => true,
        }
    }
}

impl Default for Shutdown {
    fn default() -> Self {
        Self::new()
    }
}

pub fn watch_tip<F>(
    parent: String,
    abandon: Arc<AtomicBool>,
    stop: Arc<Shutdown>,
    poll: Duration,
    mut current_tip: F,
) where
    F: FnMut() -> Option<String>,
{
    while !stop.is_stopped() && !abandon.load(Ordering::Relaxed) {
        // A FAILED READ IS NOT A CHANGED TIP. An unreachable node would otherwise abandon every
        // solve for ever, which is worse than the bug: the miner would do no work at all rather
        // than some wasted work. The deadline is still the backstop.
        if let Some(tip) = current_tip() {
            if tip != parent {
                abandon.store(true, Ordering::Relaxed);
                return;
            }
        }
        if stop.wait(poll) {
            return;
        }
    }
}

fn solve(
    header: &Header,
    target: &[u8; 32],
    config: &Config,
    abandon: &Arc<AtomicBool>,
) -> Option<Header> {
    let deadline = Instant::now() + Duration::from_secs(config.template_secs);
    let found = Arc::new(AtomicBool::new(false));
    let mut handles = Vec::with_capacity(config.threads);

    for id in 0..config.threads {
        let mut header = header.clone();
        let target = *target;
        let found = Arc::clone(&found);
        let abandon = Arc::clone(abandon);
        handles.push(thread::spawn(move || {
            let mut counter: u64 = 0;
            // THE THIRD CONDITION, and the whole of #657: the parent stopped being the tip.
            while !found.load(Ordering::Relaxed)
                && !abandon.load(Ordering::Relaxed)
                && Instant::now() < deadline
            {
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

#[cfg(test)]
mod tip_watch_tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    /// The tip moving is what must end a solve early (#657).
    ///
    /// ASSERTS THE ABANDONMENT, NOT THE WATCHER'S EXISTENCE. A row saying "a watcher is spawned"
    /// passes on a watcher nobody reads, which is the failure this whole issue is an instance of:
    /// the solver looped on two conditions and nothing told it the parent was dead.
    #[test]
    fn a_changed_tip_sets_the_abandon_flag() {
        let abandon = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(Shutdown::new());
        let mut reads = 0;
        let s = Arc::clone(&stop);
        watch_tip(
            "parent-aaa".to_string(),
            Arc::clone(&abandon),
            Arc::clone(&stop),
            Duration::from_millis(1),
            || {
                reads += 1;
                // THE STOP IS WHAT MAKES THIS FAIL RATHER THAN HANG, and it is here because the
                // mutant found it: with the watcher's comparison broken, watch_tip never returns
                // and this test ran for over a minute instead of going red. A hanging test is
                // worse than a failing one - CI waits on it instead of reporting it.
                if reads >= 10 {
                    s.stop();
                }
                // Two sweeps on the parent we are building on, then the chain moves.
                Some(if reads < 3 { "parent-aaa".to_string() } else { "parent-bbb".to_string() })
            },
        );
        assert!(abandon.load(Ordering::Relaxed), "a tip that moved must abandon the solve");
        assert!(reads >= 3, "it kept reading while the tip was unchanged");
    }

    /// THE BOUND, and without it "abort always" satisfies the row above and the miner never
    /// finishes anything. An unchanged tip must leave the flag alone.
    #[test]
    fn an_unchanged_tip_never_abandons() {
        let abandon = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(Shutdown::new());
        let reads = Arc::new(AtomicUsize::new(0));
        let r = Arc::clone(&reads);
        let s = Arc::clone(&stop);
        // The watcher only returns when something stops it, so the stop is what ends this test -
        // which is also the production path when a solve finishes on its own.
        let h = thread::spawn(move || {
            watch_tip("same".to_string(), abandon, s, Duration::from_millis(1), move || {
                r.fetch_add(1, Ordering::Relaxed);
                Some("same".to_string())
            })
        });
        while reads.load(Ordering::Relaxed) < 5 {
            thread::sleep(Duration::from_millis(1));
        }
        stop.stop();
        h.join().unwrap();
        assert!(reads.load(Ordering::Relaxed) >= 5, "it polled");
    }

    /// A NODE THAT WILL NOT ANSWER IS NOT A MOVED TIP. Treating a failed read as a change would
    /// abandon every solve for ever while the node was unreachable - the miner doing NO work
    /// rather than some wasted work, which is worse than the bug being fixed. The deadline is
    /// still the backstop.
    #[test]
    fn a_failed_read_is_not_a_changed_tip() {
        let abandon = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(Shutdown::new());
        let mut reads = 0;
        let s = Arc::clone(&stop);
        watch_tip(
            "parent".to_string(),
            Arc::clone(&abandon),
            stop,
            Duration::from_millis(1),
            || {
                reads += 1;
                if reads >= 4 {
                    s.stop();
                }
                None
            },
        );
        assert!(!abandon.load(Ordering::Relaxed), "an unreadable tip must not abandon the solve");
    }

    /// THE SHUTDOWN COSTS NOTHING ON THE WINNING PATH (SDE-UI, review of #660).
    ///
    /// The watcher used to `thread::sleep(poll)`, which is uninterruptible, so `stop()` + `join()`
    /// blocked until the current sleep ended - measured at 956ms against a 1s poll. The abandon
    /// path was fine (the watcher returns immediately on a change); the cost landed on a solve that
    /// hit its deadline, and on A SOLVE THAT FOUND A BLOCK, which then held it for a second before
    /// submitting. In a race whose only previous win was rejected for a stale parent, that is a
    /// window in which the tip can move AFTER we have won.
    ///
    /// The bound is deliberately loose (200ms against a 5s poll): this pins "the wait is
    /// interruptible", not a scheduler's timing. Restore the plain sleep and it is ~5000ms.
    #[test]
    fn stopping_the_watcher_does_not_wait_out_its_poll_interval() {
        let abandon = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(Shutdown::new());
        let s = Arc::clone(&stop);
        let a = Arc::clone(&abandon);
        let h = thread::spawn(move || {
            // Five seconds, so a sleep-based wait could not possibly finish inside the assertion.
            watch_tip("same".to_string(), a, s, Duration::from_secs(5), || Some("same".to_string()))
        });
        thread::sleep(Duration::from_millis(50));
        let asked = Instant::now();
        stop.stop();
        h.join().unwrap();
        let waited = asked.elapsed();
        assert!(
            waited < Duration::from_millis(200),
            "join waited {waited:?} after stop; the watcher's wait must be interruptible"
        );
        assert!(!abandon.load(Ordering::Relaxed), "stopping is not abandoning");
    }

    /// The solver reads the flag: set it before the loop starts and no thread grinds at all.
    /// This is the half that would still be broken if watch_tip were perfect and nobody checked it.
    /// A TEXT PIN, AND IT SAYS SO. The counter itself is covered by rows in heartbeat.rs, but
    /// the CALL SITE is not: `mine_once` takes a concrete `&Rpc` with no seam, so nothing can
    /// drive the abandon branch without a real node. Measured: deleting `g.abandoned()` from that
    /// branch leaves the whole suite green at 81/0, which is the same untested-wiring gap #660
    /// shipped with one level down.
    ///
    /// So this catches a DELETION and nothing more. It cannot catch a branch that stopped being
    /// reachable. The behavioural version needs an Rpc trait with a double behind it, which is a
    /// bigger change than this one and is named in the PR rather than pretended at here.
    #[test]
    fn the_abandon_branch_still_records_to_the_heartbeat() {
        let src = include_str!("main.rs");
        let branch = src
            .split("if abandon.load(Ordering::Relaxed) {")
            .nth(1)
            .expect("the abandon branch has moved or been renamed");
        let head = &branch[..branch.len().min(600)];
        assert!(
            head.contains("g.abandoned()"),
            "the abandon branch no longer records to the heartbeat, so an abandoned solve and a \
             genuine no-solution are indistinguishable from outside the box again"
        );
    }

    #[test]
    fn the_solver_honours_an_abandon_set_before_it_starts() {
        let abandon = Arc::new(AtomicBool::new(true));
        let cfg = Config {
            rpc_url: String::new(),
            cookie_path: PathBuf::new(),
            threads: 2,
            mode: Mode::Proposal,
            poll_secs: 1,
            // Long enough that a solve reaching its deadline would fail this test loudly rather
            // than passing for the wrong reason.
            template_secs: 30,
            max_lag: 100,
        };
        let t: template::Template =
            serde_json::from_str(template::tests_sample()).expect("the sample template parses");
        let header = Header::from_template(&t).expect("a header can be built from it");
        let target = [0u8; 32]; // impossible target: only the flag can end this
        let started = Instant::now();
        let got = solve(&header, &target, &cfg, &abandon);
        assert!(got.is_none(), "an abandoned solve yields nothing");
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "it returned on the flag rather than grinding to the {}s deadline",
            cfg.template_secs
        );
    }
}

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
mod rpc;
mod template;

use std::{
    path::PathBuf,
    process,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::json;

use block::{expand_target, meets_target, serialize_block, Header};
use rpc::Rpc;
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
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Mode {
    Proposal,
    Submit,
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
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
    if threads == 0 || threads > 8 {
        return Err(format!("MINER_THREADS must be 1..=8, got {threads}"));
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

    loop {
        match mine_once(&rpc, &config) {
            Ok(Outcome::Accepted { height }) => {
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
    Accepted { height: u32 },
    ProposalValid { height: u32 },
    Rejected { height: u32, reason: String },
    NoSolution { height: u32 },
}

fn mine_once(rpc: &Rpc, config: &Config) -> Result<Outcome, String> {
    let raw = rpc.call("getblocktemplate", json!([{"mode": "template"}]))?;
    let t: Template =
        serde_json::from_value(raw).map_err(|e| format!("could not parse the template: {e}"))?;
    let target = expand_target(&t.bits)?;
    let header = Header::from_template(&t)?;

    log(&format!(
        "template: height {} bits {} txs {}",
        t.height,
        t.bits,
        t.transactions.len()
    ));

    let Some(solved) = solve(&header, &target, config) else {
        return Ok(Outcome::NoSolution { height: t.height });
    };

    let block_hex = hex::encode(serialize_block(&solved, &t)?);
    log(&format!(
        "height {}: found a block, hash {}",
        t.height,
        hex::encode(display_hash(&solved.hash_le()))
    ));

    // Always validate through proposal mode first: it runs zebra's full block
    // check without touching the chain, so a malformed block costs nothing.
    let verdict = rpc.call(
        "getblocktemplate",
        json!([{"mode": "proposal", "data": block_hex, "capabilities": ["proposal"]}]),
    )?;
    if !verdict.is_null() {
        return Ok(Outcome::Rejected {
            height: t.height,
            reason: format!("proposal check said {verdict}"),
        });
    }

    if config.mode == Mode::Proposal {
        return Ok(Outcome::ProposalValid { height: t.height });
    }

    // null from submitblock means accepted, anything else is a rejection
    // reason ("duplicate", "rejected", ...).
    let submitted = rpc.call("submitblock", json!([block_hex]))?;
    if submitted.is_null() {
        Ok(Outcome::Accepted { height: t.height })
    } else {
        Ok(Outcome::Rejected {
            height: t.height,
            reason: submitted.to_string(),
        })
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

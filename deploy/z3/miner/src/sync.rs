//! The sync guard: a miner that will not build on a node that is behind.
//!
//! WHY. On 2026-09-07 zebra lost its peers and sat on a private fork for hours. The miner
//! kept fetching templates from it and submitting solved blocks to it, so the fork grew
//! one block at a time with our own work, and when the watchdog finally rewound the node
//! by ~100 blocks the miner was still submitting on top of the old tip. MINING.md had the
//! rule ("only mine on a synced node") and nothing enforced it; this does.
//!
//! WHAT IT READS. `getblockchaininfo` gives `blocks`, the height this node has verified,
//! and `estimatedheight`, where zebra thinks the network is from the clock and the target
//! spacing. Their difference is how far behind this node believes itself to be. It is the
//! same pair the watchdog uses to call a stall, so both guards agree on what "behind" is.
//!
//! WHY THE DEFAULT IS 100 AND NOT 2. The estimate runs ahead of the real chain whenever
//! blocks are slow, and on testnet blocks are slow often: a 30-minute gap pushes it ~24
//! ahead with no one behind at all, and hour-long gaps happen. Those gaps are also when
//! the difficulty floor kicks in and a single core actually wins, so a tight limit would
//! stop mining at exactly the moment mining pays, and keep it stopped, since our own
//! block is what would have ended the gap. 100 (~two hours of silence) is past any gap
//! this network has produced in our logs and is the depth of the finalized state, the
//! point past which a fork cannot be undone by dropping non-finalized state.
//!
//! WHAT THIS CANNOT SEE, said plainly. `estimatedheight` extrapolates from the TIP'S
//! TIMESTAMP, so a fork that we ourselves keep extending at a normal pace has a fresh tip
//! and a small lag: the guard is blind to exactly the fork it is mining. What it does
//! catch is the node being LEFT BEHIND: initial sync, a stalled node, a fork nobody
//! extends. Catching the fork we extend needs a view of the network our node does not
//! have (the app's external tip), and that is the watchdog's job: it stops this miner
//! outright for a node-heal episode. The second guard below, no peers, catches the
//! other 2026-08 shape: a node with no peers believes it is at the tip and mines a fork
//! of genesis within seconds.
//!
//! FAILS CLOSED. No answer, no `blocks`, no `estimatedheight`, a non-integer: the miner
//! does not mine. A node whose sync state cannot be read is a node whose tip cannot be
//! trusted, and a template from it is the thing this module exists to refuse.
use serde_json::Value;

/// Hard ceiling on MINER_MAX_LAG. "There is no off switch" is only true if a value that
/// switches it off is refused; 500 is ~10 hours of silence, past anything defensible.
pub const MAX_LAG_CEILING: u64 = 500;
pub const DEFAULT_MAX_LAG: u64 = 100;

#[derive(Debug, PartialEq, Eq)]
pub enum Verdict {
    /// Within the limit. `lag` is reported so the heartbeat can carry it.
    Mine { lag: u64 },
    /// Behind by more than the limit: fetch no template, submit nothing, try again later.
    Wait { lag: u64, blocks: u64, estimated: u64 },
}

/// The other isolation signal: a node with no peers has nobody to tell it about a better
/// chain, so whatever it serves is a private view. `getpeerinfo` returns an array; empty
/// means isolated. Not an array is an answer we cannot read, and that refuses too.
pub fn isolated(peerinfo: &Value) -> Result<bool, String> {
    match peerinfo.as_array() {
        Some(peers) => Ok(peers.is_empty()),
        None => Err("getpeerinfo did not return a list: the node's peer count is unknown, so this miner will not mine on it".into()),
    }
}

/// `blocks` and `estimatedheight` out of a `getblockchaininfo` reply, judged against
/// `max_lag`. An estimate BELOW the verified height is not "ahead of the network", it is
/// clock skew, and it counts as no lag rather than a negative one.
pub fn verdict(info: &Value, max_lag: u64) -> Result<Verdict, String> {
    let blocks = field(info, "blocks")?;
    let estimated = field(info, "estimatedheight")?;
    let lag = estimated.saturating_sub(blocks);
    if lag > max_lag {
        Ok(Verdict::Wait { lag, blocks, estimated })
    } else {
        Ok(Verdict::Mine { lag })
    }
}

fn field(info: &Value, key: &str) -> Result<u64, String> {
    info.get(key).and_then(Value::as_u64).ok_or_else(|| {
        format!("getblockchaininfo has no integer '{key}': the node's sync state is unknown, so this miner will not mine on it")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Trimmed from a real zebra 6.3.0 testnet reply: the two fields this module reads,
    /// beside the neighbours that must not be confused with them.
    fn info(blocks: u64, estimated: u64) -> Value {
        json!({
            "chain": "test",
            "blocks": blocks,
            "headers": blocks,
            "bestblockhash": "0000000000000000000000000000000000000000000000000000000000000000",
            "difficulty": 1.0,
            "verificationprogress": 1.0,
            "estimatedheight": estimated,
            "initial_block_download_complete": true,
            "size_on_disk": 0
        })
    }

    #[test]
    fn at_the_tip_it_mines() {
        assert_eq!(verdict(&info(4_333_511, 4_333_511), 50), Ok(Verdict::Mine { lag: 0 }));
    }

    #[test]
    fn exactly_at_the_limit_still_mines_and_one_past_it_waits() {
        // The boundary is where a guard is wrong if it is going to be, so both sides of it
        // are pinned rather than one comfortable value each way.
        assert_eq!(verdict(&info(1_000, 1_050), 50), Ok(Verdict::Mine { lag: 50 }));
        assert_eq!(
            verdict(&info(1_000, 1_051), 50),
            Ok(Verdict::Wait { lag: 51, blocks: 1_000, estimated: 1_051 })
        );
    }

    #[test]
    fn the_incident_shape_waits() {
        // 2026-09-07: the node sat 1,443 behind on a private fork. This is the reply the
        // miner was getting templates from all afternoon.
        match verdict(&info(4_331_234, 4_332_677), 50) {
            Ok(Verdict::Wait { lag, .. }) => assert_eq!(lag, 1_443),
            other => panic!("a node 1,443 behind must wait, got {other:?}"),
        }
    }

    #[test]
    fn an_estimate_below_the_tip_is_zero_lag_not_a_wraparound() {
        // Clock skew can put the estimate a block or two under the verified height. A
        // signed subtraction would make that huge and stop the miner on a healthy node.
        assert_eq!(verdict(&info(1_000, 998), 50), Ok(Verdict::Mine { lag: 0 }));
    }

    #[test]
    fn a_missing_estimate_refuses_rather_than_assuming_synced() {
        let mut v = info(1_000, 1_000);
        v.as_object_mut().unwrap().remove("estimatedheight");
        let err = verdict(&v, 50).unwrap_err();
        assert!(err.contains("estimatedheight"), "{err}");
        assert!(err.contains("will not mine"), "{err}");
    }

    #[test]
    fn a_non_integer_height_refuses() {
        let mut v = info(1_000, 1_000);
        v["blocks"] = json!("1000");
        assert!(verdict(&v, 50).is_err());
        let mut v = info(1_000, 1_000);
        v["estimatedheight"] = json!(null);
        assert!(verdict(&v, 50).is_err());
    }

    #[test]
    fn during_initial_sync_it_waits_at_the_ceiling_too() {
        // A fresh node is millions behind. The largest limit main.rs will accept refuses
        // it; the ceiling is what makes "no off switch" true.
        assert!(matches!(verdict(&info(12_000, 4_333_511), DEFAULT_MAX_LAG), Ok(Verdict::Wait { .. })));
        assert!(matches!(verdict(&info(12_000, 4_333_511), MAX_LAG_CEILING), Ok(Verdict::Wait { .. })));
    }

    #[test]
    fn no_peers_is_isolated_and_a_peer_list_is_not() {
        assert_eq!(isolated(&json!([])), Ok(true));
        assert_eq!(isolated(&json!([{"addr": "1.2.3.4:18233", "inbound": false}])), Ok(false));
    }

    #[test]
    fn a_peer_reply_that_is_not_a_list_refuses() {
        assert!(isolated(&json!(null)).is_err());
        assert!(isolated(&json!({"peers": 3})).is_err());
    }
}

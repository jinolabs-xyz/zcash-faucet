//! Block and header assembly from a `getblocktemplate` response.
//!
//! Everything here is pure byte work over data zebra already computed, which
//! is the point: zebra builds the coinbase transaction and the commitment
//! roots, we only lay out the header, run the solver, and check the hash. No
//! transaction is ever constructed on this side.

use sha2::{Digest, Sha256};

use crate::template::{DefaultRoots, Template, TransactionTemplate};

/// Bytes of a Zcash block header before the nonce: version, previous block
/// hash, merkle root, block commitments, time, bits.
pub const HEADER_PREFIX_LEN: usize = 4 + 32 + 32 + 32 + 4 + 4;
/// The Equihash input is the header up to and including the nonce.
pub const EQUIHASH_INPUT_LEN: usize = HEADER_PREFIX_LEN + 32;

/// A header ready to solve: the 108-byte prefix, plus whatever nonce and
/// solution get filled in per attempt.
#[derive(Clone, Debug)]
pub struct Header {
    pub prefix: [u8; HEADER_PREFIX_LEN],
    pub nonce: [u8; 32],
    /// Compressed Equihash solution, including its CompactSize length prefix
    /// when serialized. Empty until solved.
    pub solution: Vec<u8>,
}

impl Header {
    /// Lays out the header prefix from a template.
    ///
    /// Hashes and roots arrive from zebra as big-endian display hex and go on
    /// the wire little-endian, so each one is reversed exactly once, here.
    /// `defaultroots.merkleroot` and `blockcommitmentshash` are used rather
    /// than the deprecated top-level fields.
    pub fn from_template(t: &Template) -> Result<Self, String> {
        let mut prefix = [0u8; HEADER_PREFIX_LEN];
        let mut at = 0;
        let put = |bytes: &[u8], prefix: &mut [u8; HEADER_PREFIX_LEN], at: &mut usize| {
            prefix[*at..*at + bytes.len()].copy_from_slice(bytes);
            *at += bytes.len();
        };

        put(&t.version.to_le_bytes(), &mut prefix, &mut at);
        put(&le32(&t.previous_block_hash)?, &mut prefix, &mut at);
        put(&le32(&t.default_roots.merkle_root)?, &mut prefix, &mut at);
        put(
            &le32(&t.default_roots.block_commitments_hash)?,
            &mut prefix,
            &mut at,
        );
        put(&t.cur_time.to_le_bytes(), &mut prefix, &mut at);
        put(&bits_le(&t.bits)?, &mut prefix, &mut at);
        debug_assert_eq!(at, HEADER_PREFIX_LEN);

        Ok(Self {
            prefix,
            nonce: [0u8; 32],
            solution: Vec::new(),
        })
    }

    /// The Equihash solver input: prefix followed by the current nonce.
    pub fn equihash_input(&self) -> [u8; EQUIHASH_INPUT_LEN] {
        let mut input = [0u8; EQUIHASH_INPUT_LEN];
        input[..HEADER_PREFIX_LEN].copy_from_slice(&self.prefix);
        input[HEADER_PREFIX_LEN..].copy_from_slice(&self.nonce);
        input
    }

    /// Full serialized header: prefix, nonce, then the solution with its
    /// CompactSize length.
    pub fn serialize(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(EQUIHASH_INPUT_LEN + 3 + self.solution.len());
        out.extend_from_slice(&self.equihash_input());
        out.extend_from_slice(&compact_size(self.solution.len() as u64));
        out.extend_from_slice(&self.solution);
        out
    }

    /// Block hash as compared against the target: double SHA256 of the
    /// serialized header, in little-endian wire order.
    pub fn hash_le(&self) -> [u8; 32] {
        double_sha256(&self.serialize())
    }
}

/// Double SHA-256, the hash Bitcoin-derived headers use.
///
/// Its own function so a known-answer test can pin it directly. This is
/// consensus, not convenience: if a `sha2` bump ever changed what these two
/// calls produce, every block we mined would be silently invalid and the first
/// symptom would be a submitted block that is never accepted. `cargo test`
/// would stay green throughout, so the test that guards this has to compare
/// against an answer computed outside our code (#138).
fn double_sha256(bytes: &[u8]) -> [u8; 32] {
    let first = Sha256::digest(bytes);
    let second = Sha256::digest(first);
    let mut out = [0u8; 32];
    out.copy_from_slice(&second);
    out
}

/// Serializes the full block: header, transaction count, coinbase, then the
/// template's transactions in order. Their bytes come straight from zebra.
pub fn serialize_block(header: &Header, t: &Template) -> Result<Vec<u8>, String> {
    let coinbase = hex::decode(&t.coinbase_txn.data).map_err(|e| format!("bad coinbasetxn: {e}"))?;

    let mut out = header.serialize();
    out.extend_from_slice(&compact_size(1 + t.transactions.len() as u64));
    out.extend_from_slice(&coinbase);
    for (i, tx) in t.transactions.iter().enumerate() {
        let bytes = hex::decode(&tx.data).map_err(|e| format!("bad transaction {i}: {e}"))?;
        out.extend_from_slice(&bytes);
    }
    Ok(out)
}

/// True when the header hash is at or below the target. Both are 32-byte
/// little-endian, so compare from the most significant byte down.
pub fn meets_target(hash_le: &[u8; 32], target_le: &[u8; 32]) -> bool {
    for i in (0..32).rev() {
        match hash_le[i].cmp(&target_le[i]) {
            std::cmp::Ordering::Less => return true,
            std::cmp::Ordering::Greater => return false,
            std::cmp::Ordering::Equal => {}
        }
    }
    // Exactly the target counts as a hit.
    true
}

/// Decodes a big-endian display hex hash into little-endian wire bytes.
fn le32(display_hex: &str) -> Result<[u8; 32], String> {
    let mut bytes = hex::decode(display_hex).map_err(|e| format!("bad hash hex: {e}"))?;
    if bytes.len() != 32 {
        return Err(format!("expected a 32-byte hash, got {} bytes", bytes.len()));
    }
    bytes.reverse();
    let mut out = [0u8; 32];
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// `bits` arrives as 4 bytes of big-endian display hex (e.g. 1f2f93c0) and is
/// stored little-endian in the header.
fn bits_le(display_hex: &str) -> Result<[u8; 4], String> {
    let mut bytes = hex::decode(display_hex).map_err(|e| format!("bad bits hex: {e}"))?;
    if bytes.len() != 4 {
        return Err(format!("expected 4 bytes of bits, got {}", bytes.len()));
    }
    bytes.reverse();
    let mut out = [0u8; 4];
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// Bitcoin/Zcash CompactSize encoding.
pub fn compact_size(n: u64) -> Vec<u8> {
    match n {
        0..=0xfc => vec![n as u8],
        0xfd..=0xffff => {
            let mut v = vec![0xfd];
            v.extend_from_slice(&(n as u16).to_le_bytes());
            v
        }
        0x1_0000..=0xffff_ffff => {
            let mut v = vec![0xfe];
            v.extend_from_slice(&(n as u32).to_le_bytes());
            v
        }
        _ => {
            let mut v = vec![0xff];
            v.extend_from_slice(&n.to_le_bytes());
            v
        }
    }
}

/// Expands a CompactDifficulty (`bits`) into a 32-byte little-endian target,
/// so the miner can check candidates without another RPC round trip.
///
/// Same rules as bitcoin's nBits: the high byte is the size in bytes, the low
/// three are the mantissa. A set sign bit or an overflowing size is invalid.
pub fn expand_target(bits_display_hex: &str) -> Result<[u8; 32], String> {
    let raw = hex::decode(bits_display_hex).map_err(|e| format!("bad bits hex: {e}"))?;
    if raw.len() != 4 {
        return Err(format!("expected 4 bytes of bits, got {}", raw.len()));
    }
    let compact = u32::from_be_bytes([raw[0], raw[1], raw[2], raw[3]]);

    let size = (compact >> 24) as usize;
    let mantissa = compact & 0x007f_ffff;
    if compact & 0x0080_0000 != 0 {
        return Err("negative target (sign bit set)".to_string());
    }
    if mantissa == 0 {
        return Err("zero mantissa".to_string());
    }
    if size > 32 || (size < 3 && mantissa >> (8 * size) != 0) {
        return Err(format!("target overflows 32 bytes (size {size})"));
    }

    // Big-endian first (mantissa occupies the 3 bytes ending at `size`), then
    // reverse once into wire order.
    let mut be = [0u8; 32];
    let mantissa_bytes = mantissa.to_be_bytes(); // [0, hi, mid, lo]
    for (i, b) in mantissa_bytes[1..].iter().enumerate() {
        // Byte i of the mantissa sits at big-endian position 32 - size + i.
        let pos = 32usize.checked_sub(size).and_then(|p| p.checked_add(i));
        match pos {
            Some(p) if p < 32 => be[p] = *b,
            // Bytes shifted off the low end are zero anyway.
            _ => {
                if *b != 0 {
                    return Err("target does not fit in 32 bytes".to_string());
                }
            }
        }
    }
    be.reverse();
    Ok(be)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A template whose every header field carries a distinct marker, so a swap
    /// between two same-length fields is visible in the bytes.
    fn marked_template() -> Template {
        Template {
            version: 4,
            previous_block_hash: "00".repeat(31) + "a1",
            default_roots: DefaultRoots {
                merkle_root: "00".repeat(31) + "a2",
                block_commitments_hash: "00".repeat(31) + "a3",
            },
            transactions: vec![],
            coinbase_txn: TransactionTemplate { data: String::new() },
            bits: "1f2f93c0".to_string(),
            cur_time: 0x1122_3344,
            height: 1,
        }
    }

    /// KNOWN-ANSWER TEST for the header BYTE LAYOUT, which the hash test cannot
    /// cover: corrupt the field order and every hash assertion still passes,
    /// because hashing is happy to digest whatever bytes it is handed. QA proved
    /// exactly that by sabotaging the layout and watching all ten stay green.
    ///
    /// The expected string is written out from the Zcash protocol field order
    /// (spec 7.6: version, prev hash, merkle root, block commitments, time, bits,
    /// nonce) rather than pasted from this code's output. An expectation copied
    /// from the thing it checks only proves the code agrees with itself.
    ///
    /// This pins the LAYOUT. It does not prove our reading of the spec matches a
    /// real chain, which needs a header from a real node, so do not delete that
    /// one on the strength of this.
    #[test]
    fn header_bytes_are_laid_out_in_protocol_order() {
        let header = Header::from_template(&marked_template()).unwrap();
        let zeros31 = "00".repeat(31);
        let expected = format!(
            "{version}{prev}{merkle}{commitments}{time}{bits}{nonce}",
            version = "04000000",              // u32 little-endian
            prev = format!("a1{zeros31}"),     // display hex reversed to wire order
            merkle = format!("a2{zeros31}"),
            commitments = format!("a3{zeros31}"),
            time = "44332211",                 // u32 little-endian
            bits = "c0932f1f",                 // compact bits, little-endian
            nonce = "00".repeat(32),           // unsolved
        );
        assert_eq!(hex::encode(header.equihash_input()), expected);

        // serialize() is that input plus the solution's CompactSize length.
        // Unsolved, that is a single zero byte and nothing after it.
        assert_eq!(hex::encode(header.serialize()), format!("{expected}00"));
    }

    /// KNOWN-ANSWER TEST for the hashing primitive, against a value this project
    /// did not compute: the Bitcoin genesis block header and its hash are among
    /// the most widely published constants in computing, and the hash IS a
    /// double SHA-256 of that 80-byte header, which is exactly the operation
    /// `hash_le` performs.
    ///
    /// It deliberately does not use a Zcash header. This pins the sha2 crate's
    /// behaviour on its own, so it keeps its meaning across a 0.10 to 0.11 bump
    /// even if our own serialization changes. A companion test pins the
    /// serialization against a real testnet header.
    #[test]
    fn double_sha256_matches_the_published_bitcoin_genesis_hash() {
        let header = hex::decode(concat!(
            "01000000",
            "0000000000000000000000000000000000000000000000000000000000000000",
            "3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a",
            "29ab5f49",
            "ffff001d",
            "1dac2b7c",
        ))
        .unwrap();
        assert_eq!(header.len(), 80, "the genesis header is 80 bytes");

        // hash_le returns wire (little-endian) order, and block hashes are
        // displayed reversed, so reverse before comparing to the famous value.
        let mut display = double_sha256(&header);
        display.reverse();
        assert_eq!(
            hex::encode(display),
            "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
            "double SHA-256 no longer produces the published genesis hash, so the \
             hashing primitive changed under us and every mined block would be invalid",
        );
    }

    #[test]
    fn compact_size_boundaries() {
        assert_eq!(compact_size(0), vec![0x00]);
        assert_eq!(compact_size(252), vec![0xfc]);
        assert_eq!(compact_size(253), vec![0xfd, 0xfd, 0x00]);
        assert_eq!(compact_size(0x1_0000), vec![0xfe, 0x00, 0x00, 0x01, 0x00]);
    }

    #[test]
    fn hashes_are_reversed_exactly_once() {
        // Display hex is big-endian, the wire is little-endian.
        let display = "00".repeat(31) + "ff";
        let wire = le32(&display).unwrap();
        assert_eq!(wire[0], 0xff);
        assert_eq!(wire[31], 0x00);
    }

    #[test]
    fn bits_go_little_endian() {
        assert_eq!(bits_le("1f2f93c0").unwrap(), [0xc0, 0x93, 0x2f, 0x1f]);
    }

    #[test]
    fn expands_the_live_testnet_bits() {
        // 1f2f93c0, the value observed on our node: size 0x1f = 31 bytes, so
        // the mantissa 2f93c0 lands at big-endian bytes 1..4 and the target is
        // enormous (very low difficulty), which is what makes CPU mining work.
        let target = expand_target("1f2f93c0").unwrap();
        // Little-endian: the most significant byte is the last one.
        assert_eq!(target[31], 0x00);
        assert_eq!(target[30], 0x2f);
        assert_eq!(target[29], 0x93);
        assert_eq!(target[28], 0xc0);
        assert!(target[0..28].iter().all(|b| *b == 0));
    }

    #[test]
    fn rejects_malformed_bits() {
        assert!(expand_target("00000000").is_err(), "zero mantissa");
        assert!(expand_target("1f800000").is_err(), "sign bit set");
        assert!(expand_target("deadbeefcafe").is_err(), "wrong length");
    }

    #[test]
    fn target_comparison_is_big_endian_over_le_bytes() {
        let mut target = [0u8; 32];
        target[31] = 0x10;

        let mut low = [0u8; 32];
        low[31] = 0x0f;
        assert!(meets_target(&low, &target));

        let mut high = [0u8; 32];
        high[31] = 0x11;
        assert!(!meets_target(&high, &target));

        // Equal hits, and a low-byte difference only matters when the high
        // bytes tie.
        assert!(meets_target(&target, &target));
        let mut tie_lower = target;
        tie_lower[0] = 0x01;
        assert!(!meets_target(&tie_lower, &target));
    }

    #[test]
    fn header_prefix_is_108_bytes_and_input_is_140() {
        assert_eq!(HEADER_PREFIX_LEN, 108);
        assert_eq!(EQUIHASH_INPUT_LEN, 140);
    }

    /// The one test that proves the whole solver wiring: solve over a real
    /// header prefix, then check the solution the way a node does. This is
    /// what catches feeding the solver the wrong input (prefix+nonce instead
    /// of prefix), which produces solutions that look fine locally and are
    /// rejected by consensus.
    ///
    /// A 200,9 solve needs ~144 MB and a few seconds, so it runs on demand:
    ///   cargo test --release -- --ignored solved_solution_verifies
    #[test]
    #[ignore = "slow: runs the real Equihash solver"]
    fn solved_solution_verifies() {
        let mut header = Header {
            prefix: [0u8; HEADER_PREFIX_LEN],
            nonce: [0u8; 32],
            solution: Vec::new(),
        };
        // Any deterministic prefix will do, the check is structural.
        for (i, b) in header.prefix.iter_mut().enumerate() {
            *b = i as u8;
        }
        header.nonce[0] = 42;

        let nonce = header.nonce;
        let mut once = Some(nonce);
        let solutions = equihash::tromp::solve_200_9(&header.prefix, || once.take());
        assert!(!solutions.is_empty(), "solver returned no solutions");

        for solution in &solutions {
            equihash::is_valid_solution(200, 9, &header.prefix, &nonce, solution)
                .expect("a solution from the solver must verify against prefix and nonce");
        }

        // And the serialized header must carry that solution with its
        // CompactSize length: 1344 bytes of solution take a 0xfd prefix.
        header.solution = solutions[0].clone();
        let serialized = header.serialize();
        assert_eq!(&serialized[..HEADER_PREFIX_LEN], &header.prefix);
        assert_eq!(&serialized[HEADER_PREFIX_LEN..EQUIHASH_INPUT_LEN], &nonce);
        assert_eq!(
            serialized[EQUIHASH_INPUT_LEN..EQUIHASH_INPUT_LEN + 3],
            compact_size(header.solution.len() as u64)[..]
        );
        assert_eq!(serialized.len(), EQUIHASH_INPUT_LEN + 3 + header.solution.len());
    }
}

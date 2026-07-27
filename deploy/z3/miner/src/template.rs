//! The slice of zebra's `getblocktemplate` response this miner needs.
//!
//! Deliberately partial: zebra sends a lot more (sigoplimit, longpollid, the
//! deprecated root aliases) and serde ignores what is not declared here. The
//! field names match zebra's serde renames in
//! zebra-rpc/src/methods/types/get_block_template.rs.

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct Template {
    pub version: u32,
    #[serde(rename = "previousblockhash")]
    pub previous_block_hash: String,
    #[serde(rename = "defaultroots")]
    pub default_roots: DefaultRoots,
    pub transactions: Vec<TransactionTemplate>,
    #[serde(rename = "coinbasetxn")]
    pub coinbase_txn: TransactionTemplate,
    /// Compact difficulty as 4 bytes of display hex, e.g. "1f2f93c0".
    pub bits: String,
    #[serde(rename = "curtime")]
    pub cur_time: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DefaultRoots {
    #[serde(rename = "merkleroot")]
    pub merkle_root: String,
    /// The value that goes in the header's commitment field. Zebra computes
    /// it, and the first block after any snapshot import consensus-checks it,
    /// so it is never ours to derive.
    #[serde(rename = "blockcommitmentshash")]
    pub block_commitments_hash: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TransactionTemplate {
    /// Raw transaction bytes as hex. Used verbatim.
    pub data: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Trimmed shape of a real testnet template (height and bits are the
    /// values observed on our node).
    const SAMPLE: &str = r#"{
      "capabilities": ["proposal"],
      "version": 4,
      "previousblockhash": "0000000000a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b",
      "blockcommitmentshash": "1111111111111111111111111111111111111111111111111111111111111111",
      "lightclientroothash": "2222222222222222222222222222222222222222222222222222222222222222",
      "defaultroots": {
        "merkleroot": "3333333333333333333333333333333333333333333333333333333333333333",
        "chainhistoryroot": "4444444444444444444444444444444444444444444444444444444444444444",
        "authdataroot": "5555555555555555555555555555555555555555555555555555555555555555",
        "blockcommitmentshash": "6666666666666666666666666666666666666666666666666666666666666666"
      },
      "transactions": [{"data": "abcdef", "hash": "00", "authdigest": "00", "depends": [], "fee": 1000, "sigops": 1, "required": false}],
      "coinbasetxn": {"data": "0400008085202f89", "hash": "00", "authdigest": "00", "depends": [], "fee": -1000, "sigops": 1, "required": true},
      "longpollid": "0000",
      "target": "0000000000002f93c0000000000000000000000000000000000000000000000000",
      "mintime": 1700000000,
      "mutable": ["time", "transactions", "prevblock"],
      "noncerange": "00000000ffffffff",
      "sigoplimit": 20000,
      "sizelimit": 2000000,
      "curtime": 1700000123,
      "bits": "1f2f93c0",
      "height": 4204726,
      "maxtime": 1700007200
    }"#;

    #[test]
    fn parses_a_real_template_shape_ignoring_extra_fields() {
        let t: Template = serde_json::from_str(SAMPLE).expect("template should parse");
        assert_eq!(t.height, 4204726);
        assert_eq!(t.bits, "1f2f93c0");
        assert_eq!(t.version, 4);
        assert_eq!(t.transactions.len(), 1);
        // The commitments hash must come from defaultroots, not the
        // deprecated top-level field with the same name.
        assert!(t.default_roots.block_commitments_hash.starts_with("6666"));
        assert_eq!(t.coinbase_txn.data, "0400008085202f89");
    }

    #[test]
    fn a_template_missing_defaultroots_is_an_error_not_a_default() {
        let broken = SAMPLE.replace("\"defaultroots\"", "\"notdefaultroots\"");
        assert!(serde_json::from_str::<Template>(&broken).is_err());
    }
}

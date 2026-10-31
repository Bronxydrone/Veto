//! # Veto -- on-chain policy firewall for AI agent wallets
//!
//! `veto-policy` is the on-chain half of Veto. An owner account installs a spending
//! policy (per-transaction / rolling-daily / rolling-30-day limits per asset, plus a
//! recipient allowlist) and hands a narrow "agent" key to an AI agent. The agent can
//! only move money through [`Contract::spend`], and every wall is enforced **inside
//! the contract**, so a stolen agent key still cannot exceed the policy.
//!
//! Guarantees (see `README.md` for the long version):
//!
//! * every successful spend is checked by one pure function, [`evaluate`], which is
//!   also the code path behind the read-only [`Contract::check`] -- the two cannot
//!   disagree;
//! * limits are enforced with lazily-reset rolling windows driven by
//!   `env::block_timestamp()` (nanoseconds), so the agent cannot reset the day by
//!   waiting for a round number;
//! * every spend advances a `sha256` hash chain over the intended-decision hashes and
//!   emits a NEP-297 `EVENT_JSON:` event, giving an on-chain audit trail;
//! * the owner keeps an escape hatch ([`Contract::withdraw`], [`Contract::set_paused`],
//!   [`Contract::set_agent`], [`Contract::set_policy`]) that the agent key cannot reach.

use near_sdk::borsh::{BorshDeserialize, BorshSerialize};
use near_sdk::json_types::U128;
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{env, ext_contract, near, AccountId, Gas, NearToken, PanicOnDefault, Promise};

/// Length of one day in nanoseconds (86_400e9).
pub const NS_PER_DAY: u64 = 86_400_000_000_000;
/// Rolling window for the monthly cap: 30 days.
pub const NS_PER_MONTH: u64 = 30 * NS_PER_DAY;

/// `asset_id` value that means "native NEAR", transferred with `Promise::transfer`.
pub const NATIVE_ASSET_ID: &str = "near";

/// Prefix of the `previous_hash` for the very first decision in the chain.
pub const ZERO_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

/// NEP-297 event envelope.
pub const EVENT_PREFIX: &str = "EVENT_JSON:";
pub const EVENT_STANDARD: &str = "veto";
pub const EVENT_VERSION: &str = "1.0.0";

/// Gas attached to an NEP-141 `ft_transfer` cross-contract call.
pub const FT_TRANSFER_TGAS: u64 = 30;

// ---------------------------------------------------------------------------
// Reason codes. `check` prefixes them with "deny:"; `spend` panics with them.
// ---------------------------------------------------------------------------

/// The owner paused the contract.
pub const R_PAUSED: &str = "PAUSED";
/// `to` is not in the allowlist.
pub const R_RECIPIENT_NOT_ALLOWED: &str = "RECIPIENT_NOT_ALLOWED";
/// No limit installed for this asset.
pub const R_NO_LIMIT: &str = "NO_LIMIT";
/// `amount == 0`.
pub const R_NON_POSITIVE_AMOUNT: &str = "NON_POSITIVE_AMOUNT";
/// `amount > per_tx`.
pub const R_PER_TX_LIMIT: &str = "PER_TX_LIMIT";/// `day_spent + amount > daily`.
pub const R_DAILY_LIMIT: &str = "DAILY_LIMIT";
/// The vault cannot cover the transfer once its storage stake is reserved.
///
/// Without this check the spend would write its counters, advance the hash chain and
/// emit a `spend` event, and only then would the transfer receipt fail with
/// `LackBalanceForState` - burning budget without delivering funds. Found on testnet
/// (see `../docs/TESTNET.md`); the fix is the check below in `spend`.
pub const R_INSUFFICIENT_BALANCE: &str = "INSUFFICIENT_BALANCE";
/// `month_spent + amount > monthly` (monthly != 0).
pub const R_MONTHLY_LIMIT: &str = "MONTHLY_LIMIT";

/// Per-asset policy limits. All amounts are in the asset's smallest unit
/// (yoctoNEAR for native NEAR, the NEP-141 base unit otherwise).
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct AssetLimit {
    pub asset_id: String,
    pub per_tx: U128,
    pub daily: U128,
    pub monthly: U128,
}

/// Full, publicly readable policy state.
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct Config {
    pub owner: AccountId,
    pub agent: AccountId,
    pub paused: bool,
    pub policy_hash: String,
    pub allowlist: Vec<AccountId>,
    pub limits: Vec<AssetLimit>,
}

/// Rolling-window spending counters for one asset.
///
/// A window is reset lazily: the moment a spend (or a `check` view) observes that
/// `now >= start + window`, the window start moves to `now` and the counter to zero.
#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize, Clone, Debug, Default, PartialEq, Eq)]
#[serde(crate = "near_sdk::serde")]
pub struct Usage {
    pub day_spent: U128,
    pub month_spent: U128,
    pub day_start_ns: u64,
    pub month_start_ns: u64,
}

impl Usage {
    /// A counter that starts counting at `now_ns`.
    pub fn fresh(now_ns: u64) -> Self {
        Self {
            day_spent: U128(0),
            month_spent: U128(0),
            day_start_ns: now_ns,
            month_start_ns: now_ns,
        }
    }
}

/// Apply the lazy window reset to a copy of `usage`, as observed at `now_ns`.
///
/// Pure: the stored counters are never mutated here, so a view call (`check`,
/// `get_usage`) sees exactly the numbers a `spend` at the same block would use.
pub fn roll_usage(usage: &Usage, now_ns: u64) -> Usage {
    let mut rolled = usage.clone();
    // `block_timestamp()` never goes backwards on chain; if it somehow does, we
    // keep the counters (a stale window never grants extra allowance).
    if now_ns >= rolled.day_start_ns.saturating_add(NS_PER_DAY) {
        rolled.day_start_ns = now_ns;
        rolled.day_spent = U128(0);
    }
    if now_ns >= rolled.month_start_ns.saturating_add(NS_PER_MONTH) {
        rolled.month_start_ns = now_ns;
        rolled.month_spent = U128(0);
    }
    rolled
}

/// The single source of truth for the policy decision.
///
/// Both [`Contract::spend`] (which panics with the returned reason code) and
/// [`Contract::check`] (which renders it as `deny:<CODE>`) call this function with
/// the same inputs, so they can never disagree.
///
/// Checked in this order: `PAUSED`, `NON_POSITIVE_AMOUNT`, `RECIPIENT_NOT_ALLOWED`,
/// `NO_LIMIT`, `PER_TX_LIMIT`, `DAILY_LIMIT`, `MONTHLY_LIMIT`.
///
/// A `monthly` limit of `0` means "no monthly cap"; `per_tx` and `daily` are always
/// enforced (`set_policy` refuses to install a policy where `per_tx > daily`, so a
/// zero `daily` implies a zero `per_tx`).
#[allow(clippy::too_many_arguments)]
pub fn evaluate(
    paused: bool,
    allowlist: &[AccountId],
    limits: &[AssetLimit],
    usage: &Usage,
    now_ns: u64,
    asset_id: &str,
    amount: u128,
    to: &AccountId,
) -> Result<(), &'static str> {
    if paused {
        return Err(R_PAUSED);
    }
    if amount == 0 {
        return Err(R_NON_POSITIVE_AMOUNT);
    }
    if !allowlist.iter().any(|allowed| allowed == to) {
        return Err(R_RECIPIENT_NOT_ALLOWED);
    }
    let limit = match limits.iter().find(|l| l.asset_id == asset_id) {
        Some(limit) => limit,
        None => return Err(R_NO_LIMIT),
    };
    if amount > limit.per_tx.0 {
        return Err(R_PER_TX_LIMIT);
    }
    let rolled = roll_usage(usage, now_ns);
    match rolled.day_spent.0.checked_add(amount) {
        Some(total) if total <= limit.daily.0 => {}
        _ => return Err(R_DAILY_LIMIT),
    }
    if limit.monthly.0 != 0 {
        match rolled.month_spent.0.checked_add(amount) {
            Some(total) if total <= limit.monthly.0 => {}
            _ => return Err(R_MONTHLY_LIMIT),
        }
    }
    Ok(())
}

/// `sha256(previous_hash_bytes || decision_hash_bytes)` as lowercase hex.
///
/// `previous_hash` is the 64-char hex string of the previous chain value (or
/// [`ZERO_HASH`] for the first decision); `decision_hash` is the caller-supplied
/// hash of the intended decision. Concatenation happens over the UTF-8 bytes.
pub fn chain_hash(previous_hash: &str, decision_hash: &str) -> String {
    let mut buf = Vec::with_capacity(previous_hash.len() + decision_hash.len());
    buf.extend_from_slice(previous_hash.as_bytes());
    buf.extend_from_slice(decision_hash.as_bytes());
    hex_encode(&env::sha256(&buf))
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

/// NEP-141 surface used to move non-native assets.
#[ext_contract(ext_ft_transfer)]
pub trait FtTransfer {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

/// yoctoNEAR this account can move without falling below its storage stake.
///
/// A NEAR account must keep `storage_usage * storage_byte_cost` locked; a transfer that
/// would dip below that fails at protocol level. `spend` uses this to refuse up front.
pub fn available_native_balance() -> u128 {
    let locked = env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
    env::account_balance().saturating_sub(locked).as_yoctonear()
}

fn emit_event(event: &str, data: near_sdk::serde_json::Value) {
    let envelope = near_sdk::serde_json::json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": data,
    });
    env::log_str(&format!("{}{}", EVENT_PREFIX, envelope));
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    agent: AccountId,
    paused: bool,
    policy_hash: String,
    allowlist: Vec<AccountId>,
    limits: Vec<AssetLimit>,
    /// Last value of the decision hash chain (64 lowercase hex chars).
    last_decision_hash: String,
    /// Number of decisions anchored so far.
    decision_count: u64,
    /// Rolling counters, one entry per asset id. A policy only ever has a handful of
    /// assets, so a plain vector keeps the whole state Borsh-serialisable without any
    /// storage-key bookkeeping.
    usage: Vec<(String, Usage)>,
}

#[near]
impl Contract {
    /// Create the contract. `owner` installs the policy, `agent` may only `spend`.
    #[init]
    pub fn new(owner: AccountId, agent: AccountId) -> Self {
        Self {
            owner,
            agent,
            paused: false,
            policy_hash: String::new(),
            allowlist: Vec::new(),
            limits: Vec::new(),
            last_decision_hash: ZERO_HASH.to_string(),
            decision_count: 0,
            usage: Vec::new(),
        }
    }

    // -- owner-only administration ------------------------------------------

    /// Install a new policy. Owner only.
    ///
    /// Rejects policies that cannot be enforced (this keeps `check` and `spend`
    /// honest): `per_tx > daily`, `daily > monthly` when `monthly != 0`, duplicate
    /// asset ids, and asset ids that are neither `"near"` nor a valid account id.
    /// Already-spent counters are deliberately **not** reset by a policy update.
    pub fn set_policy(
        &mut self,
        policy_hash: String,
        limits: Vec<AssetLimit>,
        allowlist: Vec<AccountId>,
    ) {
        self.assert_owner("set_policy");

        for (index, limit) in limits.iter().enumerate() {
            if limit.per_tx.0 > limit.daily.0 {
                env::panic_str(&format!(
                    "Veto: set_policy rejected an unenforceable policy: per_tx {} > daily {} for asset '{}'. A policy that cannot be enforced must not be installed.",
                    limit.per_tx.0, limit.daily.0, limit.asset_id
                ));
            }
            if limit.monthly.0 != 0 && limit.daily.0 > limit.monthly.0 {
                env::panic_str(&format!(
                    "Veto: set_policy rejected an unenforceable policy: daily {} > monthly {} for asset '{}'. A policy that cannot be enforced must not be installed.",
                    limit.daily.0, limit.monthly.0, limit.asset_id
                ));
            }
            if limit.asset_id != NATIVE_ASSET_ID && limit.asset_id.parse::<AccountId>().is_err() {
                env::panic_str(&format!(
                    "Veto: set_policy rejected asset_id '{}': it is neither '{}' nor a valid NEP-141 contract account id",
                    limit.asset_id, NATIVE_ASSET_ID
                ));
            }
            if limits[..index].iter().any(|other| other.asset_id == limit.asset_id) {
                env::panic_str(&format!(
                    "Veto: set_policy rejected duplicate asset_id '{}'",
                    limit.asset_id
                ));
            }
        }

        self.policy_hash = policy_hash;
        self.limits = limits;
        self.allowlist = allowlist;
        // NOTE: `self.usage` is intentionally left untouched.
    }

    /// Freeze / unfreeze spending. Owner only.
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner("set_paused");
        self.paused = paused;
    }

    /// Rotate the agent key. Owner only.
    pub fn set_agent(&mut self, agent: AccountId) {
        self.assert_owner("set_agent");
        self.agent = agent;
    }

    /// Move funds out of the contract, bypassing all limits. Owner only.
    ///
    /// This is the recovery path for a compromised agent key: the owner can always
    /// drain, the agent never can. It does not touch the counters or the hash chain.
    pub fn withdraw(&mut self, asset_id: String, amount: U128, to: AccountId) {
        self.assert_owner("withdraw");
        if amount.0 == 0 {
            env::panic_str(&format!(
                "Veto: withdraw denied: {} (amount must be > 0)",
                R_NON_POSITIVE_AMOUNT
            ));
        }
        self.transfer(&asset_id, amount.0, &to);
        emit_event(
            "withdraw",
            near_sdk::serde_json::json!({
                "asset": asset_id,
                "amount": amount.0.to_string(),
                "to": to.as_str(),
                "caller": env::predecessor_account_id().as_str(),
            }),
        );
    }

    // -- agent path ---------------------------------------------------------

    /// Spend `amount` of `asset_id` to `to`. Agent only.
    ///
    /// Panics with a reason code (`PAUSED`, `NON_POSITIVE_AMOUNT`,
    /// `RECIPIENT_NOT_ALLOWED`, `NO_LIMIT`, `PER_TX_LIMIT`, `DAILY_LIMIT`,
    /// `MONTHLY_LIMIT`) when the policy denies the spend. On success it increments
    /// the rolling counters, advances the decision hash chain, emits the NEP-297
    /// `spend` event and moves the funds. Returns the amount spent.
    pub fn spend(
        &mut self,
        asset_id: String,
        amount: U128,
        to: AccountId,
        decision_hash: Option<String>,
    ) -> U128 {
        let caller = env::predecessor_account_id();
        if caller != self.agent {
            env::panic_str(&format!(
                "Veto: spend is agent-only: caller '{}' is not the agent '{}'",
                caller, self.agent
            ));
        }

        let now = env::block_timestamp();
        let usage = self.usage_of(&asset_id, now);
        let decision = evaluate(
            self.paused,
            &self.allowlist,
            &self.limits,
            &usage,
            now,
            &asset_id,
            amount.0,
            &to,
        );

        if let Err(code) = decision {
            // A panic reverts the transaction, which is exactly what we want, but a
            // panic reaches the caller as an opaque "wasm trap" with no message.
            // Emit the reason first: the refusal then stays visible on-chain through
            // the event, so an agent (or an indexer, or the owner's dashboard) can
            // read *why* it was stopped instead of guessing.
            emit_event(
                "deny",
                near_sdk::serde_json::json!({
                    "reason": code,
                    "asset": asset_id,
                    "amount": amount.0.to_string(),
                    "to": to.as_str(),
                    "policy_hash": self.policy_hash,
                }),
            );
            env::panic_str(&format!(
                "Veto: spend denied: {} (asset='{}', amount={}, to='{}', policy_hash='{}')",
                code, asset_id, amount.0, to, self.policy_hash
            ));
        }

        // Fail closed on a vault that cannot cover the transfer. Without this the
        // counters would advance and the `spend` event would be emitted, and only then
        // would the transfer receipt fail with `LackBalanceForState`: budget burned,
        // funds not delivered, and a log that says "spend". Found on testnet.
        if asset_id == NATIVE_ASSET_ID {
            let available = available_native_balance();
            if available < amount.0 {
                emit_event(
                    "deny",
                    near_sdk::serde_json::json!({
                        "reason": R_INSUFFICIENT_BALANCE,
                        "asset": asset_id,
                        "amount": amount.0.to_string(),
                        "available": available.to_string(),
                        "to": to.as_str(),
                        "policy_hash": self.policy_hash,
                    }),
                );
                env::panic_str(&format!(
                    "Veto: spend denied: {} (vault has {} yoctoNEAR available after its storage stake, needs {})",
                    R_INSUFFICIENT_BALANCE, available, amount.0
                ));
            }
        }

        // The policy passed, so these numbers fit the limits; `saturating_add` is
        // only a belt-and-braces guard for an unlimited (monthly == 0) policy.
        let rolled = roll_usage(&usage, now);
        self.store_usage(
            &asset_id,
            Usage {
                day_spent: U128(rolled.day_spent.0.saturating_add(amount.0)),
                month_spent: U128(rolled.month_spent.0.saturating_add(amount.0)),
                day_start_ns: rolled.day_start_ns,
                month_start_ns: rolled.month_start_ns,
            },
        );

        let previous = if self.last_decision_hash.is_empty() {
            ZERO_HASH.to_string()
        } else {
            self.last_decision_hash.clone()
        };
        let submitted = decision_hash.unwrap_or_default();
        let chain = chain_hash(&previous, &submitted);
        self.last_decision_hash = chain.clone();
        self.decision_count = self.decision_count.saturating_add(1);

        self.transfer(&asset_id, amount.0, &to);

        emit_event(
            "spend",
            near_sdk::serde_json::json!({
                "asset": asset_id,
                "amount": amount.0.to_string(),
                "to": to.as_str(),
                "decision_hash": submitted,
                "chain_hash": chain,
                "decision_count": self.decision_count,
                "policy_hash": self.policy_hash,
            }),
        );

        U128(amount.0)
    }

    // -- views --------------------------------------------------------------

    /// The read-only twin of [`Contract::spend`]: `"allow"` or `"deny:<REASON_CODE>"`.
    ///
    /// Nothing is written: the rolling windows are evaluated at
    /// `env::block_timestamp()` without mutating storage.
    pub fn check(&self, asset_id: String, amount: U128, to: AccountId) -> String {
        let now = env::block_timestamp();
        let usage = self.usage_of(&asset_id, now);
        match evaluate(
            self.paused,
            &self.allowlist,
            &self.limits,
            &usage,
            now,
            &asset_id,
            amount.0,
            &to,
        ) {
            Ok(()) => {
                // Keep the view honest about the vault's ability to pay: `spend` refuses
                // with INSUFFICIENT_BALANCE, so `check` must say the same thing.
                if asset_id == NATIVE_ASSET_ID && available_native_balance() < amount.0 {
                    return format!("deny:{}", R_INSUFFICIENT_BALANCE);
                }
                "allow".to_string()
            }
            Err(code) => format!("deny:{}", code),
        }
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            paused: self.paused,
            policy_hash: self.policy_hash.clone(),
            allowlist: self.allowlist.clone(),
            limits: self.limits.clone(),
        }
    }

    /// Rolling usage for one asset, as of the current block.
    pub fn get_usage(&self, asset_id: String) -> Usage {
        self.usage_of(&asset_id, env::block_timestamp())
    }

    pub fn get_last_decision_hash(&self) -> String {
        self.last_decision_hash.clone()
    }

    pub fn get_decision_count(&self) -> u64 {
        self.decision_count
    }

    pub fn get_agent(&self) -> AccountId {
        self.agent.clone()
    }

    pub fn get_owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn is_paused(&self) -> bool {
        self.paused
    }

    // -- internals ----------------------------------------------------------

    /// Stored usage for `asset_id`, rolled forward to `now` (never written).
    fn usage_of(&self, asset_id: &str, now: u64) -> Usage {
        match self.usage.iter().find(|(id, _)| id == asset_id) {
            Some((_, usage)) => roll_usage(usage, now),
            None => Usage::fresh(now),
        }
    }

    /// Write back the counters of `asset_id` (inserting the entry if needed).
    fn store_usage(&mut self, asset_id: &str, usage: Usage) {
        match self.usage.iter_mut().find(|(id, _)| id == asset_id) {
            Some(entry) => entry.1 = usage,
            None => self.usage.push((asset_id.to_string(), usage)),
        }
    }

    fn assert_owner(&self, method: &str) {
        let caller = env::predecessor_account_id();
        if caller != self.owner {
            env::panic_str(&format!(
                "Veto: {} is owner-only: caller '{}' is not the owner '{}'",
                method, caller, self.owner
            ));
        }
    }

    /// Fire the transfer for `amount` of `asset_id`.
    ///
    /// Native NEAR uses `Promise::transfer`; anything else is treated as an NEP-141
    /// contract and receives `ft_transfer` with 1 yoctoNEAR attached (the standard
    /// safety deposit that forces a full-access-key signature).
    fn transfer(&self, asset_id: &str, amount: u128, to: &AccountId) {
        if asset_id == NATIVE_ASSET_ID {
            // Dropping a `Promise` schedules it (near-sdk's `Drop` calls
            // `construct_recursively`), so the receipt is created here even though the
            // method returns `U128` rather than the promise.
            Promise::new(to.clone())
                .transfer(NearToken::from_yoctonear(amount))
                .detach();
        } else {
            let token: AccountId = match asset_id.parse() {
                Ok(token) => token,
                Err(_) => env::panic_str(&format!(
                    "Veto: asset_id '{}' is not '{}' and not a valid NEP-141 account id",
                    asset_id, NATIVE_ASSET_ID
                )),
            };
            ext_ft_transfer::ext(token)
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(Gas::from_tgas(FT_TRANSFER_TGAS))
                .ft_transfer(to.clone(), U128(amount), None)
                .detach();
        }
    }
}

// ===========================================================================
// Tests -- `near-sdk` mocked blockchain (`VMContext`), no chain required.
// ===========================================================================
#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
    use near_sdk::testing_env;

    /// An arbitrary but realistic block timestamp, in nanoseconds.
    const T0: u64 = 1_700_000_000_000_000_000;
    const DAY: u64 = NS_PER_DAY;
    const USDC: &str = "usdc.near";
    /// Mocked account balance: enough to cover any transfer these tests ask for.
    const FUNDED_BALANCE: u128 = 1_000 * 10u128.pow(24);

    fn owner() -> AccountId {
        accounts(0)
    }
    fn agent() -> AccountId {
        accounts(1)
    }
    fn alice() -> AccountId {
        accounts(2)
    }
    fn bob() -> AccountId {
        accounts(3)
    }
    fn stranger() -> AccountId {
        accounts(4)
    }

    fn ctx(caller: AccountId, ts: u64) -> near_sdk::VMContext {
        // Fund the mocked account: `spend` refuses when the vault cannot cover the
        // transfer after its storage stake, so a zero balance would make every native
        // spend in these tests fail with INSUFFICIENT_BALANCE for the wrong reason.
        VMContextBuilder::new()
            .current_account_id("veto.near".parse().unwrap())
            .predecessor_account_id(caller.clone())
            .signer_account_id(caller)
            .block_timestamp(ts)
            .attached_deposit(NearToken::from_yoctonear(0))
            .account_balance(NearToken::from_yoctonear(FUNDED_BALANCE))
            .build()
    }

    /// A test context for an account that cannot cover its own transfers.
    fn empty_ctx(caller: AccountId, ts: u64) -> near_sdk::VMContext {
        VMContextBuilder::new()
            .current_account_id("veto.near".parse().unwrap())
            .predecessor_account_id(caller.clone())
            .signer_account_id(caller)
            .block_timestamp(ts)
            .attached_deposit(NearToken::from_yoctonear(0))
            .account_balance(NearToken::from_yoctonear(0))
            .build()
    }

    fn asset_limits(per_tx: u128, daily: u128, monthly: u128) -> Vec<AssetLimit> {
        vec![
            AssetLimit {
                asset_id: USDC.to_string(),
                per_tx: U128(per_tx),
                daily: U128(daily),
                monthly: U128(monthly),
            },
            AssetLimit {
                asset_id: NATIVE_ASSET_ID.to_string(),
                per_tx: U128(per_tx),
                daily: U128(daily),
                monthly: U128(monthly),
            },
        ]
    }

    /// Owner initialises the contract and installs a policy for `USDC` + native NEAR.
    fn setup(per_tx: u128, daily: u128, monthly: u128) -> Contract {
        testing_env!(ctx(owner(), T0));
        let mut contract = Contract::new(owner(), agent());
        contract.set_policy(
            "policy-hash-1".to_string(),
            asset_limits(per_tx, daily, monthly),
            vec![alice(), bob()],
        );
        contract
    }

    fn spend_as_agent(
        contract: &mut Contract,
        asset: &str,
        amount: u128,
        to: AccountId,
        ts: u64,
        decision: Option<&str>,
    ) -> U128 {
        testing_env!(ctx(agent(), ts));
        contract.spend(
            asset.to_string(),
            U128(amount),
            to,
            decision.map(|d| d.to_string()),
        )
    }

    fn check_as_agent(contract: &Contract, asset: &str, amount: u128, to: AccountId, ts: u64) -> String {
        testing_env!(ctx(agent(), ts));
        contract.check(asset.to_string(), U128(amount), to)
    }

    fn usage_as(contract: &Contract, asset: &str, ts: u64) -> Usage {
        testing_env!(ctx(owner(), ts));
        contract.get_usage(asset.to_string())
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }

    /// Runs `f`, expects it to panic, and returns the panic message when it is a
    /// string payload (which is what `env::panic_str` produces in the mock).
    fn panic_message<F: FnOnce()>(f: F) -> String {
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
        std::panic::set_hook(previous);
        let payload = match result {
            Ok(()) => panic!("expected the call to panic, but it succeeded"),
            Err(payload) => payload,
        };
        if let Some(text) = payload.downcast_ref::<String>() {
            text.clone()
        } else if let Some(text) = payload.downcast_ref::<&'static str>() {
            (*text).to_string()
        } else {
            String::new()
        }
    }

    // -- 1. happy path ------------------------------------------------------

    #[test]
    fn spend_within_limits_succeeds_and_counters_increase() {
        let mut contract = setup(100, 150, 400);

        let returned = spend_as_agent(&mut contract, USDC, 100, alice(), T0, Some("decision-1"));
        assert_eq!(returned, U128(100));
        assert_eq!(contract.get_decision_count(), 1);

        let logs = get_logs();
        assert!(
            logs.iter().any(|line| line.starts_with(EVENT_PREFIX)
                && line.contains("\"standard\":\"veto\"")
                && line.contains("\"version\":\"1.0.0\"")
                && line.contains("\"event\":\"spend\"")
                && line.contains("\"chain_hash\"")),
            "expected a NEP-297 veto/spend event, got: {:?}",
            logs
        );

        let usage = usage_as(&contract, USDC, T0);
        assert_eq!(usage.day_spent, U128(100));
        assert_eq!(usage.month_spent, U128(100));
        assert_eq!(usage.day_start_ns, T0);
        assert_eq!(usage.month_start_ns, T0);
        assert_eq!(contract.get_last_decision_hash(), chain_hash(ZERO_HASH, "decision-1"));

        // The second asset's counters are untouched.
        assert_eq!(usage_as(&contract, NATIVE_ASSET_ID, T0).day_spent, U128(0));
    }

    #[test]
    fn native_spend_is_tracked_like_any_other_asset() {
        let mut contract = setup(100, 150, 400);
        spend_as_agent(&mut contract, NATIVE_ASSET_ID, 100, alice(), T0, None);
        let usage = usage_as(&contract, NATIVE_ASSET_ID, T0);
        assert_eq!(usage.day_spent, U128(100));
        assert_eq!(usage.month_spent, U128(100));
    }

    // -- 2. per-transaction limit ------------------------------------------

    #[test]
    #[should_panic(expected = "INSUFFICIENT_BALANCE")]
    fn native_spend_is_refused_when_the_vault_cannot_cover_it() {
        // Setup under a funded context, then switch to an empty vault for the spend.
        let mut contract = setup(100, 150, 400);
        testing_env!(empty_ctx(agent(), T0));
        contract.spend(NATIVE_ASSET_ID.to_string(), U128(100), alice(), None);
    }

    #[test]
    fn check_agrees_when_the_vault_cannot_cover_the_transfer() {
        let contract = setup(100, 150, 400);
        testing_env!(empty_ctx(agent(), T0));
        assert_eq!(
            contract.check(NATIVE_ASSET_ID.to_string(), U128(100), alice()),
            format!("deny:{}", R_INSUFFICIENT_BALANCE)
        );
    }

    #[test]
    #[should_panic(expected = "PER_TX_LIMIT")]
    fn spend_above_per_tx_limit_panics() {
        let mut contract = setup(100, 150, 400);
        spend_as_agent(&mut contract, USDC, 101, alice(), T0, None);
    }

    // -- 3. daily limit -----------------------------------------------------

    #[test]
    #[should_panic(expected = "DAILY_LIMIT")]
    fn second_spend_that_breaks_the_daily_limit_panics() {
        let mut contract = setup(100, 150, 400);
        spend_as_agent(&mut contract, USDC, 100, alice(), T0, None);
        // Fits per-tx (60 <= 100) but 100 + 60 > 150.
        spend_as_agent(&mut contract, USDC, 60, bob(), T0 + 1, None);
    }

    // -- 4. daily window reset ---------------------------------------------

    #[test]
    fn daily_window_resets_after_a_day() {
        let mut contract = setup(100, 150, 1000);
        spend_as_agent(&mut contract, USDC, 100, alice(), T0, None);
        assert_eq!(usage_as(&contract, USDC, T0).day_spent, U128(100));

        // Same day: another 100 would break the daily limit.
        assert_eq!(check_as_agent(&contract, USDC, 100, alice(), T0 + 1), "deny:DAILY_LIMIT");

        // One full day later the daily window is reset, the monthly one is not.
        spend_as_agent(&mut contract, USDC, 100, alice(), T0 + DAY, None);
        let usage = usage_as(&contract, USDC, T0 + DAY);
        assert_eq!(usage.day_spent, U128(100));
        assert_eq!(usage.day_start_ns, T0 + DAY);
        assert_eq!(usage.month_spent, U128(200));
        assert_eq!(usage.month_start_ns, T0);
    }

    // -- 5. monthly limit across many days ---------------------------------

    #[test]
    #[should_panic(expected = "MONTHLY_LIMIT")]
    fn monthly_limit_catches_spending_spread_across_days() {
        let mut contract = setup(100, 150, 250);
        spend_as_agent(&mut contract, USDC, 100, alice(), T0, None);
        spend_as_agent(&mut contract, USDC, 100, alice(), T0 + DAY, None);
        // 200 + 100 > 250 even though the day window just reset.
        spend_as_agent(&mut contract, USDC, 100, alice(), T0 + 2 * DAY, None);
    }

    #[test]
    fn monthly_window_resets_after_thirty_days() {
        let mut contract = setup(100, 150, 250);
        spend_as_agent(&mut contract, USDC, 100, alice(), T0, None);
        spend_as_agent(&mut contract, USDC, 100, alice(), T0 + DAY, None);
        assert_eq!(check_as_agent(&contract, USDC, 100, alice(), T0 + 2 * DAY), "deny:MONTHLY_LIMIT");
        // 30 days after the month window started, the monthly counter resets.
        spend_as_agent(&mut contract, USDC, 100, alice(), T0 + NS_PER_MONTH, None);
        let usage = usage_as(&contract, USDC, T0 + NS_PER_MONTH);
        assert_eq!(usage.month_spent, U128(100));
        assert_eq!(usage.month_start_ns, T0 + NS_PER_MONTH);
    }

    // -- 6. allowlist -------------------------------------------------------

    #[test]
    #[should_panic(expected = "RECIPIENT_NOT_ALLOWED")]
    fn recipient_outside_allowlist_panics() {
        let mut contract = setup(100, 150, 400);
        spend_as_agent(&mut contract, USDC, 10, stranger(), T0, None);
    }

    // -- 7. pause -----------------------------------------------------------

    #[test]
    #[should_panic(expected = "PAUSED")]
    fn paused_contract_panics_on_spend() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(owner(), T0));
        contract.set_paused(true);
        spend_as_agent(&mut contract, USDC, 10, alice(), T0, None);
    }

    #[test]
    fn unpausing_restores_spending() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(owner(), T0));
        contract.set_paused(true);
        testing_env!(ctx(owner(), T0));
        contract.set_paused(false);
        spend_as_agent(&mut contract, USDC, 10, alice(), T0, None);
        assert_eq!(usage_as(&contract, USDC, T0).day_spent, U128(10));
    }

    // -- 8. agent cannot touch owner methods -------------------------------

    #[test]
    #[should_panic(expected = "owner-only")]
    fn agent_cannot_set_policy() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(agent(), T0));
        contract.set_policy(
            "hijacked".to_string(),
            asset_limits(u128::MAX, u128::MAX, 0),
            vec![stranger()],
        );
    }

    #[test]
    #[should_panic(expected = "owner-only")]
    fn agent_cannot_set_paused() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(agent(), T0));
        contract.set_paused(true);
    }

    #[test]
    #[should_panic(expected = "owner-only")]
    fn agent_cannot_withdraw() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(agent(), T0));
        contract.withdraw(USDC.to_string(), U128(1), agent());
    }

    #[test]
    #[should_panic(expected = "owner-only")]
    fn agent_cannot_set_agent() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(agent(), T0));
        contract.set_agent(agent());
    }

    // -- 9. owner cannot spend ---------------------------------------------

    #[test]
    #[should_panic(expected = "agent-only")]
    fn owner_cannot_spend() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(owner(), T0));
        contract.spend(USDC.to_string(), U128(10), alice(), None);
    }

    // -- 10. check and spend agree -----------------------------------------

    #[test]
    fn check_is_a_view_and_agrees_with_spend() {
        // allow
        let mut contract = setup(100, 150, 400);
        assert_eq!(check_as_agent(&contract, USDC, 100, alice(), T0), "allow");
        // `check` must not move any counters.
        assert_eq!(usage_as(&contract, USDC, T0).day_spent, U128(0));
        assert_eq!(contract.get_decision_count(), 0);
        spend_as_agent(&mut contract, USDC, 100, alice(), T0, None);

        // Every denial must be reported by `check` with the same reason code that
        // `spend` panics with.
        let cases: Vec<(&str, Box<dyn Fn() -> String>)> = vec![
            ("PER_TX_LIMIT", Box::new(|| {
                let contract = setup(100, 150, 400);
                let checked = check_as_agent(&contract, USDC, 101, alice(), T0);
                let mut contract = contract;
                let panicked = panic_message(move || {
                    testing_env!(ctx(agent(), T0));
                    contract.spend(USDC.to_string(), U128(101), alice(), None);
                });
                format!("{}|{}", checked, panicked)
            })),
            ("DAILY_LIMIT", Box::new(|| {
                let mut contract = setup(100, 150, 400);
                spend_as_agent(&mut contract, USDC, 100, alice(), T0, None);
                let checked = check_as_agent(&contract, USDC, 60, bob(), T0 + 1);
                let panicked = panic_message(move || {
                    testing_env!(ctx(agent(), T0 + 1));
                    contract.spend(USDC.to_string(), U128(60), bob(), None);
                });
                format!("{}|{}", checked, panicked)
            })),
            ("MONTHLY_LIMIT", Box::new(|| {
                let mut contract = setup(100, 150, 150);
                spend_as_agent(&mut contract, USDC, 100, alice(), T0, None);
                spend_as_agent(&mut contract, USDC, 50, alice(), T0 + DAY, None);
                let checked = check_as_agent(&contract, USDC, 10, bob(), T0 + 2 * DAY);
                let panicked = panic_message(move || {
                    testing_env!(ctx(agent(), T0 + 2 * DAY));
                    contract.spend(USDC.to_string(), U128(10), bob(), None);
                });
                format!("{}|{}", checked, panicked)
            })),
            ("RECIPIENT_NOT_ALLOWED", Box::new(|| {
                let contract = setup(100, 150, 400);
                let checked = check_as_agent(&contract, USDC, 10, stranger(), T0);
                let mut contract = contract;
                let panicked = panic_message(move || {
                    testing_env!(ctx(agent(), T0));
                    contract.spend(USDC.to_string(), U128(10), stranger(), None);
                });
                format!("{}|{}", checked, panicked)
            })),
            ("NO_LIMIT", Box::new(|| {
                let contract = setup(100, 150, 400);
                let checked = check_as_agent(&contract, "dai.near", 10, alice(), T0);
                let mut contract = contract;
                let panicked = panic_message(move || {
                    testing_env!(ctx(agent(), T0));
                    contract.spend("dai.near".to_string(), U128(10), alice(), None);
                });
                format!("{}|{}", checked, panicked)
            })),
            ("NON_POSITIVE_AMOUNT", Box::new(|| {
                let contract = setup(100, 150, 400);
                let checked = check_as_agent(&contract, USDC, 0, alice(), T0);
                let mut contract = contract;
                let panicked = panic_message(move || {
                    testing_env!(ctx(agent(), T0));
                    contract.spend(USDC.to_string(), U128(0), alice(), None);
                });
                format!("{}|{}", checked, panicked)
            })),
            ("PAUSED", Box::new(|| {
                let mut contract = setup(100, 150, 400);
                testing_env!(ctx(owner(), T0));
                contract.set_paused(true);
                let checked = check_as_agent(&contract, USDC, 10, alice(), T0);
                let panicked = panic_message(move || {
                    testing_env!(ctx(agent(), T0));
                    contract.spend(USDC.to_string(), U128(10), alice(), None);
                });
                format!("{}|{}", checked, panicked)
            })),
        ];

        for (code, case) in cases {
            let combined = case();
            let (checked, panicked) = combined.split_once('|').unwrap();
            assert_eq!(checked, format!("deny:{}", code), "check() disagreed for {}", code);
            assert!(
                panicked.contains(code),
                "spend() panicked with {:?} instead of {}",
                panicked,
                code
            );
        }
    }

    // -- 11. unenforceable policy is rejected ------------------------------

    #[test]
    #[should_panic(expected = "unenforceable")]
    fn set_policy_rejects_per_tx_above_daily() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(owner(), T0));
        contract.set_policy(
            "bad".to_string(),
            vec![AssetLimit {
                asset_id: USDC.to_string(),
                per_tx: U128(200),
                daily: U128(100),
                monthly: U128(400),
            }],
            vec![alice()],
        );
    }

    #[test]
    #[should_panic(expected = "unenforceable")]
    fn set_policy_rejects_daily_above_monthly() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(owner(), T0));
        contract.set_policy(
            "bad".to_string(),
            vec![AssetLimit {
                asset_id: USDC.to_string(),
                per_tx: U128(100),
                daily: U128(300),
                monthly: U128(200),
            }],
            vec![alice()],
        );
    }

    #[test]
    fn set_policy_does_not_reset_counters() {
        let mut contract = setup(100, 150, 400);
        spend_as_agent(&mut contract, USDC, 100, alice(), T0, Some("decision-1"));
        let hash_before = contract.get_last_decision_hash();

        testing_env!(ctx(owner(), T0 + 1));
        contract.set_policy(
            "policy-hash-2".to_string(),
            asset_limits(40, 120, 300),
            vec![alice()],
        );

        let usage = usage_as(&contract, USDC, T0 + 1);
        assert_eq!(usage.day_spent, U128(100), "set_policy must not reset the day counter");
        assert_eq!(usage.month_spent, U128(100), "set_policy must not reset the month counter");
        assert_eq!(contract.get_decision_count(), 1);
        assert_eq!(contract.get_last_decision_hash(), hash_before);
        assert_eq!(contract.get_config().policy_hash, "policy-hash-2");
        assert_eq!(contract.get_config().limits[0].per_tx, U128(40));

        // The kept counters are enforced by the new limits straight away:
        // per_tx 40 < 100 already spent today + new spend.
        assert_eq!(check_as_agent(&contract, USDC, 40, alice(), T0 + 2), "deny:DAILY_LIMIT");
    }

    // -- 12. decision hash chain ------------------------------------------

    #[test]
    fn decision_hash_chain_advances_and_count_increments() {
        let mut contract = setup(100, 150, 400);
        assert_eq!(contract.get_decision_count(), 0);
        assert_eq!(contract.get_last_decision_hash(), ZERO_HASH);

        spend_as_agent(&mut contract, USDC, 10, alice(), T0, Some("decision-1"));
        let first = contract.get_last_decision_hash();
        let expected_first = hex(&env::sha256(&[ZERO_HASH.as_bytes(), b"decision-1".as_slice()].concat()));
        assert_eq!(first, expected_first);
        assert_eq!(contract.get_decision_count(), 1);

        spend_as_agent(&mut contract, USDC, 10, bob(), T0 + 1, Some("decision-2"));
        let second = contract.get_last_decision_hash();
        let expected_second = hex(&env::sha256(&[first.as_bytes(), b"decision-2".as_slice()].concat()));
        assert_eq!(second, expected_second);
        assert_ne!(first, second);
        assert_eq!(contract.get_decision_count(), 2);
    }

    #[test]
    fn spend_without_decision_hash_still_advances_the_chain() {
        let mut contract = setup(100, 150, 400);
        spend_as_agent(&mut contract, USDC, 10, alice(), T0, None);
        let first = contract.get_last_decision_hash();
        assert_eq!(first, hex(&env::sha256(ZERO_HASH.as_bytes())));
        spend_as_agent(&mut contract, USDC, 10, alice(), T0 + 1, None);
        assert_eq!(
            contract.get_last_decision_hash(),
            hex(&env::sha256(first.as_bytes()))
        );
        assert_eq!(contract.get_decision_count(), 2);
    }

    // -- extra coverage ----------------------------------------------------

    #[test]
    fn unknown_asset_has_no_limit() {
        let contract = setup(100, 150, 400);
        assert_eq!(check_as_agent(&contract, "dai.near", 1, alice(), T0), "deny:NO_LIMIT");
    }

    #[test]
    fn zero_amount_is_rejected() {
        let contract = setup(100, 150, 400);
        assert_eq!(
            check_as_agent(&contract, USDC, 0, alice(), T0),
            "deny:NON_POSITIVE_AMOUNT"
        );
    }

    #[test]
    #[should_panic(expected = "NON_POSITIVE_AMOUNT")]
    fn zero_amount_spend_panics() {
        let mut contract = setup(100, 150, 400);
        spend_as_agent(&mut contract, USDC, 0, alice(), T0, None);
    }

    #[test]
    fn owner_withdraw_bypasses_limits_and_usage() {
        let mut contract = setup(100, 150, 400);
        spend_as_agent(&mut contract, USDC, 100, alice(), T0, Some("decision-1"));
        let hash_after_spend = contract.get_last_decision_hash();

        // Owner drains to a non-allowlisted account, far above every limit.
        testing_env!(ctx(owner(), T0 + 1));
        contract.withdraw(USDC.to_string(), U128(1_000_000), stranger());

        let usage = usage_as(&contract, USDC, T0 + 1);
        assert_eq!(usage.day_spent, U128(100), "withdraw must not consume allowance");
        assert_eq!(usage.month_spent, U128(100));
        assert_eq!(contract.get_decision_count(), 1);
        assert_eq!(contract.get_last_decision_hash(), hash_after_spend);
    }

    #[test]
    #[should_panic(expected = "NON_POSITIVE_AMOUNT")]
    fn owner_withdraw_of_zero_panics() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(owner(), T0));
        contract.withdraw(USDC.to_string(), U128(0), alice());
    }

    #[test]
    fn set_agent_rotates_the_key() {
        let mut contract = setup(100, 150, 400);
        testing_env!(ctx(owner(), T0));
        contract.set_agent(stranger());

        // The old agent is now an outsider.
        testing_env!(ctx(agent(), T0));
        let denied = panic_message(|| {
            contract.spend(USDC.to_string(), U128(10), alice(), None);
        });
        assert!(denied.contains("agent-only"), "unexpected panic: {}", denied);

        // The new agent works.
        testing_env!(ctx(stranger(), T0));
        contract.spend(USDC.to_string(), U128(10), alice(), None);
        assert_eq!(contract.get_agent(), stranger());
        assert_eq!(usage_as(&contract, USDC, T0).day_spent, U128(10));
    }

    #[test]
    fn get_config_reports_the_installed_policy() {
        let contract = setup(100, 150, 400);
        let config = contract.get_config();
        assert_eq!(config.owner, owner());
        assert_eq!(config.agent, agent());
        assert!(!config.paused);
        assert_eq!(config.policy_hash, "policy-hash-1");
        assert_eq!(config.allowlist, vec![alice(), bob()]);
        assert_eq!(config.limits, asset_limits(100, 150, 400));
    }

    #[test]
    fn get_usage_of_a_fresh_asset_is_zero() {
        let contract = setup(100, 150, 400);
        let usage = usage_as(&contract, "dai.near", T0);
        assert_eq!(usage.day_spent, U128(0));
        assert_eq!(usage.month_spent, U128(0));
    }
}

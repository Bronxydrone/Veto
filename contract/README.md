# veto-policy — on-chain policy firewall for AI agent wallets

`veto-policy` is the on-chain half of **Veto**. An owner account installs a spending
policy and hands a narrow *agent* key to an AI agent. Every transfer the agent makes
goes through `spend`, and every limit is enforced **inside the contract**, so a stolen
agent key still cannot exceed the walls. The owner keeps the admin keys.

| | |
|---|---|
| crate | `veto-policy` (near-sdk 5.29, edition 2021, `cdylib` + `rlib`) |
| artifact | `res/veto_policy.wasm` |
| build | `cargo build --release --target wasm32-unknown-unknown` (or `./build.ps1`) |
| tests | `cargo test` (near-sdk mocked blockchain, no chain needed) |

---

## 1. What the contract guarantees

**The agent cannot exceed the walls, because the walls are on chain.**
`spend` is callable *only* by the configured `agent` account and re-checks the whole
policy on every call; there is no code path from the agent key to a transfer that skips
the checks.

**One decision function, two callers.** Both `spend` and the read-only `check` call the
same pure function `evaluate(...) -> Result<(), &'static str>`. `check` renders the
result as `allow` / `deny:<REASON_CODE>`; `spend` panics with the same reason code.
They cannot drift apart, because there is only one implementation.

**Limits per asset, three walls each:**

| wall | rule | reset |
|---|---|---|
| per-transaction | `amount <= per_tx` | never |
| rolling daily | `day_spent + amount <= daily` | lazily, when `block_timestamp() >= day_start + 86_400e9 ns` |
| rolling 30-day | `month_spent + amount <= monthly` | lazily, when `block_timestamp() >= month_start + 30 * 86_400e9 ns` |

Windows are *rolling from first use*, not calendar days: the window starts at the first
spend (or at the first spend after the previous window elapsed) and is only reset the
moment a spend is evaluated after the window has expired. `check` computes the same
reset in memory, so a view call always reports exactly what a `spend` in that block
would decide — and a view call never writes.

**No unenforceable policy can be installed.** `set_policy` panics if `per_tx > daily`,
if `daily > monthly` when `monthly != 0`, on duplicate `asset_id`s, and on an `asset_id`
that is neither `"near"` nor a valid NEAR account id. (`monthly == 0` means "no monthly
cap"; `per_tx` and `daily` are always enforced.)

**Policy updates never launder spent allowance.** `set_policy` replaces the limits and
the allowlist but deliberately leaves the spent counters untouched, so lowering a limit
cannot be used to get a fresh daily budget, and a new policy is enforced against the
usage already accumulated under the old one.

**Recipient allowlist.** `spend` panics with `RECIPIENT_NOT_ALLOWED` unless `to` is in
the allowlist. An empty allowlist therefore denies everything.

**Audit trail.** Every successful spend advances a hash chain and emits a NEP-297
event. Both are written *before* the transfer is fired, so a decision is anchored even
if the transfer receipt later fails (fail-closed).

```
chain_0     = "0000...0000"                       (64 zeros)
chain_{n+1} = hex(sha256(chain_n_utf8 ++ decision_hash_n_utf8))
```
`decision_hash` is whatever the agent (or its orchestrator) wants anchored: a hash of
the intended action, the off-chain policy decision, the full plan, etc. Passing `null`
is allowed and is treated as the empty string (the chain still advances). The chain
value is a 64-character lowercase hex string, exposed by `get_last_decision_hash()`
together with `get_decision_count()`.

**The owner always has an escape hatch.** `withdraw` (owner only) bypasses all limits
and moves funds to any account without touching the counters or the chain, so a
compromised agent key never locks the owner out. `set_paused(true)` freezes `spend`
immediately, `set_agent` rotates the agent key. The agent can call none of these
(`owner-only` panic).

**Fail-closed by design.** The counters and the chain are committed before the transfer
promise is created. If the NEP-141 transfer later fails on the token contract, the
allowance is already consumed — money is never moved without a counter increment, and a
broken token can never grant free spending.

### Not covered (on purpose)

* The contract cannot guarantee the *recipient* behaves; allowlisting is the control.
* The contract holds the funds and spends **its own** balance; the agent account itself
  needs no NEAR. Fund the contract, not the agent key.
* Token decimals are the caller's problem: limits are in the asset's smallest unit
  (yoctoNEAR for native, the NEP-141 base unit otherwise).
* The state is one Borsh-serialised struct. Upgrading to a different shape needs a
  migration; adding fields to `Config`/`AssetLimit` is not free.

---

## 2. Methods

| method | who | notes |
|---|---|---|
| `new(owner, agent)` | anyone, once | `#[init]`, unpaused, no policy, chain at 64 zeros |
| `set_policy(policy_hash, limits, allowlist)` | owner | validates enforceability, keeps counters |
| `set_paused(paused)` | owner | freezes / unfreezes `spend` |
| `set_agent(agent)` | owner | rotates the agent key |
| `withdraw(asset_id, amount, to)` | owner | bypasses limits, panics on `amount == 0` |
| `spend(asset_id, amount, to, decision_hash)` | **agent only** | returns the amount as `U128` |
| `check(asset_id, amount, to)` | anyone (view) | `"allow"` or `"deny:<CODE>"` |
| `get_config()` | anyone (view) | `{owner, agent, paused, policy_hash, allowlist, limits}` |
| `get_usage(asset_id)` | anyone (view) | `{day_spent, month_spent, day_start_ns, month_start_ns}` |
| `get_last_decision_hash()` | anyone (view) | 64 lowercase hex chars |
| `get_decision_count()` | anyone (view) | number of anchored decisions |
| `get_owner()` / `get_agent()` / `is_paused()` | anyone (view) | convenience |

### Reason codes

`PAUSED`, `NON_POSITIVE_AMOUNT`, `RECIPIENT_NOT_ALLOWED`, `NO_LIMIT`, `PER_TX_LIMIT`,
`DAILY_LIMIT`, `MONTHLY_LIMIT`.

`check` returns them as `deny:<CODE>`; `spend` panics with a message containing the
code, e.g.

```
Veto: spend denied: PER_TX_LIMIT (asset='usdc.near', amount=101, to='charlie.testnet', policy_hash='...')
```

### Readable failures

A panic on NEAR reaches the caller as an opaque `WebAssembly trap: An 'unreachable'
opcode was executed` — the message above is not delivered. That is fine for a
crash, useless for an agent that wants to know which wall it hit, so `spend` emits
the reason **before** panicking. A failed transaction therefore still carries a log:

```
EVENT_JSON:{"standard":"veto","version":"1.0.0","event":"deny","data":{
  "reason":"PER_TX_LIMIT","asset":"near","amount":"1500000000000000000000000",
  "to":"f2b01d05…c680","policy_hash":"aec57ca4…f7232a"}}
```

The panic still reverts every storage write, so a denied call cannot leave partial
state or advance the decision chain. Agents should call `check(...)` first for a
clean, free pre-flight and treat the `deny` event as the on-chain record.

Verified on testnet: transaction
[`JDtQ44eSeoEKBATno3q9JuSmyrtgQSTUi9yRuEss3C4c`](https://testnet.nearblocks.io/txns/JDtQ44eSeoEKBATno3q9JuSmyrtgQSTUi9yRuEss3C4c)
reverted and emitted exactly that event — see [`../docs/TESTNET.md`](../docs/TESTNET.md).

Evaluation order (first failure wins): `PAUSED` → `NON_POSITIVE_AMOUNT` →
`RECIPIENT_NOT_ALLOWED` → `NO_LIMIT` → `PER_TX_LIMIT` → `DAILY_LIMIT` →
`MONTHLY_LIMIT`.

### Assets

* `asset_id = "near"` → native NEAR, sent with `Promise::new(to).transfer(amount)`.
* any other `asset_id` → treated as the **NEP-141 contract account id** (e.g.
  `usdc.near`, `usdt.tether-token.near`) and receives
  `ft_transfer({receiver_id, amount, memo: null})` with **1 yoctoNEAR** attached and
  30 TGas of gas.

### Event (NEP-297)

```
EVENT_JSON:{"standard":"veto","version":"1.0.0","event":"spend","data":{
  "asset":"near","amount":"1000000000000000000000000","to":"charlie.testnet",
  "decision_hash":"...","chain_hash":"...","decision_count":1,"policy_hash":"..."}}
```

`withdraw` emits `event: "withdraw"` with `{asset, amount, to, caller}`.

---

## 3. Exact JSON payloads (near-cli)

Amounts in `U128` fields are serialised as **decimal strings** (a JSON number also
works while it fits in `u64`; strings are the safe form). Argument names are snake_case;
near-sdk also accepts camelCase spellings.

### `set_policy` (owner)

```json
{
  "policy_hash": "sha256:6f1c...  (opaque string, your off-chain policy digest)",
  "limits": [
    { "asset_id": "near",      "per_tx": "1000000000000000000000000", "daily": "5000000000000000000000000", "monthly": "50000000000000000000000000" },
    { "asset_id": "usdc.near", "per_tx": "25000000",                 "daily": "100000000",               "monthly": "1000000000" }
  ],
  "allowlist": ["alice.testnet", "bob.testnet"]
}
```

```bash
near call veto.testnet set_policy '{
  "policy_hash": "sha256:6f1c9d2e",
  "limits": [
    {"asset_id":"near","per_tx":"1000000000000000000000000","daily":"5000000000000000000000000","monthly":"0"},
    {"asset_id":"usdc.near","per_tx":"25000000","daily":"100000000","monthly":"1000000000"}
  ],
  "allowlist": ["alice.testnet","bob.testnet"]
}' --accountId owner.testnet
```

This policy says: at most 1 NEAR per transfer and 5 NEAR per rolling day of native
NEAR (no monthly cap), and at most 0.25 / 1 / 10 USDC per tx / day / 30 days, only to
`alice.testnet` and `bob.testnet`.

Note `"monthly":"0"` = no monthly cap; `"daily":"0"` would force `"per_tx":"0"` (any
spend is then refused with `PER_TX_LIMIT`).

### `spend` (agent)

```json
{
  "asset_id": "usdc.near",
  "amount": "25000000",
  "to": "alice.testnet",
  "decision_hash": "9f2c1b0d5e... (optional, any string; null is allowed)"
}
```

```bash
near call veto.testnet spend '{
  "asset_id": "usdc.near",
  "amount": "25000000",
  "to": "alice.testnet",
  "decision_hash": "9f2c1b0d5e"
}' --accountId agent.testnet --gas 100000000000000
```

`decision_hash` may be omitted entirely:

```bash
near call veto.testnet spend '{"asset_id":"near","amount":"1000000000000000000000000","to":"alice.testnet"}' \
  --accountId agent.testnet
```

### Views

```bash
near view veto.testnet get_config
near view veto.testnet get_usage '{"asset_id":"usdc.near"}'
near view veto.testnet get_last_decision_hash
near view veto.testnet get_decision_count
near view veto.testnet check '{"asset_id":"usdc.near","amount":"25000000","to":"alice.testnet"}'
# -> "allow"   or   "deny:DAILY_LIMIT" etc.
```

### Admin

```bash
near call veto.testnet set_paused '{"paused":true}' --accountId owner.testnet
near call veto.testnet set_agent '{"agent":"agent2.testnet"}' --accountId owner.testnet
near call veto.testnet withdraw '{"asset_id":"near","amount":"1000000000000000000000000","to":"owner.testnet"}' --accountId owner.testnet
```

### Init

```bash
near call veto.testnet new '{"owner":"owner.testnet","agent":"agent.testnet"}' \
  --accountId owner.testnet --gas 300000000000000
```

`near-cli-rs` equivalent shape:

```bash
near contract call-function as-transaction veto.testnet spend json-args \
  '{"asset_id":"usdc.near","amount":"25000000","to":"alice.testnet","decision_hash":"9f2c"}' \
  prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as agent.testnet network-config testnet sign-with-keychain send
```

---

## 4. Build and test

```bash
# 1. wasm (the deployable artifact)
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/veto_policy.wasm res/veto_policy.wasm

# 2. unit tests (mocked blockchain, no node/account required)
cargo test
```

On Windows, `./build.ps1` does step 1 (sets `CARGO_HOME`/`RUSTUP_HOME` to the
workspace-local toolchain if present, builds, copies into `res/`, prints size + sha256),
and `./test.ps1` does step 2 with the same environment handling.

Deploy:

```bash
near deploy veto.testnet res/veto_policy.wasm --accountId veto.testnet
```

`cargo test` runs the whole policy suite against `near-sdk`'s `VMContext` mock: the
happy path, each limit wall, the rolling-window resets (day and 30-day), the allowlist,
pause, the owner/agent separation on every method, `check`/`spend` agreement on all
seven reason codes, the unenforceable-policy rejection, and the hash-chain advance.

The test build needs a **C toolchain** on the host (the `near-sdk` `unit-testing`
feature pulls `aws-lc-sys`, `blst` and `secp256k1-sys`), i.e. `cc`, `cmake` and `nasm`
must be available; the wasm build does not.

---

## 5. Storage layout

One Borsh struct under the default state key:

```rust
Contract {
    owner: AccountId, agent: AccountId, paused: bool, policy_hash: String,
    allowlist: Vec<AccountId>, limits: Vec<AssetLimit>,
    last_decision_hash: String, decision_count: u64,
    usage: Vec<(String, Usage)>,   // per asset id, at most a few entries
}
```

`usage` is a vector (not a `LookupMap`) on purpose: a policy only ever covers a handful
of assets, and a plain vector keeps the whole state Borsh-serialisable with no
storage-key bookkeeping or flushed-collection footguns.

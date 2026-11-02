# On-chain proof (NEAR testnet)

These transactions were produced by `node scripts/testnet-demo.ts` on **testnet**
on 2026-10-19. Nothing here touches mainnet and no real funds are involved:
the three accounts were funded from the public testnet faucet.

Reproduce it yourself:

```bash
node scripts/testnet-account.ts     # optional: creates one faucet-funded account
node scripts/testnet-demo.ts        # creates the rest, deploys, runs the four calls
node scripts/testnet-daily-cap.ts   # fills the daily budget, then proves the refusal
```

No keys and no faucet? `npm run chain:show` prints the recorded evidence below from
[`testnet-run.json`](testnet-run.json) — public account ids, transaction hashes and
state reads only, no private keys.

## Accounts

| Role | Account | Notes |
|---|---|---|
| contract / owner | `5ac5ef1f12f81b18d16d05b038e9168bc92f5adfbf7a61994fc6345e34929633` | holds the funds and the policy |
| agent | `18a227a22bd26094ef5de46e87152737ecd4f2ece95104f6cac712d15388b47a` | ends with **one** key: function-call, `spend` only |
| vendor | `f2b01d0594579eea1c7305bd972464583469c0d6d232c1e5e11d578af872c680` | the only account the agent may pay |

The policy hash installed on-chain by this run is the same hash the off-chain engine
pins:
`aec57ca4a000340f31b0b95da8da35390b159797a2cf22c6810b8f5f89f7232a`.
(The NEP-141 run further down replaces the policy with a two-asset one and installs
its own hash — that is a policy update, which the contract records.)

## The five transactions

| # | What | Transaction |
|---|---|---|
| 1 | deploy the contract | [`9J4khkaMK3eNApQnDTYPTBt547pMBwhGWKzEV3CEqzBC`](https://testnet.nearblocks.io/txns/9J4khkaMK3eNApQnDTYPTBt547pMBwhGWKzEV3CEqzBC) |
| 2 | `new(owner, agent)` | [`BbsTWLvG5f59CKMsHgSuHrQrZGHYuoeeSUGvK3RPDniA`](https://testnet.nearblocks.io/txns/BbsTWLvG5f59CKMsHgSuHrQrZGHYuoeeSUGvK3RPDniA) |
| 3 | agent adds a function-call key scoped to `spend` | [`FuVdUWzARBcVvqjkRbd6npm4XTY6fX7DNwe5wFk6zpBL`](https://testnet.nearblocks.io/txns/FuVdUWzARBcVvqjkRbd6npm4XTY6fX7DNwe5wFk6zpBL) |
| 4 | agent **deletes its own full-access key** | [`9PDkM5sMAbSFPqyK4N4EGFHFGMxvDUkiGhxUG7H2gyhW`](https://testnet.nearblocks.io/txns/9PDkM5sMAbSFPqyK4N4EGFHFGMxvDUkiGhxUG7H2gyhW) |
| 5 | owner installs the policy (1 NEAR/tx, 2 NEAR/day, 10 NEAR/month) | [`J7C1ywvwPB9wGikrYPmWruTfFXERVa7vsVZViniretfp`](https://testnet.nearblocks.io/txns/J7C1ywvwPB9wGikrYPmWruTfFXERVa7vsVZViniretfp) |
| 6 | agent spends **0.25 NEAR** inside the limits — succeeds | [`BEahB6BG83QHuExjuL2YHBMwnBPdWeegeYpzGur1pfhx`](https://testnet.nearblocks.io/txns/BEahB6BG83QHuExjuL2YHBMwnBPdWeegeYpzGur1pfhx) |
| 7 | agent tries **1.5 NEAR** — reverted by the contract | [`JDtQ44eSeoEKBATno3q9JuSmyrtgQSTUi9yRuEss3C4c`](https://testnet.nearblocks.io/txns/JDtQ44eSeoEKBATno3q9JuSmyrtgQSTUi9yRuEss3C4c) |
| 8 | agent tries `set_paused(true)` — refused by the **key**, before the contract | rejected at validation (`Access key does not allow method set_paused`) |

After the two spends, the vendor's balance is exactly `5.25 NEAR`: the 0.25 NEAR
moved, the 1.5 NEAR did not.

## The rolling daily window (the wall that needs state)

A per-transaction cap is easy. The daily cap is the interesting one, because the
contract has to remember. The same policy allows 2 NEAR per day, and the day was
filled by four accepted spends; the fifth was refused **by the contract**, with the
reason read back from the `deny` event on the failed receipt:

| Spend | Result | Transaction |
|---|---|---|
| 0.25 NEAR | accepted (during the main demo) | [`BEahB6BG83QHuExjuL2YHBMwnBPdWeegeYpzGur1pfhx`](https://testnet.nearblocks.io/txns/BEahB6BG83QHuExjuL2YHBMwnBPdWeegeYpzGur1pfhx) |
| 1.00 NEAR | accepted | [`ERWArc5F9cPZz2akExYA6Ngtz3p6DUBi4Uarj32Yk2e4`](https://testnet.nearblocks.io/txns/ERWArc5F9cPZz2akExYA6Ngtz3p6DUBi4Uarj32Yk2e4) |
| 0.50 NEAR | accepted | [`21qnz5tnytRDaEj6qti4HNst9Ek8UUSZrjKb9tFrNveT`](https://testnet.nearblocks.io/txns/21qnz5tnytRDaEj6qti4HNst9Ek8UUSZrjKb9tFrNveT) |
| 0.25 NEAR | accepted — the day is now exactly full | [`DGGuSiLn8KqEKaSUjA3JX5QjvhaBxfTU4f89Hp9vckXp`](https://testnet.nearblocks.io/txns/DGGuSiLn8KqEKaSUjA3JX5QjvhaBxfTU4f89Hp9vckXp) |
| 0.50 NEAR | **reverted: `DAILY_LIMIT`** | [`FGa1eUmsadSsdVLKP1mYQtQ5kQFwCQS2RYCiex89L2B1`](https://testnet.nearblocks.io/txns/FGa1eUmsadSsdVLKP1mYQtQ5kQFwCQS2RYCiex89L2B1) |

Reproduce with `node scripts/testnet-daily-cap.ts`: it computes the remaining daily
room from the contract, spends it, then tries to exceed it, and **reads the deny
reason back from the receipt** instead of asserting its own success.

These counters are a snapshot of 2026-10-19. The contract keeps rolling windows, so by the
time you read this the day counter is back at zero - which is exactly why the conformance
suite no longer asserts "the day is full" but re-establishes the situation itself.

Snapshot of that run:

```json
{
  "get_usage(near)": { "day_spent": "2000000000000000000000000", "month_spent": "2000000000000000000000000" },
  "get_decision_count": 4,
  "get_last_decision_hash": "a20fc2c723c82843c123fde2a4ae7e6159531504367661e023ad09b44b9da271",
  "check(0.50 NEAR)": "deny:DAILY_LIMIT"
}
```

Exactly four successful spends advanced the decision chain; the reverted one did
not, and the counters never exceeded the cap.

## A NEP-141 asset, not just native NEAR

Stablecoin limits are the reason the policy has an asset registry, so the token path
was exercised on chain too, with wNEAR (`wrap.testnet`, 24 decimals). `node
scripts/testnet-ft.ts` does the whole loop: wrap NEAR into the vault, install a policy
that carries both `near` and `wrap.testnet` limits, let the agent spend 0.40 wNEAR, and
watch the next 0.60 wNEAR get refused.

| Step | Transaction |
|---|---|
| `storage_deposit` for the vault | [`FjmSftovUETPXY8wCDs85Yw2uEczvUF2iDxhJvqqS2jj`](https://testnet.nearblocks.io/txns/FjmSftovUETPXY8wCDs85Yw2uEczvUF2iDxhJvqqS2jj) |
| `storage_deposit` for the vendor | [`4mvodtZojzWvVbCWKsfCEnmhHD2VM2fQoHYPZ5f7nhAr`](https://testnet.nearblocks.io/txns/4mvodtZojzWvVbCWKsfCEnmhHD2VM2fQoHYPZ5f7nhAr) |
| `near_deposit` (1.50 NEAR → wNEAR in the vault) | [`KNJnKDofvodFnZtAPmaGf6o8KnnvVT8BRyrA2RVcHmc`](https://testnet.nearblocks.io/txns/KNJnKDofvodFnZtAPmaGf6o8KnnvVT8BRyrA2RVcHmc) |
| `set_policy` with `near` + `wrap.testnet` limits | [`2MTyprAddhADoP4jzd4QUBkUVhSRrzeNmCzT335kaVAS`](https://testnet.nearblocks.io/txns/2MTyprAddhADoP4jzd4QUBkUVhSRrzeNmCzT335kaVAS) |
| agent spends 0.40 wNEAR (accepted, delivered) | [`4ZBgTTM6w9sRwdFSGVo8Jvonny9zR2e7LXhnVZvp33aH`](https://testnet.nearblocks.io/txns/4ZBgTTM6w9sRwdFSGVo8Jvonny9zR2e7LXhnVZvp33aH) |
| agent tries 0.60 wNEAR (reverted: `PER_TX_LIMIT`) | [`7QrhFBXmwqvhJ54rjLTJAjSpoZfhgUChPCr7ph1vMzbG`](https://testnet.nearblocks.io/txns/7QrhFBXmwqvhJ54rjLTJAjSpoZfhgUChPCr7ph1vMzbG) |

```
check(0.60 wNEAR) -> "deny:PER_TX_LIMIT"
check(0.40 wNEAR) -> "allow"
vendor wNEAR 0.00 -> 0.40 (delta 0.40)
get_usage(wrap.testnet): day 0.40, month 0.40
```

Two things this run taught us, both now documented in
[`../contract/README.md`](../contract/README.md):

1. **The vault is the owner account in this demo**, so wrapping NEAR credits the vault
   directly. A `ft_transfer` from the owner to itself is rejected by the token
   (`Sender and receiver should be different`) — obvious in hindsight, and exactly the
   kind of thing that only shows up when you stop mocking.
2. A token transfer needs **storage registration on the token contract** for both the
   vault and the payee; without it `ft_transfer` fails inside the cross-contract call,
   where the panic is harder to read.

## The bug the chain found (and the fix in the contract)

Nine days after the first run the conformance suite failed one check, and it was not a
flaky test:

```
daily window: a spend that fits is accepted    accepted   refused    FAIL
```

The vault had paid out more than it held in *available* NEAR (its 307 KB of code locks
~3.05 NEAR as storage stake), so a 0.6 NEAR transfer could not be covered. The
transaction still executed: the contract wrote the spend counters, advanced the decision
hash chain and emitted a `spend` event, and only then did the transfer receipt fail with
`LackBalanceForState`. Budget burned, funds not delivered, and the log said "spend".

Fixed in `contract/src/lib.rs`: `spend` and `check` now compute

```rust
available = account_balance - storage_byte_cost * storage_usage
```

and refuse with `INSUFFICIENT_BALANCE` **before** touching state. After redeploying, the
same situation is rejected cleanly and nothing is counted:

```
check(0.5 NEAR) -> "deny:INSUFFICIENT_BALANCE"
tx 6X5edANSvC4tnHNHRovE55iuXXMWTCoa61J4XurBSRET
event: {"standard":"veto","version":"1.0.0","event":"deny","data":{
  "reason":"INSUFFICIENT_BALANCE","available":"248460122278521199999999", ...}}
```

The vault was then topped up from the vendor
(`G2z51YpGJ4Qn2HHDdsRj45sn9h1xVtfDVcsdrar3AEwk`, 3 NEAR) and the suite returned to green:
`37/37 conformance checks passed`.

This is the strongest argument for the whole project: the invariant "a refusal never moves
money, and a `spend` event means money moved" held in every unit test and was false on the
chain until a test went looking for it.

## When the agent key runs out (rotation)

A function-call key has a finite allowance, and **gas is charged against it**, so an agent
that never overspends still runs out of room eventually. On 2026-10-27 the demo agent hit
exactly that: every `spend` started failing at validation, and the conformance suite went
red for a reason that had nothing to do with the policy.

The recovery path is the same one you would use after a key leak, and it is a script now
(`npm run chain:rotate [allowanceNear]`):

| Step | Transaction |
|---|---|
| new agent account, funded by the faucet | `9859067d042c3555b4f10f9654dfc1c2f604801019460d9ab408ad5df09a2753` |
| the new agent adds a `spend`-only key (10 NEAR allowance) | [`3a9CdE8dij2A9La3G8c3r53YvmxCeFt5WgktVK2bbhVp`](https://testnet.nearblocks.io/txns/3a9CdE8dij2A9La3G8c3r53YvmxCeFt5WgktVK2bbhVp) |
| the new agent deletes its full-access key | [`6BsLoyJLP89hPWTgJH7vf9opzwgAm2PNPJVdgPU8UDrA`](https://testnet.nearblocks.io/txns/6BsLoyJLP89hPWTgJH7vf9opzwgAm2PNPJVdgPU8UDrA) |
| the owner points the contract at it (`set_agent`) | [`6eoSvR22XKFmaKX9BB7fmWibQ2oaXHa2VhWkFwd8P8qg`](https://testnet.nearblocks.io/txns/6eoSvR22XKFmaKX9BB7fmWibQ2oaXHa2VhWkFwd8P8qg) |

Two details worth knowing:

- **The access-key list can lag.** Right after `deleteKey` the RPC still reported the
  full key, which looks like a failed rotation. Poll until the list settles before
  believing it — the script now refuses to call an account "restricted" while a
  full-access key is still visible.
- **Rotation is not a policy change.** Counters, the decision hash chain and the policy
  stay exactly where they were; only `agent` moves. That is what makes it usable as the
  response to a compromise, not just to exhaustion.

## Conformance suite against the live contract

Beyond the amounts and the reason codes, the suite also asserts the parts a reviewer
tends to ask about:

- **the decision hash chain is real**: a refused spend leaves `decision_count` and
  `get_last_decision_hash` untouched, an accepted one advances both, and the stored head
  equals `sha256(previous_head || decision_hash)` - the test reproduces the formula rather
  than checking that "something changed";
- **the contract refuses policies it cannot enforce**: `set_policy` with `per_tx > daily`,
  or with a duplicated asset id, is rejected with a message saying a policy that cannot be
  enforced must not be installed;
- **the allow list is live**: installing a policy without the vendor makes `check` answer
  `deny:RECIPIENT_NOT_ALLOWED`, restoring the policy makes it answer `allow`, and the
  pinned policy hash follows both changes.

`npm run chain:conformance` asserts 37 promises **against the deployed contract**,
using the chain as the source of truth. Cases that must be refused are checked for
their exact reason code, read back from the NEP-297 `deny` event on the failed
receipt; read-only cases compare the `check` view answer. It only sends calls that
must be rejected, so it moves no funds and changes no state.

```
37/37 conformance checks passed against the live contract
```

| Case | Expected | Actual |
|---|---|---|
| owner / agent / policy hash / allowlist recorded on chain | the values we installed | same |
| `check`: amount above the per-tx cap | `deny:PER_TX_LIMIT` | same |
| `check`: unknown recipient | `deny:RECIPIENT_NOT_ALLOWED` | same |
| `check`: asset with no limit | `deny:NO_LIMIT` | same |
| `check`: zero amount | `deny:NON_POSITIVE_AMOUNT` | same |
| `spend`: stranger / unknown asset / zero / over per-tx / over daily | the same five codes, as `deny` events | same |
| `check` + `spend`: wNEAR above / inside its own cap | `deny:PER_TX_LIMIT` / `allow` | same |
| the vendor's wNEAR balance after the NEP-141 spend | 0.40 wNEAR | same |
| agent calls `set_paused`, `withdraw`, `set_policy` | refused by the access key, before the contract | same |
| owner pauses: `check` and `spend` answer `deny:PAUSED`, then the owner unpauses | `deny:PAUSED`, then `paused=false` | same |
| the suite installs a temporary 0.60/tx, 1.00/day cap, fills the day, and shows the next spend refused | accepted, then `deny:DAILY_LIMIT` | same |
| the original policy hash is restored afterwards | the hash it read at the start | same |
| owner calls `spend` | reverted by the contract (agent-only guard) | reverted |

This exists because the contract's host-side unit tests need a C toolchain
(`aws-lc-sys`, `blst`), which the build environment used for this submission did not
have. The live suite covers the same guarantees, on real storage, with a real VM —
and it is the check a reviewer can run in thirty seconds.

## One operational gotcha worth documenting

A vault that holds funds must keep its balance above the **storage stake**. The
304 KB wasm locks ~3.05 NEAR on the contract account, and after paying out
1.75 NEAR the account could no longer cover a 0.75 NEAR transfer:

```
spend(0.75 NEAR): REJECTED  Account 5ac5…lacks balance … for state
  tx FEo1FsSR3Q7jK7bhz6Z6w7Sa1AoYAwnsN8WgAK9Si1ge
```

That is a protocol rule, not a policy bug — but it looks exactly like a policy
failure from the agent's side, so the vault was topped up (`3gWiZF2BVTWsR5w4TeEs
xiHA2pYQpWLZP5ydXqkM6Krr`, 3 NEAR from the vendor) and the run continued. Any
production deployment should either fund the vault with a healthy margin or use a
global contract (no per-account code storage). Noted in
[`../contract/README.md`](../contract/README.md).

## Why transaction 7 is the interesting one

The contract reverts with a panic, and NEAR reports a panic to a caller as an
opaque `WebAssembly trap`. A revert with no message is useless to an agent, so the
contract **emits the reason before panicking**. The failed receipt still carries
the log:

```
EVENT_JSON:{"standard":"veto","version":"1.0.0","event":"deny","data":{
  "reason":"PER_TX_LIMIT",
  "asset":"near",
  "amount":"1500000000000000000000000",
  "to":"f2b01d0594579eea1c7305bd972464583469c0d6d232c1e5e11d578af872c680",
  "policy_hash":"aec57ca4a000340f31b0b95da8da35390b159797a2cf22c6810b8f5f89f7232a"}}
```

So a refusal is machine-readable twice: off-chain (`Decision.reasons`) and on-chain
(NEP-297 `deny` event), and both carry the same policy hash.

## State read back from the contract (immediately after the two spends above)

```json
{
  "config": {
    "owner": "5ac5ef1f…9633",
    "agent": "18a227a2…b47a",
    "paused": false,
    "policy_hash": "aec57ca4…f7232a",
    "allowlist": ["f2b01d05…c680"],
    "limits": [{ "asset_id": "near", "per_tx": "1e24", "daily": "2e24", "monthly": "10e24" }]
  },
  "usage": { "day_spent": "250000000000000000000000", "month_spent": "250000000000000000000000", "day_start_ns": 1792439866875559700, "month_start_ns": 1792439866875559700 },
  "last_decision_hash": "985f3cb4380984bca1e05c235594bb6631618f90242245f447f40cd5080c15e5",
  "decision_count": 1
}
```

`get_decision_count == 1` because exactly one spend succeeded: the rejected one
never advanced the chain, and rejected calls cannot be used to probe (they are
free to *read* via `check`, but a failed `spend` doesn't write).

Pre-flight checks, as an agent would call them before spending:

| call | result |
|---|---|
| `check(near, 0.1, vendor)` | `"allow"` |
| `check(near, 5.0, vendor)` | `"deny:PER_TX_LIMIT"` |
| `check(near, 0.1, stranger)` | `"deny:RECIPIENT_NOT_ALLOWED"` |

## Notes for a reviewer

- The agent account has **no full-access key**: `view_access_key_list` returns a
  single `FunctionCall` permission, receiver = the contract, method = `spend`,
  allowance 2 NEAR. A stolen agent key cannot add keys, delete keys, withdraw,
  pause or call anything else.
- The function-call key's own allowance is a *fourth* independent ceiling: during
  development it expired at exactly 0.25 NEAR and the network rejected the next
  call before the contract ran. That is the primitive working as designed, not a
  bug — it is documented here because it surprised us.
- These accounts are throwaway demo accounts. `data/testnet-roles.json` is
  gitignored; it contains private keys for testnet accounts and nothing else.

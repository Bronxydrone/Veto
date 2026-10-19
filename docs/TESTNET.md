# On-chain proof (NEAR testnet)

These transactions were produced by `node scripts/testnet-demo.ts` on **testnet**
on 2026-10-19. Nothing here touches mainnet and no real funds are involved:
the three accounts were funded from the public testnet faucet.

Reproduce it yourself:

```bash
node scripts/testnet-account.ts     # optional: creates one faucet-funded account
node scripts/testnet-demo.ts        # creates the rest, deploys, runs the four calls
```

## Accounts

| Role | Account | Notes |
|---|---|---|
| contract / owner | `5ac5ef1f12f81b18d16d05b038e9168bc92f5adfbf7a61994fc6345e34929633` | holds the funds and the policy |
| agent | `18a227a22bd26094ef5de46e87152737ecd4f2ece95104f6cac712d15388b47a` | ends with **one** key: function-call, `spend` only |
| vendor | `f2b01d0594579eea1c7305bd972464583469c0d6d232c1e5e11d578af872c680` | the only account the agent may pay |

The policy hash installed on-chain is the same hash the off-chain engine pins:
`aec57ca4a000340f31b0b95da8da35390b159797a2cf22c6810b8f5f89f7232a`.

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

## State read back from the contract

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

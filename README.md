# Veto

**A spending firewall for AI agents on NEAR.** Agents can spend; they just cannot spend everything.

Built for **NEAR HACKATHON** (tracks: `security`, `agents`).

```
agent ──► intent ──► [ Veto policy engine ] ──► allow ──► funds move
                            │  deny ──────────► nothing moves, reason recorded
                            └─ require_approval ─► a human co-signs, then it moves
```

---

## 1. The problem

An agent with a wallet is an account with initiative and no judgment. The two
things builders do today are both wrong:

- **Give the agent the key.** One prompt injection, one leaked `.env`, one bad
  tool call, and the whole balance is gone. There is no upper bound on the damage.
- **Put a human in front of every action.** Then it is not an agent, it is a form.

Veto is the third option: the agent keeps autonomy inside a **policy** that the
owner writes, that is **pinned by hash**, that is re-checked **at execution time**,
and that is **enforced on-chain** by a contract the agent's key cannot rewrite.
When the agent tries to leave the sandbox, the attempt is refused with a reason
code and written to a tamper-evident log.

### What that looks like in practice

```
 1. ALLOW           pay compute.near for 5 USDC of inference   all checks passed
 2. NEEDS APPROVAL  pay for a data feed, 12 USDC               APPROVAL_REQUIRED
 3. DENY            try 26 USDC in one go                      PER_TX_LIMIT
 4. DENY            pay a stranger                             RECIPIENT_NOT_ALLOWED
 5. DENY            add its own access key                     ACTION_NOT_ALLOWED
 6. ALLOW           swap 1 NEAR -> 4.917804 USDC on Arbitrum   (real 1Click quote)
 7. DENY            same quote, output redirected to 0xdead…   DESTINATION_NOT_ALLOWED
 8. NEEDS APPROVAL  pay 20 USDC  → owner approves → executed
```

*(that is the real output of `npm run demo`, condensed)*

---

## 2. Try it in five minutes

Requirements: **Node.js >= 22.6** (the project uses native TypeScript execution,
so there is no build step and **no dependencies to install**). Rust is only needed
for the contract in `contract/`.

Each step is "do this, see that". Nothing here needs a wallet, a key or funds.

| # | Do this | See that |
|---|---|---|
| 1 | `npm run test:all` | `# pass 79`, `# fail 0`. Includes the adversarial suite: 29 escape attempts, every verdict asserted. |
| 2 | `npm run demo` | The numbered narrative above: 12 decisions, one approval flow, one real NEAR Intents quote, audit chain `verified`, and a tamper check that *detects* an edited record. |
| 3 | `npm run attack` | A 29-row table: `29 attempts: 26 denied, 1 to a human, 2 allowed`. Every row shows the wall it hit. Exit code 1 if any scenario behaves differently than claimed. |
| 4 | `npm run quote` | Fetches a **live** quote from `https://1click.chaindefuser.com/v0/quote` (1 NEAR → USDC on Arbitrum), then prints every policy check with `pass`/`FAIL`. Try `npm run quote 0xdeadbeef00000000000000000000000000000000` to see the same live quote refused. |
| 5 | `npm run chainsig` | Derives the agent's cross-chain address from the NEAR MPC signer and prints `match: the only address this agent may receive swaps on is the one the MPC derives for it`. |
| 6 | `npm run serve` | Dashboard on <http://127.0.0.1:8787>: policy, live budgets, decision feed with per-check detail, approval queue, attack simulator, audit-chain verifier. |
| 7 | `npm run audit` | `{ "ok": true, "records": …, "head": "…" }` — the audit chain of the dashboard process. |

Offline? Steps 1–3 and 6 work with no network at all (the quote is a recorded
fixture); step 4 and 5 need network and say so clearly when it is missing.

### The example policy

`examples/policy.yaml` is the human-authored contract. It is short enough to read
in a minute:

```yaml
owner: alice.near          # the human
agent: argo.near           # the wallet-enabled agent
limits:
  perTx:   { NEAR: 1.5, USDC: 25 }
  daily:   { NEAR: 5,   USDC: 100 }
  monthly: { NEAR: 60,  USDC: 800 }
counterparties:
  mode: strict             # deny by default: only these accounts can be paid
  allow: [api.data-market.near, compute.near, storage.near]
  deny:  [drainer.near]
approvals:
  thresholdUsd: 10         # above $10 a human co-signs
  approvers: [alice.near]
  ttlSeconds: 900
velocity: { maxTxPerHour: 6, minIntervalSeconds: 5 }
actions:
  allow: [near.transfer, ft.transfer, intent.swap, api.pay]
  deny:  [key.add, key.delete, contract.call, stake.delegate]
intents:
  maxSlippageBps: 100
  allowedDestinations: ["0x583d…8c2f"]   # MPC-derived address of argo.near
```

---

## 3. How enforcement actually works

Three independent layers. A judge should be able to break any one of them in
their head and still not get unplanned money out.

### Layer 1 — the decision engine (off-chain, pure)

`src/core/engine.ts` exposes one pure function:

```ts
evaluate(policy, action, ledgerView, { now, prices }) -> Decision
```

- **20 checks, all reported.** Not "denied", but `PER_TX_LIMIT` *and*
  `APPROVAL_REQUIRED` *and* which numbers failed, so a human can see the wall.
- **Exact arithmetic.** Amounts are `bigint` minor units. `5.0000001 USDC` is a
  parse error, not a rounded-down 5.00. A float here would be a limit bypass.
- **Deny by default.** An asset with no limit cannot be spent, an action kind not
  in the allow list cannot run, a recipient outside a strict allow list cannot be
  paid.
- **Agent text is not an input to control flow.** The request's free-text `reason`
  is stored for the audit trail and read by nothing else. Prompt injection has no
  authority because there is no instruction channel.
- **Reservations.** A queued approval books budget immediately, so ten pending
  approvals cannot spend the same daily cap ten times.

### Layer 2 — the contract (on-chain, `contract/`)

The vault holds the funds and the limits. The agent's key is a **function-call
key scoped to `spend`** on that contract, so a leaked agent key cannot add keys,
delete keys, call arbitrary contracts or withdraw.

- `spend(asset, amount, to, decision_hash)` recomputes per-tx, rolling daily and
  rolling 30-day limits from the contract's own storage, enforces the allow list
  and the pause switch, then transfers.
- `set_policy` / `set_paused` / `set_agent` / `withdraw` are owner-only.
- `check(...)` is a view that shares the exact evaluation code with `spend`, so a
  dry run can never disagree with the real transaction.
- Each successful spend anchors the off-chain decision hash into an on-chain hash
  chain (`last_decision_hash`, `decision_count`), which is how deleting records
  from the local audit log becomes detectable.

### Layer 3 — the human (approval queue)

Above `approvals.thresholdUsd` the payment does not fail, it waits.

- Approval requires a configured approver; the agent approving its own spending is
  refused (`not_an_approver`).
- Approvals expire (`ttlSeconds`) and release their reservation.
- **The policy is re-evaluated at approval time** against the current policy and
  the current ledger. An approval issued under yesterday's limits cannot be used
  after the owner tightens them — the request is marked `superseded` with the
  reason. This is the TOCTOU case, and it is tested.

### The audit trail

Every decision — including denials — becomes a hash-chained record
(`prevHash → hash`). `verify()` recomputes the whole chain and reports the exact
sequence number of the first break. The head hash is what a caller anchors
on-chain. Honest limit: dropping the *tail* leaves a valid prefix, which is
exactly why the head is anchored and compared, not just recomputed.

---

## 4. NEAR-specific pieces (what is real, and what is not)

| NEAR feature | How Veto uses it | Status |
|---|---|---|
| **NEAR Intents / 1Click** | Real quotes from `https://1click.chaindefuser.com/v0/quote` are validated before a swap: venue, slippage ceiling, quote expiry, origin asset, and the destination address. `dry: true` means no funds, no key, no signature. | **Live integration**. Fixture captured 2026-10-19 19:40 UTC (1 NEAR → 4.917804 USDC on Arbitrum) so the demo also runs offline. |
| **Chain Signatures (MPC)** | The pinned swap destination is not a typed constant: it is the address `v1.signer` derives for `(argo.near, "ethereum-1")` = `0x583ddbf02324f75c3963c45686d52afaf2368c2f`. `npm run chainsig` re-derives it live and compares. | **Live read-only integration** (RPC view call, verified against the MPC signer). Signing is a roadmap item, gated on the same policy. |
| **Function-call access keys** | The agent's key is scoped to `spend` on the policy contract only. | Implemented in the contract + documented deploy flow. |
| **Named accounts / sub-accounts** | Owner, agent and every allow-listed vendor are named accounts, which makes the allow list human-auditable. | Used throughout. |
| **NEP-297 events** | `spend` and policy changes emit `EVENT_JSON` events for indexers. | Implemented in the contract. |
| **NEAR testnet contract** | `contract/` builds a `wasm32-unknown-unknown` contract with unit tests over limit logic. | Build + unit tests reproduced below. |

Deliberately **not** used: a token, a DAO, a marketplace. Veto is infrastructure —
the thing other agent projects would put in front of their wallet.

---

## 5. The attack catalogue

`src/demo/scenarios.ts` is the single source of truth: the CLI, the dashboard's
attack simulator and the adversarial test suite all read it. Adding a scenario
without a verdict is not possible — the test asserts every row.

| # | Attempt | Wall that stops it | Verdict |
|---|---|---|---|
| 1–2 | Overspend one transfer (26 USDC, 1000 NEAR) | per-transaction cap | deny |
| 3–6 | Smuggle decimals, negative, zero, scientific notation | exact amount parsing | deny |
| 7–8 | Wrong-case / trailing-dot account id | account id validation | deny |
| 9–10 | Empty action id, invented action kind | request shape / allow list | deny |
| 11 | Spend an asset no limit covers | deny-by-default registry | deny |
| 12–14 | Stranger, deny-listed drainer, cyrillic homoglyph | counterparty lists | deny |
| 15 | Agent claims the owner account | identity binding | deny |
| 16–18 | Add key, delete key, arbitrary contract call | action kind allow list | deny |
| 19–24 | Swap: no quote, 5% slippage, redirected output, unknown venue, expired quote, asset mismatch | quote validation | deny |
| 25 | Payment above the approval line | approval threshold | **require_approval** |
| 26–27 | Legitimate API payment, legitimate swap | — | **allow** |
| 28–29 | Anything, once paused / once expired | owner switch, expiry | deny |

Beyond the catalogue, the suite covers stateful attacks: draining the daily cap
slice by slice (stops exactly at the cap), spreading spend across 20 days until
the monthly cap bites, replaying an action id, bursting past the hourly rate
limit, stacking pending approvals, expiring approvals, self-approval, TOCTOU on
policy change, audit tampering, and policy-hash substitution.

---

## 6. Design decisions worth defending

1. **The evaluator is pure and has no clock of its own.** Time is injected, so
   tests can prove a daily window is a day, not a month. (This caught a real bug:
   the daily check was reading the monthly window.)
2. **`bigint`, never `float`.** Rounding is not a UX detail in a limit check.
3. **All failures are returned, not just the first.** Explainable denials beat a
   single "forbidden" — for the owner, and for the agent's own retry logic.
4. **Reservations, not just spend totals.** Pending money is still money.
5. **Re-check at execution.** An approval is a request to re-evaluate, not a
   pre-authorised payment.
6. **The policy is data, pinned by hash.** A changed policy cannot load silently;
   the change shows up as a `POLICY_UPDATED` record with both hashes.
7. **The LLM is not in the trust path.** Rules may only *tighten* (escalate to a
   human); nothing an LLM says can widen a limit. That is the difference between a
   guardrail and a decoration.
8. **Honest limits are documented** in [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md):
   we bound consequences, we do not judge intent, price fairness is out of scope,
   and a tail-truncated log needs the anchored head to be caught.

---

## 7. Repository layout

```
src/core/          the engine: money, policy, ledger, audit, evaluate()
src/core/engine.ts one pure function, 20 checks, no I/O
src/core/service.ts stateful guard: approvals, reservations, persistence
src/chain/         NEAR Intents (1Click) client, chain signatures (MPC) helper
src/demo/          the scenario catalogue shared by CLI, UI and tests
src/cli/           `veto demo | attack | quote | chainsig | evaluate | audit`
src/app/           dependency-free HTTP server + dashboard (no build step)
examples/          the policy a human writes
contract/          Rust policy vault (near-sdk), owner/agent separation
test/unit/         79 tests: money, YAML, policy, engine, chain signatures
test/adversarial/  catalogue assertions + stateful attacks
docs/              threat model, demo script
data/fixtures/     one recorded live 1Click quote (offline reproducibility)
```

---

## 8. Running the contract

```bash
cd contract
./build.ps1                 # builds res/veto_policy.wasm with a pinned toolchain
cargo test                  # limit logic, owner/agent separation, hash chain
```

Deploy (testnet) and the exact call arguments are in
[`contract/README.md`](contract/README.md). The deploy flow is deliberately manual:
no script in this repository signs or spends anything on its own.

---

## 9. What is next

- Sign and broadcast cross-chain payments through chain signatures inside the same
  policy gate (the address derivation and the pinning already exist).
- Anchor the audit head to the contract on every N decisions, not just on spends.
- A price oracle port so USD thresholds do not depend on a local price map.
- Policy templates for common agent jobs (research agent, ops agent, merchant bot).

---

## 10. Licence

MIT. Built at NEAR HACKATHON, November 2026.

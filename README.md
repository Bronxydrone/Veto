# Veto

[![ci](https://github.com/Bronxydrone/Veto/actions/workflows/ci.yml/badge.svg)](https://github.com/Bronxydrone/Veto/actions/workflows/ci.yml)  [![tests](https://img.shields.io/badge/tests-94%20js%20%C2%B7%2031%20rust-brightgreen)](https://github.com/Bronxydrone/Veto#2-try-it-in-five-minutes)

**A spending firewall for AI agent wallets on NEAR.** Agents can spend; they just cannot spend everything.

It is not a tool-call policy library. Those decide whether an agent may call a function;
Veto decides whether money may leave a wallet, and enforces that inside a contract that
holds the funds and recomputes the limits itself.

**In one paragraph:** the money lives in a contract, not in the agent. The agent's key can
only ask that contract to `spend()`, and the contract recomputes per-transaction, daily and
30-day limits from its own storage on every call. A refusal reverts the transaction *and*
emits a NEP-297 `deny` event carrying the reason code, so the agent can read why it was
stopped. Anything above the owner's threshold waits for a human, and that approval is
re-checked against today's policy, so a stale one cannot be spent.

**Proven on NEAR testnet, not in a slide:** 37 conformance checks against the deployed
contract (deny reasons read back from the on-chain events), 29 adversarial scenarios with
asserted verdicts, 1000 random actions checked against the invariants, and 31 contract tests
on a real NEAR VM. Nothing to install, nothing to trust:

```bash
npm run story     # the use case in five beats, 40 seconds, offline
npm run attack    # 29 ways out of the walls, every verdict asserted
npm run test:all  # 94 tests, 0 failures, no dependencies
```

Built for **NEAR HACKATHON** — tracks `security` and `agents`.

```
agent ──► intent ──► [ Veto policy engine ] ──► allow ──► funds move
                            │  deny ──────────► nothing moves, reason recorded
                            └─ require_approval ─► a human co-signs, then it moves
```

![npm run demo](docs/shots/demo.png)

*`npm run demo` — allowed payment, approval, three refusals, a live NEAR Intents
quote, the same quote with a redirected destination refused, a human approval, and
a tamper check that catches an edited audit record.*

---

### The use case, in forty seconds

A research agent holds 100 USDC and pays for data. A page it fetched tells it to send **40
USDC** to a vendor: the wallet refuses, the agent reads the reason back and buys the small
tier instead. A stranger's address in the next request is refused by name. A 20 USDC
subscription waits for the owner, because the agent cannot approve itself. Then the agent's
key is stolen - and the attacker can add a key or stake or call anything, and every one of
those action kinds is denied, so the money is still in the vault.

```
npm run story
```

![npm run story](docs/shots/story.png)

Every verdict in that output comes from the real engine and `examples/policy.yaml`.

## 1. The problem

An agent with a wallet is an account with initiative and no judgment. The two
things builders do today are both wrong:

- **Give the agent the key.** One prompt injection, one leaked `.env`, one bad
  tool call, and the whole balance is gone. Nothing bounds the damage.
- **Put a human in front of every action.** Then it is not an agent, it is a form.

Veto is the third option. The owner writes a **policy** (per-transaction, daily and
monthly caps, counterparty allow/deny lists, an approval threshold, velocity
limits, allowed action kinds, swap venue/slippage/destination pins, expiry, pause).
The policy is **pinned by hash**, every agent action is **judged before money
moves**, approvals are **re-checked at execution time**, and the walls are
**enforced on-chain** by a contract the agent's key cannot rewrite. Refusals are
recorded with a reason code, off-chain in a hash-chained audit log and on-chain as
a NEP-297 `deny` event.

### What that looks like

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

That is the real output of `npm run demo`, condensed.

---

## 2. What is actually different here

Agent wallets are a crowded space this month, and most of them are the same shape: a
policy check inside the agent's process, right before it signs. That is useful, and it has
one failure mode worth naming - if the process is compromised, the check goes with it.

Veto moves the three things that usually live in the agent out of it:

| | a check before signing | Veto |
|---|---|---|
| Where the money is | the agent's wallet | a contract; the agent holds a `spend`-only function-call key |
| Where the limits are recomputed | the agent's process | the contract's own storage, on every call |
| What a refusal produces | an exception the agent may swallow | a reverted transaction **and** a NEP-297 `deny` event carrying the reason code |
| How approval works | a flag in memory | a queued request that re-runs the policy at execution time, so a stale approval cannot be spent |
| Where the audit lives | a local log file | a hash chain whose head is anchored on-chain, so an edited record is detectable later |

The off-chain engine is still there, and it is what makes refusals explainable: ~20 checks,
each with the number it used (`26 USDC exceeds the 25 USDC per-tx limit`), deny-by-default,
and reserved budget for pending approvals so two approvals cannot both fit.

Claims are cheap, so every line above is checked by something you can run:

- **37 conformance checks** against the deployed contract, with deny reasons read back from
  the on-chain events (`npm run chain:conformance`);
- **29 adversarial scenarios** with asserted verdicts (`npm run attack`);
- **1000 random actions** against the invariants: no spending past the daily cap, no
  payment to a stranger, no state change on a denial, no replay (`npm run test:all`);
- **31 contract tests** on a real NEAR VM, in CI.

### How fast is one decision

The engine runs on every payment, so it has to be cheap. Twenty thousand decisions per
shape, after a warmup, on the machine this was written on (Node 24):

```
shape                                       p50       p95       p99       max
ft.transfer (USDC, allow-listed vendor)     12.50 µs  17.90 µs  41.40 µs 553.10 µs
ft.transfer (USDC, over the per-tx cap)     12.60 µs  15.50 µs  26.60 µs 531.70 µs
native transfer (NEAR, stranger)            19.00 µs  27.80 µs  43.30 µs 904.20 µs
denied action kind (key.add)                18.20 µs  23.10 µs  38.40 µs 625.90 µs
```

`npm run bench` reproduces it. The max column includes garbage collection: it is a spike,
not the steady state.

## 3. Try it in five minutes

Requirements: **Node.js >= 22.6**. The project uses native TypeScript execution, so
there is no build step and **nothing to install** for steps 1–7 (the only npm
dependency, `near-api-js`, is a devDependency used by the optional testnet scripts
in step 8). Rust is needed only for the contract in `contract/`.

Each step is "do this, see that". Nothing here needs a wallet, a key or funds.

| # | Do this | See that |
|---|---|---|
| 0 | `npm run mvp` | The whole product on one screen, in ten seconds and with no network: one payment allowed, one over the per-tx cap refused, one stranger refused, one key change refused, one payment escalated to the owner and executed after the agent is told it cannot approve itself. Nine audit records, chain verified. |
| 1 | `npm run test:all` | `# pass 94`, `# fail 0` — engine, policy, ledger, audit, approvals, chain signatures, plus the adversarial suite where every verdict is asserted. |
| 2 | `npm run demo` | The numbered narrative above: 12 decisions, one approval flow (including the agent being refused permission to approve its own payment), one real NEAR Intents quote, `audit chain verified`, and a tamper check that *detects* an edited record. |
| 3 | `npm run attack` | A 29-row table ending in `29 attempts: 26 denied, 1 to a human, 2 allowed`. Every row names the wall it hit. Exit code 1 if any row disagrees with its claim. |
| 4 | `npm run quote` | Fetches a **live** quote from `https://1click.chaindefuser.com/v0/quote` (1 NEAR → USDC on Arbitrum), then prints all ~19 policy checks with `pass`/`FAIL`. Add an address to see the same live quote refused: `npm run quote 0xdeadbeef00000000000000000000000000000000`. |
| 5 | `npm run chainsig` | Derives the agent's cross-chain address from NEAR's MPC signer and prints `match: the only address this agent may receive swaps on is the one the MPC derives for it`. |
| 6 | `npm run serve` | Dashboard on <http://127.0.0.1:8787>: policy, live budgets, decision feed with per-check detail, approval queue, 29-scenario attack simulator, audit-chain verifier. |
| 7 | `npm run audit` | `{ "ok": true, "records": …, "head": "…" }` — the audit chain of the last dashboard/CLI process. |
| 8 | `npm run chain:demo` | Deploys the contract to **NEAR testnet** and runs the calls in §5: agent spends inside the limits (succeeds), agent tries 1.5× the cap (reverted, with a readable `deny` event), agent tries to pause the contract (refused by its key). Needs network and faucet-funded testnet accounts; already-run evidence with explorer links is in [`docs/TESTNET.md`](docs/TESTNET.md). |
| 9 | `npm run chain:daily` | Fills the rolling daily budget on testnet, then tries to exceed it: the contract reverts with `DAILY_LIMIT` and the script **reads the reason back from the failed receipt's `deny` event**. |
| 10 | `npm run chain:conformance` | **37/37 checks against the deployed contract**: owner/agent/allow-list/policy-hash on chain, four NEAR and two wNEAR `check` answers, six refused spends with their exact reason codes, three owner-only calls refused by the agent key, one agent-only call refused for the owner, and the vendor's wNEAR balance. Moves no funds, changes no state. |
| 11 | `npm run chain:ft` | The **NEP-141 path**, on chain, with wNEAR: wrap NEAR into the vault, install a policy with both a `near` and a `wrap.testnet` limit, let the agent spend 0.40 wNEAR (the vendor's token balance really changes), then watch 0.60 wNEAR get reverted with `PER_TX_LIMIT`. |
| 12 | `npm run chain:rotate` | Rotates the agent account: a fresh faucet-funded account gets a `spend`-only key, deletes its full-access key, and the owner points the contract at it with `set_agent`. This is also the compromise response, and it is what unblocked the demo when the old key's allowance ran out. |
| 13 | `npm run bench` | Twenty thousand decisions per shape with p50/p95/p99 latency, printed as microseconds. No network, no deps. |

Step 6 has a face. These are screenshots of the dashboard actually running, not mockups:

| A refused payment | The approval queue |
|---|---|
| ![A refused payment with all 19 checks listed](docs/shots/dashboard.png) | ![Two payments waiting for a human](docs/shots/approvals.png) |
| 26 USDC against a 25 USDC per-tx cap: `PER_TX_LIMIT`, `APPROVAL_REQUIRED`, a risk escalation, and **every check spelled out** with the number it used — "26 USDC exceeds the 25 USDC per-tx limit", "26 of 100 USDC remaining today". | Requests above $10 hold their budget and wait for a person: `2 waiting`, two cards with the amount, the destination, the deadline and `as alice.near`. The line at the bottom is a request the owner already rejected. |

Before publishing anything, `npm run preflight` answers one question — *is this
repository shippable right now?* It checks the static facts (policy compiles, assets exist,
the wasm matches the size and hash quoted here, every relative link resolves, the
submission payload is valid, secrets are gitignored) and then runs every command above,
reporting only exit codes:

```
16 passed, 0 failed, 0 skipped
shippable: the repository is consistent and every command exited 0.
```

Add `--offline` to skip the three checks that need the network, and `--published` to also prove the repository is live on GitHub (public, branch `main`, README published).

Offline? Steps 1–3, 6 and 7 work with no network at all: the 1Click quote is a
recorded fixture (`data/fixtures/quote.json`), and each step says so when the
network is missing.

### The bug the chain found, and the tests did not

Every claim above was checked on a real network, and that is how this project's most
instructive bug surfaced. On testnet, with the vault too poor to cover a transfer, `spend`
**wrote the budget counters, advanced the audit chain and emitted a `spend` event** — and
only then did the transfer receipt fail with `LackBalanceForState`. Budget burned, money
not delivered, and the log claiming the payment went through. No unit test caught it,
because the mocked context was always funded.

On NEAR a function call and the receipts it spawns are not atomic, so "the call returned"
never meant "the money moved". The contract now checks `account_balance - storage_cost`
before touching any state and refuses with `deny:INSUFFICIENT_BALANCE` instead:

```
$ npm run chain:conformance
  check(0.5 NEAR) -> "deny:INSUFFICIENT_BALANCE"
  {"reason":"INSUFFICIENT_BALANCE","available":"248460122278521199999999"}
```

The whole story, with the failing transaction and the fix, is in
[`docs/TESTNET.md`](docs/TESTNET.md#the-bug-the-chain-found-and-the-fix-in-the-contract).

### The policy a human writes

`examples/policy.yaml` is the whole contract, short enough to read in a minute:

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

## 4. How enforcement works: three independent layers

A reviewer should be able to break any one layer in their head and still not get
unplanned money out.

### Layer 1 — the decision engine (off-chain, pure)

`src/core/engine.ts` is one pure function:

```ts
evaluate(policy, action, ledgerView, { now, prices }) -> Decision
```

- **~19–20 checks per decision, all reported.** Not "denied", but `PER_TX_LIMIT`
  *and* `APPROVAL_REQUIRED` *and* the numbers that failed — so the owner sees the
  wall and the agent can retry intelligently.
- **Exact arithmetic.** Amounts are `bigint` minor units; `5.0000001 USDC` is a
  parse error, not a rounded-down 5.00. A float in a limit check is a bypass.
- **Deny by default.** No limit for the asset → cannot spend it. Action kind not
  listed → cannot run it. Recipient outside a strict allow list → cannot pay it.
- **Agent text is not an input to control flow.** The request's free-text `reason`
  is stored for the audit trail and read by nothing else. There is no instruction
  channel for prompt injection to reach.
- **Reservations.** A queued approval books budget immediately, so ten pending
  approvals cannot spend the same daily cap ten times.
- **Replay protection.** An action id is single-use.

### Layer 2 — the contract (on-chain, `contract/`)

The vault holds the funds and the limits. The agent's key is a **function-call key
scoped to `spend`** on that contract, so a stolen agent key cannot add keys, delete
keys, withdraw, pause or call anything else.

- `spend(asset, amount, to, decision_hash)` recomputes per-tx, rolling daily and
  rolling 30-day limits from the contract's own storage, enforces the allow list and
  the pause switch, then transfers.
- `set_policy` / `set_paused` / `set_agent` / `withdraw` are owner-only; `spend` is
  agent-only.
- `check(...)` is a view that shares the exact evaluation code with `spend`, so a
  dry run can never disagree with the real transaction.
- Counters and the decision hash chain are written **before** the transfer promise,
  so a failure cannot leave partial state.
- A refusal reverts the transaction *and* emits a NEP-297 `deny` event with the
  reason code — because NEAR reports panics to callers as an opaque wasm trap.

### Layer 3 — the human (approval queue)

Above `approvals.thresholdUsd` the payment does not fail, it waits.

- Only a configured approver can release it; **the agent approving its own spending
  is refused** (`not_an_approver`).
- Approvals expire (`ttlSeconds`) and release their reservation.
- **The policy is re-evaluated at approval time** against the current policy and the
  current ledger. An approval granted under yesterday's limits cannot be used after
  the owner tightens them: the request is marked `superseded` with the reason. This
  is the TOCTOU case, and it is tested.

### The audit trail

Every decision — including denials — becomes a hash-chained record
(`prevHash → hash`). `verify()` recomputes the chain and reports the exact sequence
number of the first break. The head hash is what a caller anchors on-chain (the
contract keeps its own decision hash chain). Honest limit: dropping the *tail*
leaves a valid prefix, which is why the head is anchored and compared, not just
recomputed.

---

## 5. NEAR-specific pieces: what is real, what is not

| NEAR feature | How Veto uses it | Status |
|---|---|---|
| **NEAR Intents / 1Click** | Real quotes from `https://1click.chaindefuser.com/v0/quote` are validated before a swap: venue, slippage ceiling, quote expiry, origin asset, and a **pinned destination address**. `dry: true` needs no funds, key or signature. | **Live integration.** Fixture captured 2026-10-19 (1 NEAR → 4.917804 USDC on Arbitrum) so the demo also runs offline. |
| **Chain Signatures (MPC)** | The pinned swap destination is not a typed constant: it is the address `v1.signer` derives for `(argo.near, "ethereum-1")` = `0x583ddbf02324f75c3963c45686d52afaf2368c2f`. `npm run chainsig` re-derives it live and compares. | **Live read-only integration** (RPC view call, checked against the MPC signer). Signing is a roadmap item, gated by the same policy. |
| **Function-call access keys** | The agent's only key is a function-call key scoped to `spend` on the contract, with its own allowance. | **Live on testnet** — the agent deletes its full-access key; transaction 4 in [`docs/TESTNET.md`](docs/TESTNET.md). |
| **Named accounts / sub-accounts** | Owner, agent and every allow-listed vendor are named accounts, which keeps the allow list human-auditable. | Used throughout. |
| **NEP-297 events** | `spend`, `deny` and `withdraw` events, indexable. | Implemented and observed on testnet. |
| **NEAR testnet contract** | `contract/` builds a `wasm32-unknown-unknown` contract with 31 unit tests and is deployed and exercised on testnet. | **Live**: deploy, policy install, an allowed spend, a per-tx revert, a **rolling daily-cap revert**, a key-level refusal, a **NEP-141 (wNEAR) spend with a token-limit revert**, and **37/37 conformance checks** against the deployed instance. |

Deliberately **not** used: a token, a DAO, a marketplace. Veto is the thing other
agent projects would put in front of their wallet.

### On-chain evidence (testnet, 2026-10-19)

| Step | Transaction |
|---|---|
| deploy contract | [`9J4khkaMK3eNApQnDTYPTBt547pMBwhGWKzEV3CEqzBC`](https://testnet.nearblocks.io/txns/9J4khkaMK3eNApQnDTYPTBt547pMBwhGWKzEV3CEqzBC) |
| `new(owner, agent)` | [`BbsTWLvG5f59CKMsHgSuHrQrZGHYuoeeSUGvK3RPDniA`](https://testnet.nearblocks.io/txns/BbsTWLvG5f59CKMsHgSuHrQrZGHYuoeeSUGvK3RPDniA) |
| agent adds `spend`-only key | [`FuVdUWzARBcVvqjkRbd6npm4XTY6fX7DNwe5wFk6zpBL`](https://testnet.nearblocks.io/txns/FuVdUWzARBcVvqjkRbd6npm4XTY6fX7DNwe5wFk6zpBL) |
| agent **deletes its full key** | [`9PDkM5sMAbSFPqyK4N4EGFHFGMxvDUkiGhxUG7H2gyhW`](https://testnet.nearblocks.io/txns/9PDkM5sMAbSFPqyK4N4EGFHFGMxvDUkiGhxUG7H2gyhW) |
| owner installs policy | [`J7C1ywvwPB9wGikrYPmWruTfFXERVa7vsVZViniretfp`](https://testnet.nearblocks.io/txns/J7C1ywvwPB9wGikrYPmWruTfFXERVa7vsVZViniretfp) |
| agent spends 0.25 NEAR (allowed) | [`BEahB6BG83QHuExjuL2YHBMwnBPdWeegeYpzGur1pfhx`](https://testnet.nearblocks.io/txns/BEahB6BG83QHuExjuL2YHBMwnBPdWeegeYpzGur1pfhx) |
| agent tries 1.5 NEAR (reverted) | [`JDtQ44eSeoEKBATno3q9JuSmyrtgQSTUi9yRuEss3C4c`](https://testnet.nearblocks.io/txns/JDtQ44eSeoEKBATno3q9JuSmyrtgQSTUi9yRuEss3C4c) |
| fills the 2 NEAR daily cap (4 spends) | [`ERWArc5F9cPZz2akExYA6Ngtz3p6DUBi4Uarj32Yk2e4`](https://testnet.nearblocks.io/txns/ERWArc5F9cPZz2akExYA6Ngtz3p6DUBi4Uarj32Yk2e4) → [`DGGuSiLn8KqEKaSUjA3JX5QjvhaBxfTU4f89Hp9vckXp`](https://testnet.nearblocks.io/txns/DGGuSiLn8KqEKaSUjA3JX5QjvhaBxfTU4f89Hp9vckXp) |
| 0.50 NEAR more → **reverted: `DAILY_LIMIT`** | [`FGa1eUmsadSsdVLKP1mYQtQ5kQFwCQS2RYCiex89L2B1`](https://testnet.nearblocks.io/txns/FGa1eUmsadSsdVLKP1mYQtQ5kQFwCQS2RYCiex89L2B1) |
| agent tries `set_paused` | rejected at validation: `Access key does not allow method set_paused` |

Full transcript, the `deny` event payload and the state read back from the
contract: [`docs/TESTNET.md`](docs/TESTNET.md).

![testnet run](docs/shots/testnet.png)

*The recorded testnet run: deploy, policy install, a 0.25 NEAR spend that moved
funds, a 1.5 NEAR spend reverted by the contract, and a `set_paused` call refused by
the agent's own key.*

![conformance](docs/shots/conformance.png)

*`npm run chain:conformance` — 37 promises checked against the deployed contract,
with each refusal's reason code read from the on-chain `deny` event rather than
trusted from the script.*

---

## 6. The attack catalogue

`src/demo/scenarios.ts` is the single source of truth: the CLI, the dashboard's
attack simulator and the adversarial tests all read the same 29 scenarios. A
scenario cannot be added without a stated expectation, because the tests assert
every row.

| # | Attempt | Wall | Verdict |
|---|---|---|---|
| 1–2 | Overspend one transfer (26 USDC, 1000 NEAR) | per-transaction cap | deny |
| 3–6 | Extra decimals, negative, zero, scientific notation | exact amount parsing | deny |
| 7–8 | Wrong-case / trailing-dot account id | account id validation | deny |
| 9–10 | Empty action id, invented action kind | request shape / allow list | deny |
| 11 | Spend an asset no limit covers | deny-by-default registry | deny |
| 12–14 | Stranger, deny-listed drainer, cyrillic homoglyph | counterparty lists | deny |
| 15 | Agent claims the owner identity | identity binding | deny |
| 16–18 | Add key, delete key, arbitrary contract call | action kind allow list | deny |
| 19–24 | Swap: no quote, 5% slippage, redirected output, unknown venue, expired quote, asset mismatch | quote validation | deny |
| 25 | Payment above the approval line | approval threshold | **require_approval** |
| 26–27 | Legitimate API payment, legitimate swap | — | **allow** |
| 28–29 | Anything, once paused / once expired | owner switch, expiry | deny |

Beyond the catalogue the suite covers stateful attacks: draining the daily cap slice
by slice (stops exactly at the cap), spreading spend over 20 days until the monthly
cap bites, replaying an action id, bursting past the hourly rate limit, stacking
pending approvals, expiring approvals, self-approval, TOCTOU on a policy change,
audit tampering, policy-hash substitution, and a failing executor being recorded as
a denial rather than an allow.

---

## 7. Design decisions worth defending

1. **The evaluator is pure and has no clock of its own.** Time is injected, which is
   how a test can prove a daily window is a day. (It caught a real bug: the daily
   check was reading the monthly window.)
2. **`bigint`, never `float`.** Rounding is not a UX detail in a limit check.
3. **All failures are returned, not just the first.**
4. **Reservations, not just spend totals.** Pending money is still money.
5. **Re-check at execution.** An approval is a request to re-evaluate, not a
   pre-authorised payment.
6. **The policy is data, pinned by hash.** A changed policy cannot load silently;
   the change appears as a `POLICY_UPDATED` record carrying both hashes.
7. **The LLM is not in the trust path.** Rules may only *tighten* (escalate to a
   human); nothing an LLM says can widen a limit. That is the difference between a
   guardrail and decoration.
8. **Honest limits are documented** in [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md):
   we bound consequences, we do not judge intent, price fairness is out of scope, and
   a tail-truncated log needs the anchored head to be caught.
9. **The obvious questions have written answers** in [`docs/FAQ.md`](docs/FAQ.md): why
   not just a function-call key allowance, why not a multisig, why an off-chain engine
   exists at all, what happens if the owner is compromised.

---

## 8. Repository layout

```
src/core/          money, policy DSL, ledger, audit, the pure engine, the stateful guard
src/core/engine.ts one pure function, ~19–20 checks, no I/O
src/core/service.ts approvals, reservations, re-checks, persistence
src/chain/         NEAR Intents (1Click) client, chain signatures (MPC) helper
src/integrations/  GatedToolbox (paid tool calls) + loop.ts (what the agent does after a refusal)
src/demo/          the scenario catalogue shared by CLI, UI and tests
src/cli/           veto demo | attack | quote | chainsig | evaluate | audit
src/app/           dependency-free HTTP server + dashboard (no build step)
examples/          the policy a human writes + three example actions
contract/          Rust policy vault (near-sdk 5.29), owner/agent separation, 31 tests
test/unit/         94 tests: money, YAML, policy, engine, toolbox, chain signatures
test/adversarial/  catalogue assertions, stateful attacks, 1000 random actions
scripts/           testnet accounts/demo, submission validator, terminal-image renderer
docs/              threat model, testnet evidence, demo script, submission checklist
scripts/           testnet runs, benchmarks, the docs audit, image and video rendering
docs/shots/        demo, attack, testnet, preflight and dashboard images rendered from real output
data/fixtures/     one recorded live 1Click quote (offline reproducibility)
```

---

## 9. The contract

```bash
cd contract
./build.ps1                 # builds res/veto_policy.wasm  (307,028 bytes, sha256 1c5f5d30…)
./test.ps1                  # 31 unit tests (needs a host C toolchain, see below)
```

`build.ps1` and `test.ps1` are thin wrappers around `cargo build --release --target
wasm32-unknown-unknown` and `cargo test`, with the toolchain environment set
explicitly. On a machine where PowerShell script execution is disabled, run
`pwsh -ExecutionPolicy Bypass -File .\build.ps1` or call `cargo` directly.

`cargo test` needs a host C toolchain (near-sdk's test harness pulls `aws-lc-sys`,
`blst` and `secp256k1-sys`); `cargo build --target wasm32-unknown-unknown` does not,
and neither does anything else in this repository.

Because the build machine for this submission had no C compiler, the contract is
verified **on the chain instead of in a mock**: `npm run chain:conformance` asserts
37 promises against the deployed instance, including the exact reason code of every
refusal, read from the on-chain `deny` event (§5). That is a stronger check than the
mock harness in one respect — it runs on real storage, in a real VM — and a weaker one
in another: it cannot fake a 30-day clock rollover, which is what the unit tests cover.
The unit suite is committed and runs on any machine with a C toolchain via
`contract/test.ps1`. GitHub Actions runs both suites on every push
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)): the engine on Node 24 with no
dependencies, and the contract against a real NEAR VM, where all 31 tests pass.

Deploy and call examples, exact JSON payloads and the reason-code table are in
[`contract/README.md`](contract/README.md). No script in this repository signs or
spends anything on its own: the testnet demo uses throwaway faucet-funded accounts
and prints every transaction before continuing.

---

## 10. Wiring it into an agent

`src/integrations/toolbox.ts` is a framework-free choke point for "the agent pays for
a tool":

```ts
const toolbox = new GatedToolbox(guard)
  .register({ name: 'summarize', vendor: 'api.data-market.near',
              price: { asset: 'USDC', amount: '4' }, handler: summarize });

const outcome = await toolbox.call('summarize', { text });
// 'ok' | 'refused' (handler never ran) | 'pending_approval' | 'failed'
```

The handler does not run when the policy refuses, and a retried call id cannot pay
twice. Settlement (NEAR transfer, 1Click swap, x402) stays with the host, which is
what keeps the policy testable without a chain.

---

### The agent half: what it does with a refusal

A firewall that only says "no" leaves the agent stuck, and a stuck agent either gives up or
tries to talk its way around the policy. `src/integrations/loop.ts` turns a reason code into
the next legal move, and stops when the wall has nothing to do with price:

```ts
const report = await runTask(toolbox, 'fetch the training dataset', [
  { tool: 'premium_dataset', why: 'what the task asks for' },
  { tool: 'small_dataset',   why: 'a cheaper tier that fits the per-tx cap' },
]);
// { status: 'done' | 'gave_up' | 'blocked_on_human', attempts: [...] }
```

`npm run agent` drives three tasks through it:

![npm run agent](docs/shots/agent.png)

The agent adapts (40 USDC is refused, the 8 USDC tier runs), gives up on a denied recipient
because no cheaper tier fixes that, and waits for the human on a 20 USDC subscription - which
the owner executes at approval time, so there is nothing left for the agent to retry.

## 11. Submission artefacts

- [`docs/shots/veto-demo.mp4`](docs/shots/veto-demo.mp4) — a 58-second narrated walkthrough
  built from the real command output (nine cards: what it is, `demo`, `attack`, testnet,
  conformance, the bug, the agent loop, repo). The voice is the author's; the script is in
  [`docs/NARRATION.md`](docs/NARRATION.md). No screen recording, no editing; every number is
  stdout.
- [`docs/DEMO.md`](docs/DEMO.md) — the video shot list, the screenshot list, and the X
  post text.
- [`docs/SUBMISSION.md`](docs/SUBMISSION.md) — the fields only a human can provide,
  the timeline, and what to double-check before sending.
- `scripts/submit.mjs` — validates every field against the published submission
  contract, prints the exact payload, and sends nothing without `--send` plus a typed
  confirmation.

---

## 12. Security policy

What is in scope, what is deliberately out of scope, what is known to be missing, and how
to report a hole: [`SECURITY.md`](SECURITY.md). The threat model with the reasoning behind
each limit is in [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md).

## 13. Licence

MIT. Built at NEAR HACKATHON, November 2026.

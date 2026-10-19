# Veto

**A spending firewall for AI agent wallets on NEAR.** Agents can spend; they just cannot spend everything.

Built for **NEAR HACKATHON** — tracks `security` and `agents`.

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

## 2. Try it in five minutes

Requirements: **Node.js >= 22.6**. The project uses native TypeScript execution, so
there is no build step and **nothing to install** for steps 1–7 (the only npm
dependency, `near-api-js`, is a devDependency used by the optional testnet scripts
in step 8). Rust is needed only for the contract in `contract/`.

Each step is "do this, see that". Nothing here needs a wallet, a key or funds.

| # | Do this | See that |
|---|---|---|
| 1 | `npm run test:all` | `# pass 84`, `# fail 0` — engine, policy, ledger, audit, approvals, chain signatures, plus the adversarial suite where every verdict is asserted. |
| 2 | `npm run demo` | The numbered narrative above: 12 decisions, one approval flow (including the agent being refused permission to approve its own payment), one real NEAR Intents quote, `audit chain verified`, and a tamper check that *detects* an edited record. |
| 3 | `npm run attack` | A 29-row table ending in `29 attempts: 26 denied, 1 to a human, 2 allowed`. Every row names the wall it hit. Exit code 1 if any row disagrees with its claim. |
| 4 | `npm run quote` | Fetches a **live** quote from `https://1click.chaindefuser.com/v0/quote` (1 NEAR → USDC on Arbitrum), then prints all ~19 policy checks with `pass`/`FAIL`. Add an address to see the same live quote refused: `npm run quote 0xdeadbeef00000000000000000000000000000000`. |
| 5 | `npm run chainsig` | Derives the agent's cross-chain address from NEAR's MPC signer and prints `match: the only address this agent may receive swaps on is the one the MPC derives for it`. |
| 6 | `npm run serve` | Dashboard on <http://127.0.0.1:8787>: policy, live budgets, decision feed with per-check detail, approval queue, 29-scenario attack simulator, audit-chain verifier. |
| 7 | `npm run audit` | `{ "ok": true, "records": …, "head": "…" }` — the audit chain of the last dashboard/CLI process. |
| 8 | `npm run chain:demo` | Deploys the contract to **NEAR testnet** and runs the four calls in §4: agent spends inside the limits (succeeds), agent tries 1.5× the cap (reverted, with a readable `deny` event), agent tries to pause the contract (refused by its key). Needs network and faucet-funded testnet accounts; already-run evidence with explorer links is in [`docs/TESTNET.md`](docs/TESTNET.md). |

Offline? Steps 1–3, 6 and 7 work with no network at all: the 1Click quote is a
recorded fixture (`data/fixtures/quote.json`), and each step says so when the
network is missing.

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

## 3. How enforcement works: three independent layers

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

## 4. NEAR-specific pieces: what is real, what is not

| NEAR feature | How Veto uses it | Status |
|---|---|---|
| **NEAR Intents / 1Click** | Real quotes from `https://1click.chaindefuser.com/v0/quote` are validated before a swap: venue, slippage ceiling, quote expiry, origin asset, and a **pinned destination address**. `dry: true` needs no funds, key or signature. | **Live integration.** Fixture captured 2026-10-19 (1 NEAR → 4.917804 USDC on Arbitrum) so the demo also runs offline. |
| **Chain Signatures (MPC)** | The pinned swap destination is not a typed constant: it is the address `v1.signer` derives for `(argo.near, "ethereum-1")` = `0x583ddbf02324f75c3963c45686d52afaf2368c2f`. `npm run chainsig` re-derives it live and compares. | **Live read-only integration** (RPC view call, checked against the MPC signer). Signing is a roadmap item, gated by the same policy. |
| **Function-call access keys** | The agent's only key is a function-call key scoped to `spend` on the contract, with its own allowance. | **Live on testnet** — the agent deletes its full-access key; transaction 4 in [`docs/TESTNET.md`](docs/TESTNET.md). |
| **Named accounts / sub-accounts** | Owner, agent and every allow-listed vendor are named accounts, which keeps the allow list human-auditable. | Used throughout. |
| **NEP-297 events** | `spend`, `deny` and `withdraw` events, indexable. | Implemented and observed on testnet. |
| **NEAR testnet contract** | `contract/` builds a `wasm32-unknown-unknown` contract with 29 unit tests and is deployed and exercised on testnet. | **Live**: deploy, policy install, a successful spend, a reverted spend, a key-level refusal. |

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
| agent tries `set_paused` | rejected at validation: `Access key does not allow method set_paused` |

Full transcript, the `deny` event payload and the state read back from the
contract: [`docs/TESTNET.md`](docs/TESTNET.md).

---

## 5. The attack catalogue

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

## 6. Design decisions worth defending

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

---

## 7. Repository layout

```
src/core/          money, policy DSL, ledger, audit, the pure engine, the stateful guard
src/core/engine.ts one pure function, ~19–20 checks, no I/O
src/core/service.ts approvals, reservations, re-checks, persistence
src/chain/         NEAR Intents (1Click) client, chain signatures (MPC) helper
src/integrations/  GatedToolbox: drop-in wrapper for paid agent tools
src/demo/          the scenario catalogue shared by CLI, UI and tests
src/cli/           veto demo | attack | quote | chainsig | evaluate | audit
src/app/           dependency-free HTTP server + dashboard (no build step)
examples/          the policy a human writes + three example actions
contract/          Rust policy vault (near-sdk 5.29), owner/agent separation, 29 tests
test/unit/         84 tests: money, YAML, policy, engine, toolbox, chain signatures
test/adversarial/  catalogue assertions + stateful attacks
scripts/           testnet accounts/demo, submission validator
docs/              threat model, testnet evidence, demo script, submission checklist
data/fixtures/     one recorded live 1Click quote (offline reproducibility)
```

---

## 8. The contract

```bash
cd contract
./build.ps1                 # builds res/veto_policy.wasm  (304,345 bytes, sha256 3e577ee4…)
./test.ps1                  # 29 unit tests
```

`build.ps1` and `test.ps1` are thin wrappers around `cargo build --release --target
wasm32-unknown-unknown` and `cargo test`, with the toolchain environment set
explicitly. On a machine where PowerShell script execution is disabled, run
`pwsh -ExecutionPolicy Bypass -File .\build.ps1` or call `cargo` directly.

`cargo test` needs a host C toolchain (near-sdk's test harness pulls `aws-lc-sys`,
`blst` and `secp256k1-sys`); `cargo build --target wasm32-unknown-unknown` does not.
The testnet run in §4 is the end-to-end verification that needs no C compiler.

Deploy and call examples, exact JSON payloads and the reason-code table are in
[`contract/README.md`](contract/README.md). No script in this repository signs or
spends anything on its own: the testnet demo uses throwaway faucet-funded accounts
and prints every transaction before continuing.

---

## 9. Wiring it into an agent

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

## 10. Submission artefacts

- [`docs/DEMO.md`](docs/DEMO.md) — 60-second video shot list, screenshot list, and
  the X post text.
- [`docs/SUBMISSION.md`](docs/SUBMISSION.md) — the fields only a human can provide,
  the timeline, and what to double-check before sending.
- `scripts/submit.mjs` — validates every field against the published submission
  contract, prints the exact payload, and sends nothing without `--send` plus a typed
  confirmation.

---

## 11. Licence

MIT. Built at NEAR HACKATHON, November 2026.

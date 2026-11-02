# AGENTS.md

Orientation for an AI agent (or a reviewer) working in this repository. The
hackathon's own instructions are at <https://nearhackathon.com/HACKATHON.md>; this
file only maps *this* codebase.

## What this is

Veto is a policy firewall for AI agent wallets on NEAR: policy-as-data, judged
before money moves, enforced off-chain by a pure engine and on-chain by a Rust
vault, with a human approval queue and a hash-chained audit trail.

## Verify it in 60 seconds, without installing anything

```bash
npm run test:all     # 89 tests, 0 failures, no network, no node_modules needed
npm run attack       # 29 escape attempts, every verdict asserted
npm run demo         # narrative: allow / deny / approval / live quote / audit
npm run serve        # dashboard on :8787 (also dependency-free)
```

The only npm dependency (`near-api-js`) is a devDependency used by `scripts/`, so
steps above work on a bare checkout.

## Where things are

| Path | What lives there |
|---|---|
| `src/core/engine.ts` | `evaluate(policy, action, ledgerView, ctx) -> Decision`. Pure. The whole safety claim is this function plus its tests. |
| `src/core/policy.ts` | policy schema, strict validation, compilation, hash pinning |
| `src/core/service.ts` | `VetoGuard`: submissions, reservations, approvals, re-checks, persistence |
| `src/core/money.ts` | exact `bigint` money; `parseAmount` refuses silent rounding |
| `src/demo/scenarios.ts` | the 29-scenario catalogue; single source of truth for CLI, dashboard, tests |
| `src/chain/intents.ts` | NEAR Intents (1Click) client; `snapshotFromQuote` maps venue ids to policy ids |
| `src/chain/chainsig.ts` | MPC address derivation (keccak-256 + base58, no deps) |
| `src/app/` | dashboard server + page (no build step) |
| `contract/src/lib.rs` | Rust vault: limits, allow list, pause, decision hash chain, deny events |
| `docs/` | threat model, testnet evidence, demo script, submission checklist |

## Rules that keep the project honest

1. **No floats in money.** Amounts are `bigint` minor units. If you add arithmetic,
   use `src/core/money.ts`.
2. **The engine stays pure.** No I/O, no clock, no network inside `evaluate()`. Time
   and prices are injected.
3. **The LLM is not in the trust path.** Rules may only tighten (escalate to a
   human). Nothing an agent says may widen a limit; the free-text `reason` field is
   for the audit trail only.
4. **One source of truth for attacks.** Add a scenario to `src/demo/scenarios.ts`
   with an expected verdict; the test suite will fail if the engine disagrees.
5. **Don't claim what you didn't run.** `docs/TESTNET.md` lists real transactions;
   update it only from an actual run, and keep hashes rather than prose.
6. **ASCII-only CLI output.** Windows consoles default to cp1251 and turn `…` into
   garbage.

## Common tasks

- New policy rule: add the check in `engine.ts`, a reason code in `REASON`, a
  scenario in `scenarios.ts`, and a unit test in `test/unit/core.test.ts`.
- New dashboard endpoint: `src/app/server.ts` (JSON errors only, `{ error }`).
- Rebuild the contract: `cd contract && ./build.ps1` (`cargo build --release
  --target wasm32-unknown-unknown` + copy to `contract/res/`).
- Rebuild the demo images: see `docs/DEMO.md` §A0.

## Do not

- Commit anything from `data/` except `data/fixtures/` (testnet keys live there).
- Push, publish the repository, post on X or submit the form: those are human
  actions, listed in `docs/SUBMISSION.md`.

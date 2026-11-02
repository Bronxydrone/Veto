# Security policy

Veto is a spending firewall, so the honest thing is to say up front what is protected, what
is not, and where to report a hole.

## What is in scope

- **The contract** (`contract/src/lib.rs`), deployed on NEAR **testnet** only. A reachable
  path that lets an agent key do anything except `spend()` within the installed policy, or
  that lets a spend exceed a limit, is a real vulnerability.
- **The decision engine** (`src/core/engine.ts`) and the guard around it
  (`src/core/service.ts`): a way to get an `allow` that the policy does not permit, to spend
  twice on one action id, or to use an approval that the policy no longer allows.
- **The audit chain** (`src/core/audit.ts`): a way to modify, reorder or delete a record
  without `verifyAudit()` noticing.

## What is not in scope

- **The dashboard and the CLI are demo surfaces.** They run locally, hold no keys and serve
  no production traffic. A denial of service against your own `npm run serve` is not a
  vulnerability.
- **The testnet accounts in `docs/TESTNET.md`** are faucet-funded and their keys are not in
  the repository. They are evidence, not a deployment.
- **No mainnet deployment exists.** If that changes, this file changes first.
- **Missing features** - a limit type that is not implemented, an integration that is not
  written - are not vulnerabilities. They are in [`docs/THREAT-MODEL.md`](THREAT-MODEL.md)
  with the reasoning.

## Known limitations, stated rather than hidden

- The contract has **not** been audited by a third party. The tests and the conformance suite
  are the current evidence, and [`docs/THREAT-MODEL.md`](THREAT-MODEL.md) lists what they do
  not cover.
- The example policy has **one approver**. Multi-approver policies are a policy change, not a
  code change, but the shipped example does not demonstrate them.
- The off-chain engine is not the enforcement point: the contract is. A host that ignores a
  `deny` still cannot move funds past the on-chain limits, but it can lie to its own logs.
  That is why the audit head is anchored on-chain.

## How to report

Open a **private security advisory** on the repository (Security -> Advisories -> "Report a
vulnerability"). Please include a reproducer: the action, the policy, and the verdict you
expected versus the one you got. A failing test case is ideal.

This is a solo hackathon project, so expect a best-effort reply within a few days rather than
an SLA. If the report is valid, the fix and the credit go in the same commit.

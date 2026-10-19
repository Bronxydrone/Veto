# Veto dashboard (`src/app/`)

The web console for **Veto — the spending firewall for AI agents**. It drives the
existing policy engine (`src/core/`) over HTTP and renders what the firewall did:
the pinned policy, a live decision feed, the human-approval queue, spend budgets,
the attack catalogue and the audit chain.

Everything here is dependency-free: `node:http`, `node:fs` and browser-native
JS/CSS. No npm install, no build step, no CDN. Three files:

| File | What it is |
| --- | --- |
| `server.ts` | HTTP server: JSON API over one in-memory `VetoGuard`, plus static files. |
| `ui/index.html` | The whole dashboard: one page, inline CSS, inline vanilla JS. |
| `README.md` | This file. |

## Run

```sh
node src/app/server.ts            # http://127.0.0.1:8787
PORT=9000 node src/app/server.ts  # another port
HOST=0.0.0.0 node src/app/server.ts  # expose on the LAN (demo only)
```

Requires Node ≥ 24 (the server and the engine are `.ts` files executed with type
stripping; no enums, no decorators). No dependencies to install.

The policy is read once at startup from `examples/policy.yaml`; the hash of that
document is the pinned policy hash shown in the header and committed into every
audit record. If `PORT` is busy the process exits with `EADDRINUSE` instead of
quietly moving — a pinned policy behind an unknown port is a bad demo.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/state` | `{ now, policyHash, policy, summary, approvals, approvalsDecided, audit, recent, intentsQuote }` — everything the dashboard renders. `audit` is the verification result (`ok`, `records` count, `head`, `brokenAt?`); `recent` is the newest-first decision feed. |
| `POST` | `/api/actions` | Body is an `ActionRequest`. Runs `guard.submit` and returns `{ decision, approval, execution, policyHash }`. Books a spend, queues an approval, or denies. |
| `POST` | `/api/preview` | Same body; `guard.preview` dry run. Returns `{ decision, approval: null, execution: null, preview: true }`. Nothing is booked and no attempt is recorded, so *Evaluate* is free and repeatable. |
| `POST` | `/api/approvals/:id/approve` | Body `{ approver }`. Returns `{ status, decision, execution }`. The policy is re-checked at approval time (TOCTOU): `status` is `executed`, `recheck_failed`, `expired` or `already_*`. |
| `POST` | `/api/approvals/:id/reject` | Body `{ approver, note? }`. Returns `{ status }` (`rejected`, `already_rejected`, …) and releases the reservation. |
| `POST` | `/api/simulate-attack` | Runs the shared scenario catalogue (`src/demo/scenarios.ts`, `runCatalogue()`) and returns `{ ranAt, count, denied, allowed, mismatches, results: [...] }`. Each result is `{ name, subject, expect, verdict, codes, wall, detail, engine, matchesExpectation }`. |
| `GET` | `/api/audit` | `{ policyHash, verification, count, records }` — every audit record plus the full hash-chain verification. |
| `POST` | `/api/policy/reset` | Reload `examples/policy.yaml` into a fresh guard: empty ledger, empty approvals, empty audit chain. Handy between demo takes. |
| `GET` | `/` | The dashboard page (`src/app/ui/index.html`). |
| `GET` | `/ui/*` | Static files under `src/app/ui/`. Directory traversal is rejected (400/404). |

Every `/api/*` response is JSON. Errors are `{ "error": "..." }` with status 400
(bad input, wrong method), 404 (unknown route or approval id) or 500 (unexpected).
Request bodies are capped at 256 KB.

## What the UI does

- **Header** — wordmark, tagline, the short pinned policy hash (click `copy` for
  the full value) and a live connection dot: green when the last `/api/state` poll
  succeeded, red when the server stopped answering. The page keeps the last state
  on screen instead of blanking out.
- **Policy** — owner, agent, per-tx/daily/monthly limits, allow list, deny list,
  approval threshold and approvers, velocity and intent rules, plus a note that
  the policy hash is what the audit chain commits to.
- **Agent activity** — a form to submit an action (`near.transfer`,
  `ft.transfer`, `intent.swap`, `api.pay`) with *Evaluate* (dry run) and *Send to
  policy* (real submit). Swap mode builds a quote from the recorded 1Click fixture
  and offers a **tamper destination** toggle that rewrites the output address to
  `0xdeadbeef…`; the legitimate destination is read from the policy, never
  hardcoded. Below the form, the decision feed: verdict chip, amount, recipient,
  reason codes, and an expandable list of every individual check with pass/fail
  markers.
- **Approvals** — pending requests with Approve / Reject (as `alice.near`), plus a
  short history of decided ones.
- **Spend budgets** — per asset, spent + reserved against the daily limit, with a
  gauge that turns amber at 75% and red at the cap.
- **Attack simulator** — the shared catalogue, one row per scenario, with the wall
  it hit and the engine's reason codes. Verified run: 29 scenarios → 26 denied,
  2 allowed, 1 escalated to a human, 0 mismatches.
- **Audit chain** — record count, chain head, verification status, *Verify chain*
  and *Reset demo state*.

## Screenshot note

Start the server, open <http://127.0.0.1:8787/>, click **Run attack sequence**,
optionally *Send to policy* once so the feed and the approval queue have content,
then capture at ~1680 px wide by ~1500 px tall. The layout is a three-column grid
that collapses to one column under 1180 px, so capture wide. Nothing moves except
the connection dot's pulse, so a still screenshot needs no special timing.

## Design notes and tradeoffs

- **One guard, in memory.** A singleton `VetoGuard` means one ledger, one audit
  chain, one pinned policy — which is what makes the demo legible. State is lost
  on restart; `POST /api/policy/reset` gives the same clean slate without stopping
  the process.
- **The attack simulator is shared code, not a copy.** `/api/simulate-attack` calls
  `runCatalogue()` from `src/demo/scenarios.ts`, the same catalogue the adversarial
  test suite and the CLI demo use. One source of truth means the dashboard cannot
  quietly drift from what the tests assert. The server only shapes the results for
  the table and derives a one-line `subject` from each scenario's action.
- **The simulator cannot touch the demo.** Each scenario runs on its own fresh
  throwaway guard (the catalogue's `LAB` policy: the shipped walls with the two
  advisory risk escalations off, plus the paused/expired variants), so the live
  ledger, approvals and audit chain are untouched. Consequence worth knowing: the
  catalogue's swap scenarios carry quote metadata (venue, slippage, destination,
  expiry) but not the 1Click `amountOut`, so the attack rows show policy facts
  rather than quote amounts. The live quote is still used by the swap form and the
  footer.
- **Replay protection is in the engine and the API, not the catalogue.** The
  shared catalogue exercises limits, allow/deny lists, action kinds, slippage,
  destination pinning, amount parsing, venue, quote freshness, identity, pause and
  expiry; id replay is covered by the adversarial test suite and by `POST
  /api/actions` itself, which denies a reused action id.
- **Decisions carry `to` / `destinationAddress` in the API only.** The engine's
  `Decision` has no counterparty field, but the feed needs one, so the server
  attaches those two fields to each decision it returns and remembers. The engine
  never reads them back.
- **Polling, not WebSockets.** `/api/state` is polled every 4 s (plus on window
  focus). It keeps the server to `node:http` and the page to `fetch`, and 4 s is
  fast enough for a human demo. Merging is by `decisionId`, so a poll never
  duplicates or reorders cards the page already has.
- **Everything the server sends is HTML-escaped** before it reaches `innerHTML`,
  the page ships a restrictive CSP meta tag (self only, no external anything), and
  free text an agent controls (`to`, `reason`) is only ever displayed.
- **`Intl.NumberFormat` is pinned to `en-US`.** The dashboard shows crypto-style
  decimals (`4.917804`, `$10.00`) on any machine instead of switching to comma
  decimals on a non-English host.
- **Preview is not a replay.** `/api/preview` records no attempt, so the same
  action can be evaluated repeatedly and then submitted for real with the same id.

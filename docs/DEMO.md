# Demo script

Everything below is reproducible with no wallet, no key and no funds.

## A. 60-second video (shot list)

Record at 1440×900, terminal at 16pt, dark background. The point of the video is
that **money does not move when the policy says no** — show refusals before showing
features.

| Time | Shot | Say |
|---|---|---|
| 0:00 | `npm run demo` output, up to line 5 | "This is an AI agent with a wallet on NEAR. This is the policy its owner gave it: 1.5 NEAR or 25 USDC per transaction, 5 and 100 per day, three allowed vendors, anything above ten dollars needs a human." |
| 0:10 | Lines 1–5 scroll: ALLOW / NEEDS APPROVAL / DENY | "It pays its compute bill. It asks before spending twelve dollars. It cannot send twenty-six, cannot pay a stranger, and cannot add an access key — three different walls, three reasons." |
| 0:25 | Lines 6–7: live quote, then redirected quote | "This is a real quote from NEAR Intents, one NEAR to USDC on Arbitrum. The policy checks venue, slippage, expiry and destination — and when the same quote is pointed at another address, it is refused. The pinned address is the agent's own chain-signature address, derived by the MPC — `npm run chainsig` re-derives it live." |
| 0:40 | Line 8 + approval lines | "Twenty dollars needs a human. The agent tries to approve its own request and is refused. The owner approves, and the decision is re-checked against the current policy before a cent moves." |
| 0:50 | `audit chain … verified` + tamper line | "Every decision, including every refusal, is hash-chained. Edit one record by hand and verification points at it. The contract anchors the chain head on-chain." |
| 0:58 | Dashboard, attack simulator | "Same engine behind a dashboard: one click runs twenty-nine escape attempts." |

If a video is inconvenient, **screenshots are enough** for the submission.

## B. Screenshots to take

1. `npm run demo` terminal output (full, readable).
2. `npm run attack` table (29 rows, 26 denied).
3. Dashboard — policy panel + budgets + one DENY card expanded to show per-check
   detail (this is the money shot: "which wall, and why").
4. Dashboard — approval queue with a pending payment and the Approve button.
5. `npm run quote` with a live quote passing, and the same command with
   `0xdeadbeef…` refused.
6. `npm run chainsig` — `match:` line.
7. `cargo test` in `contract/` — the on-chain limit tests passing.

## C. Post for X

Keep it plain. No thread, no hashtag soup. Attach 3–4 images or the 60s video.

> We built **Veto** at NEAR HACKATHON — a spending firewall for AI agents on NEAR.
>
> Agents get a wallet and either a key (one prompt injection drains everything) or a
> human on every payment (not an agent any more). Veto is the third option: the owner
> writes a policy — per-tx, daily and monthly caps, allow lists, approval thresholds,
> slippage and destination pins — the policy is pinned by hash, and it is enforced
> on-chain by a Rust contract the agent's key cannot rewrite.
>
> Every action is judged before money moves, and every decision — including the
> refusals — goes into a hash-chained audit log whose head is anchored on-chain.
> 29 escape attempts are tested and refused: 26 denied, 1 escalated to a human,
> 2 legitimate payments allowed.
>
> Real NEAR Intents quotes are validated before a swap (venue, slippage, expiry,
> pinned destination). The pinned address is the agent's own MPC-derived
> chain-signature address, re-derived live from v1.signer.
>
> No wallet needed to try it: `npm run demo`, `npm run attack`, `npm run serve`.
> Repo: <link>

Second, shorter variant:

> AI agents with wallets need a firewall, not a prayer. We built **Veto** at NEAR
> HACKATHON: policy-as-data for agent spending, enforced on-chain, re-checked at
> approval time, with a hash-chained audit trail. 29 escape attempts tested, 26
> refused. Live NEAR Intents quotes validated. Demo and repo in the reply.

## D. One-liner for the submission form

> Veto is a spending firewall for AI agent wallets on NEAR: the owner writes a
> policy (per-transaction, daily and monthly caps, counterparty allow/deny lists,
> approval thresholds, velocity limits, swap venue/slippage/destination pins), the
> policy is pinned by hash, and every agent action is judged by a pure engine before
> money moves. Enforcement is layered: an off-chain decision engine with exact
> bigint arithmetic, an on-chain Rust vault whose agent key can only call `spend` and
> which recomputes the limits itself, and a human approval queue that re-evaluates the
> policy at execution time. Every decision, including refusals, lands in a
> hash-chained audit log anchored on-chain. Veto validates real NEAR Intents (1Click)
> quotes before a swap — venue, slippage, expiry, and a destination pinned to the
> agent's own MPC-derived chain-signature address. 79 tests including 29 adversarial
> escape attempts run with no wallet, no keys and no funds. Built at NEAR HACKATHON.

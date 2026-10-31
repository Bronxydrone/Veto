# Demo script

Everything below is reproducible with no wallet, no key and no funds.

## A0. Ready-made assets (no camera, no browser needed)

A **39-second video** and four images are committed and can be attached to the X post
as they are:

| File | What it shows |
|---|---|
| [`shots/preflight.png`](shots/preflight.png) | `npm run preflight`: 16/16 green - the repository is shippable right now |
| [`shots/mvp.png`](shots/mvp.png) | `npm run mvp`: the whole product on one screen - five decisions and a verified audit chain |
| [`shots/veto-demo.mp4`](shots/veto-demo.mp4) | 39s, 1600×1000, seven cards: what it is → `demo` → `attack` → testnet → conformance → repo |
| [`shots/demo.png`](shots/demo.png) | `npm run demo`: allowed payment, approval, three refusals, live 1Click quote, redirected quote refused, human approval, audit verified, tamper detected |
| [`shots/attack.png`](shots/attack.png) | `npm run attack`: all 29 escape attempts with the wall each one hit |
| [`shots/testnet.png`](shots/testnet.png) | the recorded testnet run: deploy, policy install, one allowed spend, one reverted overspend, one key-level refusal, on-chain state |
| [`shots/conformance.png`](shots/conformance.png) | 28/28 conformance checks against the deployed contract, with the deny reason read from the on-chain event |

They are **not** retouched screenshots: they are images of the real stdout,
rendered by [`scripts/render_terminal.py`](../scripts/render_terminal.py), which
only strips ANSI codes and colours known tokens. Re-render after any change:

```bash
node src/cli/veto.ts demo   > docs/artifacts/demo.txt 2>&1
node src/cli/veto.ts attack > docs/artifacts/attack.txt 2>&1
node scripts/show-testnet-run.ts --compact > docs/artifacts/testnet-compact.txt
node scripts/testnet-conformance.ts --compact > docs/artifacts/conformance.txt
python scripts/render_terminal.py docs/artifacts/demo.txt    docs/shots/demo.png    "npm run demo"
python scripts/render_terminal.py docs/artifacts/attack.txt  docs/shots/attack.png  "npm run attack"
python scripts/render_terminal.py docs/artifacts/testnet-compact.txt docs/shots/testnet.png "node scripts/testnet-demo.ts"
python scripts/render_terminal.py docs/artifacts/conformance.txt docs/shots/conformance.png "node scripts/testnet-conformance.ts"
```

The video is rebuilt from those images by
[`scripts/make-demo-video.ps1`](../scripts/make-demo-video.ps1) (needs ffmpeg; it is
not a project dependency):

```powershell
$env:FFMPEG = "C:\path\to\ffmpeg.exe"
pwsh -ExecutionPolicy Bypass -File .\scripts\make-demo-video.ps1
```

The dashboard still needs a real browser: that is the only screenshot a human has
to take (section B, items 3 and 4).

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

If you attach the three images from A0, only items 3 and 4 are still missing (they
need a browser):

1. `npm run demo` terminal output (full, readable) — *already rendered: `shots/demo.png`*.
2. `npm run attack` table (29 rows, 26 denied) — *already rendered: `shots/attack.png`*.
3. Dashboard — policy panel + budgets + one DENY card expanded to show per-check
   detail (this is the money shot: "which wall, and why").
4. Dashboard — approval queue with a pending payment and the Approve button.
5. `npm run quote` with a live quote passing, and the same command with
   `0xdeadbeef…` refused.
6. `npm run chainsig` — `match:` line.
7. `cargo test` in `contract/` — the on-chain limit tests passing.

## C. Post for X

Keep it plain. No thread, no hashtag soup. Attach the 39-second
[`shots/veto-demo.mp4`](shots/veto-demo.mp4) — or, if video upload is a hassle, attach
three of the images from A0 (`demo.png`, `attack.png`, `conformance.png`).

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
> Repo: https://github.com/Bronxydrone/veto

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

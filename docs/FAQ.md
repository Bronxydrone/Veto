# FAQ (the questions a judge should ask)

Short, direct answers. Where the honest answer is "we do not solve that", it says so.

### Why not just use a function-call key with an allowance?

Because an allowance is one number. It cannot express "1.5 NEAR per transaction,
5 NEAR per day, only to these three vendors, and above $10 ask me first". It also
cannot tell you afterwards *why* something was refused, and it does not survive a
policy change: the only way to tighten it is to rotate the key.

Veto uses the function-call key as **one of four layers**, not as the solution. The
allowance is the crude ceiling; the contract enforces the shape of the spending; the
engine explains decisions; the approval queue inserts a human where the owner asked
for one.

### Why not a multisig?

A multisig makes *every* payment need a quorum, which is exactly the "human in front
of every action" failure mode. Veto is for the 99% of payments that should not need a
human, with a threshold that pulls one in for the rest.

They compose: put a Sputnik DAO or a Trezu multisig in the `owner` role and the
recovery path (`withdraw`, `set_policy`, `set_agent`, `set_paused`) becomes a team
decision while the agent keeps spending inside its walls.

### If the contract enforces everything, why is there an off-chain engine?

Three reasons, none of them "trust me":

1. **USD thresholds need a price.** A contract cannot fetch CoinGecko. The engine
   turns "above $10 ask a human" into a decision; the contract enforces the amount
   limits it can see. When a price is missing, the engine **fails closed** instead of
   guessing.
2. **Explainability.** The engine returns every failed check with the numbers
   (`19–20 checks per decision`), which is what an agent needs to retry sensibly and
   what the owner needs to fix a policy.
3. **Simulation.** `npm run demo` and the dashboard run the exact same evaluation
   without a chain, so a policy can be tested before a wei moves.

The engine is advisory. The contract is the authority, and it recomputes the limits
from its own storage — a compromised off-chain process can make the agent *ask*, not
make the chain *allow*.

### What happens if the agent's key leaks?

The thief gets exactly the policy. Concretely: only `spend`, only to allow-listed
accounts, only within per-tx / daily / 30-day limits, only while the owner has not
paused, and every attempt is visible with a reason code on-chain. The key cannot add
keys, delete keys, withdraw, or change the policy — those calls do not exist for it.
The owner's response is `set_paused(true)` and `set_agent(new_key)`.

Testnet transaction [`9PDkM5sMAbSFPqyK4N4EGFHFGMxvDUkiGhxUG7H2gyhW`](https://testnet.nearblocks.io/txns/9PDkM5sMAbSFPqyK4N4EGFHFGMxvDUkiGhxUG7H2gyhW)
is the agent deleting its own full-access key, leaving only the scoped one.

### What if the owner is compromised?

Out of scope, and worth saying out loud: the owner is the root of trust. If the
owner's key is stolen, the attacker can `withdraw` everything — by design, because
the owner must always be able to recover funds. Mitigations that are *not* built:

- make `owner` a multisig or a DAO (composes today, zero code change);
- two-key owner (a hot key for daily policy edits, a cold key for withdraw) —
  a natural next step.

### Doesn't the "approve above $10" threshold just move the problem?

Partly, and the limits are the answer. Splitting a payment into amounts below the
threshold is allowed, and the daily cap is what bounds it — that is tested
(`splitting below the approval line is bounded by the daily cap`). The threshold is a
checkpoint, not a wall; the walls are the caps and the allow list.

### What if the vault runs out of NEAR?

`spend` and `check` both compute the balance available after the account's storage stake
and answer `deny:INSUFFICIENT_BALANCE` before anything is written. This is a fix, not a
theory: the first contract version wrote the counters, advanced the hash chain and emitted
a `spend` event, and only then did the transfer receipt fail with `LackBalanceForState` -
budget burned, funds not delivered. Testnet found it (see `TESTNET.md`), the contract now
refuses up front.

### Why is "monthly" a rolling 30 days instead of a calendar month?

A calendar month needs timezone and calendar logic on-chain, which is a bug surface
for no benefit. A rolling 30-day window is deterministic: `now >= start + 30 days`
resets it. The off-chain engine uses UTC calendar days/months; the difference is
documented rather than hidden, and both refuse the same things within a few percent.

### Is an LLM in the loop?

No, deliberately. Rules may only *tighten* (a risk heuristic can escalate a payment to
a human). Nothing an LLM says can widen a limit, because that is how guardrails become
decoration. The agent's free-text justification is stored for the audit trail and read
by no control flow — which is also why prompt injection has no channel to attack.

### How does this relate to x402 / TEEs / NEAR AI Cloud?

- **x402** is a payment *rail* for HTTP. Veto decides whether a payment may happen.
  `GatedToolbox` is the seam: the handler does not run when the policy refuses. Emitting
  x402 headers from that wrapper is a small next step, not a redesign.
- **TEE attestation** proves *which code* ran. Veto bounds *what money does*. They are
  orthogonal and compose: an attested agent is still an agent that can overspend.
- **NEAR AI Cloud** is where a private agent would run; Veto is what its wallet wears.

### Why NEAR Intents rather than a swap aggregator on one chain?

Because the point is cross-chain money: an agent earning on NEAR and paying for compute
on Arbitrum should not need a bridge UI. Intents give a quote, our policy validates it,
and chain signatures give the agent an address it controls on the destination chain —
which is exactly the address the policy pins.

### What is genuinely novel here?

Not "spending limits" — those exist. The combination is what is missing in agent
tooling: (a) policy as hash-pinned data rather than code, (b) enforcement inside a
contract the agent key cannot rewrite, (c) approvals that are re-evaluated at execution
time instead of pre-authorised, (d) refusals that are machine-readable both off-chain
and on-chain, and (e) a destination address derived from the MPC signer rather than
typed in by a human. Each of those is a paragraph above; together they are the product.

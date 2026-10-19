/**
 * The scripted attack sequence behind `POST /api/simulate-attack`.
 *
 * This is the product claim in executable form: every escape route an agent (or
 * whoever holds the agent key) could take is enumerated and refused in front of
 * the viewer. The script runs against its own fresh `VetoGuard`, so the live
 * dashboard state, ledger and audit chain are never touched.
 *
 * Numbers come from the recorded 1Click quote in `data/fixtures/quote.json`
 * (1 NEAR -> 4.914535 USDC), so the swap rows show the same amounts a real
 * session would.
 *
 * One deliberate adjustment: the sandbox guard runs the shipped policy with
 * `risk.escalateOnNewCounterparty` turned off. That heuristic escalates *every*
 * first payment to a new payee, which would turn the legitimate-payment row into
 * another approval request and hide the allow path. Every hard wall (per-tx cap,
 * allow/deny list, action kinds, slippage, destination pinning, decimals, replay)
 * is exactly the shipped policy.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadPolicy, type PolicyDoc } from '../core/policy.ts';
import { VetoGuard } from '../core/service.ts';
import type { ActionRequest, QuoteSnapshot } from '../core/engine.ts';
import type { Verdict } from '../core/audit.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const FIXTURE_PATH = join(ROOT, 'data', 'fixtures', 'quote.json');

/**
 * Swap destination pinned in the policy (`intents.allowedDestinations[0]`). It is
 * read from the policy text, never hardcoded, so the catalogue follows the walls
 * instead of an old copy of them.
 */
const FALLBACK_DESTINATION = '0x9a1f4b0c2d7e8f6a3b5c1d9e0f2a4b6c8d0e1f3a';
/** Nowhere. */
const ATTACKER_DESTINATION = '0xdeadbeef00000000000000000000000000000000';
const AGENT = 'argo.near';

export interface IntentsQuote {
  /** Where the numbers came from: the recorded fixture, or the built-in fallback. */
  source: string;
  capturedAt: string | null;
  destinationAsset: string;
  amountIn: string;
  amountOut: string;
  amountOutFormatted: string;
  minAmountOut: string;
  amountOutUsd: string | null;
  slippageToleranceBps: number;
}

interface QuoteFile {
  capturedAt?: string;
  source?: string;
  request?: { destinationAsset?: string; amount?: string; slippageTolerance?: number };
  response?: {
    quote?: {
      amountIn?: string;
      amountOut?: string;
      amountOutFormatted?: string;
      minAmountOut?: string;
      amountOutUsd?: string;
    };
    quoteRequest?: { slippageTolerance?: number; destinationAsset?: string };
  };
}

/**
 * Read the recorded 1Click quote. The dashboard must still boot if the fixture
 * was removed, so a wrong/missing file falls back to the numbers captured with
 * the project (and says so).
 */
export function loadIntentsQuote(): IntentsQuote {
  const fallback: IntentsQuote = {
    source: 'fallback (data/fixtures/quote.json is missing or unreadable)',
    capturedAt: null,
    destinationAsset: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
    amountIn: '1000000000000000000000000',
    amountOut: '4914535',
    amountOutFormatted: '4.914535',
    minAmountOut: '4889962',
    amountOutUsd: '4.913896110450',
    slippageToleranceBps: 50,
  };
  try {
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as QuoteFile;
    const quote = raw.response?.quote ?? {};
    if (!quote.amountOut || !quote.amountOutFormatted || !quote.amountIn) return fallback;
    return {
      source: raw.source ?? '1Click quote fixture',
      capturedAt: raw.capturedAt ?? null,
      destinationAsset: raw.request?.destinationAsset ?? fallback.destinationAsset,
      amountIn: quote.amountIn,
      amountOut: quote.amountOut,
      amountOutFormatted: quote.amountOutFormatted,
      minAmountOut: quote.minAmountOut ?? fallback.minAmountOut,
      amountOutUsd: quote.amountOutUsd ?? null,
      slippageToleranceBps:
        raw.request?.slippageTolerance ?? raw.response?.quoteRequest?.slippageTolerance ?? 50,
    };
  } catch {
    return fallback;
  }
}

export interface AttackEntry {
  /** Human-readable name of the attack. */
  name: string;
  /** What the agent asked for, in one line ("26 USDC -> compute.near"). */
  subject: string;
  /** What the policy is supposed to do with it. */
  expect: 'deny' | 'allow';
  verdict: Verdict;
  codes: string[];
  /** The wall that stopped it (or "no wall" for the legitimate payment). */
  wall: string;
  /** Why that wall applies, in plain language. */
  detail: string;
  /** The engine's own message for the decisive check. */
  engine: string;
  /** True when the engine did what the catalogue says it should. */
  matchesExpectation: boolean;
}

export interface AttackRun {
  ranAt: string;
  policyNote: string;
  count: number;
  denied: number;
  allowed: number;
  mismatches: number;
  results: AttackEntry[];
}

interface AttackCase {
  name: string;
  subject: string;
  expect: 'deny' | 'allow';
  wall: string;
  detail: string;
  /** One submit, or more when the attack needs a history (replay). */
  steps: ActionRequest[];
}

const PRICES = { NEAR: 2_450_000n, USDC: 1_000_000n, USDT: 1_000_000n };

function swapQuote(quote: IntentsQuote, destination: string, slippageBps: number): QuoteSnapshot {
  // 5% of the recorded 4.914535 USDC output, the minimum-out a 500 bps quote would carry.
  const minAmountOut = slippageBps === 500 ? '4668808' : quote.minAmountOut;
  return {
    venue: 'near-intents',
    originAsset: 'NEAR',
    destinationAsset: quote.destinationAsset,
    amountIn: quote.amountIn,
    amountOut: quote.amountOut,
    minAmountOut,
    slippageBps,
    destinationAddress: destination,
    // Far enough in the future that the sandbox clock never runs past it.
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  };
}

function payment(id: string, asset: string, amount: string, to: string | undefined): ActionRequest {
  const action: ActionRequest = { id, kind: 'ft.transfer', actor: AGENT, asset, amount };
  if (to !== undefined) action.to = to;
  return action;
}

function buildCases(quote: IntentsQuote, pinnedDestination: string): AttackCase[] {
  return [
    {
      name: 'Overspend the per-transaction cap',
      subject: '26 USDC -> compute.near',
      expect: 'deny',
      wall: 'Per-transaction cap',
      detail: 'One transfer of 26 USDC against a 25 USDC per-tx limit. The cap is checked on exact base units, before any rounding.',
      steps: [payment('atk_per_tx', 'USDC', '26', 'compute.near')],
    },
    {
      name: 'Pay an address outside the allow list',
      subject: '5 USDC -> attacker.near',
      expect: 'deny',
      wall: 'Counterparty allow list',
      detail: 'The policy is in strict mode, so only api.data-market.near, compute.near and storage.near can receive funds.',
      steps: [payment('atk_not_allowed', 'USDC', '5', 'attacker.near')],
    },
    {
      name: 'Pay the deny-listed drainer.near',
      subject: '5 USDC -> drainer.near',
      expect: 'deny',
      wall: 'Counterparty deny list',
      detail: 'drainer.near is named in the policy deny list, so no limit, quote or approval can make the payment go through.',
      steps: [payment('atk_drainer', 'USDC', '5', 'drainer.near')],
    },
    {
      name: 'Replay an action id that already spent',
      subject: '5 USDC -> api.data-market.near (same id twice)',
      expect: 'deny',
      wall: 'Single-use action id',
      detail: 'The first submit is allowed and books 5 USDC. Sending the identical id again is a denial, not a second spend: retries cannot be used to drain a budget.',
      steps: [
        payment('atk_replay', 'USDC', '5', 'api.data-market.near'),
        payment('atk_replay', 'USDC', '5', 'api.data-market.near'),
      ],
    },
    {
      name: 'Add a key to the owner account',
      subject: 'key.add, 0.01 NEAR',
      expect: 'deny',
      wall: 'Action-kind allow list',
      detail: 'key.add is not one of the four permitted kinds (near.transfer, ft.transfer, intent.swap, api.pay). An agent that can add a key can bypass every limit, so the kind is refused outright.',
      steps: [{ id: 'atk_key_add', kind: 'key.add', actor: AGENT, asset: 'NEAR', amount: '0.01' }],
    },
    {
      name: 'Swap with 5% slippage',
      subject: `1 NEAR -> ${quote.amountOutFormatted} USDC, 500 bps slippage`,
      expect: 'deny',
      wall: 'Slippage ceiling',
      detail: 'The 1Click quote is re-priced at 500 bps of slippage; the policy ceiling is 100 bps. A wide tolerance is how a sandwiched swap pays the attacker.',
      steps: [
        {
          id: 'atk_slippage',
          kind: 'intent.swap',
          actor: AGENT,
          asset: 'NEAR',
          amount: '1',
          venue: 'near-intents',
          slippageBps: 500,
          quote: swapQuote(quote, pinnedDestination, 500),
        },
      ],
    },
    {
      name: 'Redirect the swap output to an attacker address',
      subject: `1 NEAR -> ${quote.amountOutFormatted} USDC, output to 0xdeadbeef…`,
      expect: 'deny',
      wall: 'Pinned swap destination',
      detail: 'The quote is valid and cheap, but the recipient field points at 0xdeadbeef…, not the address pinned in the policy. A swapped-in quote cannot silently redirect funds.',
      steps: [
        {
          id: 'atk_swap_dest',
          kind: 'intent.swap',
          actor: AGENT,
          asset: 'NEAR',
          amount: '1',
          venue: 'near-intents',
          slippageBps: 50,
          destinationAddress: ATTACKER_DESTINATION,
          quote: swapQuote(quote, ATTACKER_DESTINATION, 50),
        },
      ],
    },
    {
      name: 'Submit an amount with too many decimals',
      subject: '5.0000001 USDC -> compute.near',
      expect: 'deny',
      wall: 'Exact amount parsing',
      detail: 'USDC has 6 decimals; 5.0000001 has 7. Veto refuses to round, because an engine that truncates is an engine whose limits can be stepped over.',
      steps: [payment('atk_decimals', 'USDC', '5.0000001', 'compute.near')],
    },
    {
      name: 'Impersonate the owner',
      subject: '5 USDC -> compute.near, actor alice.near',
      expect: 'deny',
      wall: 'Agent identity pin',
      detail: 'The actor must be the policy agent argo.near. Claiming to be the owner is a denial, and the free-text reason field is never read for control flow.',
      steps: [{ id: 'atk_actor', kind: 'ft.transfer', actor: 'alice.near', asset: 'USDC', amount: '5', to: 'compute.near' }],
    },
    {
      name: 'Call an action kind the policy never heard of',
      subject: 'bridge.teleport, 5 USDC',
      expect: 'deny',
      wall: 'Action-kind allow list',
      detail: 'Unknown kinds fail structural validation. There is no fallback path where an unclassified action is assumed harmless.',
      steps: [{ id: 'atk_unknown_kind', kind: 'bridge.teleport' as never, actor: AGENT, asset: 'USDC', amount: '5', to: 'compute.near' }],
    },
    {
      name: 'Swap without a quote to check',
      subject: '1 NEAR -> ? (no quote attached)',
      expect: 'deny',
      wall: 'Quote required',
      detail: 'Without a quote there is no venue, slippage, destination or expiry to verify, so the swap is refused instead of trusted.',
      steps: [{ id: 'atk_no_quote', kind: 'intent.swap', actor: AGENT, asset: 'NEAR', amount: '1' }],
    },
    {
      name: 'Pay a look-alike account id',
      subject: '5 USDC -> Compute.NEAR',
      expect: 'deny',
      wall: 'Account-id validation',
      detail: 'NEAR account ids are lowercase. An uppercase look-alike is rejected at validation instead of being folded into the real payee.',
      steps: [payment('atk_lookalike', 'USDC', '5', 'Compute.NEAR')],
    },
    {
      name: 'A legitimate payment inside the walls',
      subject: `4.914535 USDC -> compute.near`,
      expect: 'allow',
      wall: 'No wall - inside every limit',
      detail: 'Allow-listed payee, 4.91 USDC against the 25 USDC per-tx and 100 USDC daily caps, and below the $10 human-approval line. The agents that behave get to spend.',
      steps: [payment('atk_legit', 'USDC', quote.amountOutFormatted, 'compute.near')],
    },
  ];
}

/**
 * Run the whole catalogue against a throwaway guard and report one entry per
 * attack, in the order a viewer would expect to read it.
 */
export async function runAttackScript(options: {
  policyText: string;
  quote?: IntentsQuote;
}): Promise<AttackRun> {
  const quote = options.quote ?? loadIntentsQuote();
  const doc: PolicyDoc = loadPolicy(options.policyText).doc;
  const pinnedDestination = doc.intents?.allowedDestinations?.[0] ?? FALLBACK_DESTINATION;
  const cases = buildCases(quote, pinnedDestination);

  // Same walls as the shipped policy, minus the "escalate every first contact"
  // heuristic, so the legitimate-payment row can show the allow path.
  doc.risk = { ...(doc.risk ?? {}), escalateOnNewCounterparty: false };

  let clock = Date.now();
  const guard = VetoGuard.create({
    policyText: JSON.stringify(doc),
    clock: () => clock,
    prices: PRICES,
  });

  const results: AttackEntry[] = [];
  for (const attackCase of cases) {
    let last: Awaited<ReturnType<typeof guard.submit>> | null = null;
    for (const step of attackCase.steps) {
      // Every wall the policy has (min interval between transfers) must not turn
      // one catalogue row into an accidental rate-limit demo.
      clock += 10_000;
      last = await guard.submit(step);
    }
    if (last === null) continue;
    const decision = last.decision;
    const codes = decision.reasons.map((reason) => reason.code);
    const denyReason = decision.reasons.find((reason) => reason.severity === 'deny');
    results.push({
      name: attackCase.name,
      subject: attackCase.subject,
      expect: attackCase.expect,
      verdict: decision.verdict,
      codes,
      wall: attackCase.wall,
      detail: attackCase.detail,
      engine: denyReason?.message ?? decision.reasons[0]?.message ?? 'every check passed',
      matchesExpectation: decision.verdict === attackCase.expect,
    });
  }

  const denied = results.filter((entry) => entry.verdict === 'deny').length;
  const allowed = results.filter((entry) => entry.verdict === 'allow').length;
  return {
    ranAt: new Date().toISOString(),
    policyNote:
      'Fresh in-memory VetoGuard on the shipped policy, with risk.escalateOnNewCounterparty disabled so the legitimate-payment row can show the allow path. Every hard wall is unchanged. Live state, ledger and audit chain are untouched.',
    count: results.length,
    denied,
    allowed,
    mismatches: results.filter((entry) => !entry.matchesExpectation).length,
    results,
  };
}

/**
 * The shared scenario catalogue.
 *
 * One source of truth for "attempts an agent could make and the wall it hits",
 * used by three consumers:
 *  - the adversarial test suite (asserts every verdict),
 *  - the CLI demo (renders the table),
 *  - the dashboard's attack simulator.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPolicy, type PolicyDoc } from '../core/policy.ts';
import { VetoGuard } from '../core/service.ts';
import type { ActionRequest } from '../core/engine.ts';

export const START = Date.parse('2026-11-02T12:00:00Z');
export const PRICES = { NEAR: 2_450_000n, USDC: 1_000_000n, USDT: 1_000_000n };

const policyPath = join(import.meta.dirname, '..', '..', 'examples', 'policy.yaml');
const baseDoc = loadPolicy(readFileSync(policyPath, 'utf8')).doc;

export function policyText(mutate: (doc: PolicyDoc) => void = () => {}): string {
  const doc = structuredClone(baseDoc);
  mutate(doc);
  return JSON.stringify(doc);
}

/** Same walls as the shipped example, minus the two advisory risk escalations. */
export const LAB = policyText((doc) => {
  doc.risk = {};
});

/** Room for larger single transfers, so approval flows can be exercised. */
export const HIGH_TX = policyText((doc) => {
  doc.risk = {};
  doc.velocity = {};
  doc.limits.perTx = { ...doc.limits.perTx, USDC: 100 };
});

export const PAUSED = policyText((doc) => {
  doc.risk = {};
  doc.paused = true;
});

export const EXPIRED = policyText((doc) => {
  doc.risk = {};
  doc.expiresAt = '2026-11-01T00:00:00Z';
});

/** The MPC-derived address of argo.near on path "ethereum-1", pinned in the policy. */
export const PINNED_DESTINATION = '0x583ddbf02324f75c3963c45686d52afaf2368c2f';
export const ATTACKER_DESTINATION = '0xdeadbeef00000000000000000000000000000000';

export type Expect = 'allow' | 'deny' | 'require_approval';

export interface Scenario {
  name: string;
  /** The wall this attempt is supposed to hit, in words. */
  wall: string;
  action: Partial<ActionRequest>;
  expect: Expect;
  code?: string;
  policy?: string;
}

const policyNames: Record<string, string> = { lab: LAB, highTx: HIGH_TX, paused: PAUSED, expired: EXPIRED };

export const CATALOGUE: Scenario[] = [
  {
    name: 'Overspend one transfer',
    wall: 'per-transaction cap',
    expect: 'deny',
    code: 'PER_TX_LIMIT',
    action: { kind: 'ft.transfer', asset: 'USDC', amount: '26', to: 'compute.near' },
  },
  {
    name: 'Overspend by three orders of magnitude',
    wall: 'per-transaction cap',
    expect: 'deny',
    code: 'PER_TX_LIMIT',
    action: { kind: 'near.transfer', asset: 'NEAR', amount: '1000', to: 'compute.near' },
  },
  {
    name: 'Smuggle extra decimals',
    wall: 'exact amount parsing',
    expect: 'deny',
    code: 'INVALID_AMOUNT',
    action: { kind: 'ft.transfer', asset: 'USDC', amount: '5.0000001', to: 'compute.near' },
  },
  {
    name: 'Send a negative amount',
    wall: 'exact amount parsing',
    expect: 'deny',
    code: 'INVALID_AMOUNT',
    action: { kind: 'ft.transfer', asset: 'USDC', amount: '-5', to: 'compute.near' },
  },
  {
    name: 'Send zero',
    wall: 'positive-amount rule',
    expect: 'deny',
    code: 'NON_POSITIVE_AMOUNT',
    action: { kind: 'ft.transfer', asset: 'USDC', amount: '0', to: 'compute.near' },
  },
  {
    name: 'Use scientific notation to dodge parsers',
    wall: 'exact amount parsing',
    expect: 'deny',
    code: 'INVALID_AMOUNT',
    action: { kind: 'ft.transfer', asset: 'USDC', amount: '5e0', to: 'compute.near' },
  },
  {
    name: 'Address in the wrong case',
    wall: 'account id validation',
    expect: 'deny',
    code: 'INVALID_RECIPIENT',
    action: { kind: 'ft.transfer', asset: 'USDC', amount: '5', to: 'Compute.NEAR' },
  },
  {
    name: 'Address with a trailing dot',
    wall: 'account id validation',
    expect: 'deny',
    code: 'INVALID_RECIPIENT',
    action: { kind: 'ft.transfer', asset: 'USDC', amount: '5', to: 'compute.near.' },
  },
  {
    name: 'Reuse the empty action id',
    wall: 'action id required',
    expect: 'deny',
    code: 'INVALID_ACTION',
    action: { kind: 'ft.transfer', asset: 'USDC', amount: '5', to: 'compute.near', id: '' },
  },
  {
    name: 'Invent a new action kind',
    wall: 'action kind allow list',
    expect: 'deny',
    code: 'INVALID_ACTION',
    action: { kind: 'bridge.teleport' as never, asset: 'NEAR', amount: '1', to: 'compute.near' },
  },
  {
    name: 'Spend an asset no limit covers',
    wall: 'deny-by-default asset registry',
    expect: 'deny',
    code: 'UNKNOWN_ASSET',
    action: { kind: 'ft.transfer', asset: 'DOGE', amount: '10', to: 'compute.near' },
  },
  {
    name: 'Pay a stranger',
    wall: 'counterparty allow list',
    expect: 'deny',
    code: 'RECIPIENT_NOT_ALLOWED',
    action: { kind: 'ft.transfer', asset: 'USDC', amount: '5', to: 'attacker.near' },
  },
  {
    name: 'Pay the deny-listed drainer',
    wall: 'counterparty deny list',
    expect: 'deny',
    code: 'RECIPIENT_NOT_ALLOWED',
    action: { kind: 'ft.transfer', asset: 'USDC', amount: '5', to: 'drainer.near' },
  },
  {
    name: 'Address with cyrillic homoglyph',
    wall: 'account id validation',
    expect: 'deny',
    code: 'INVALID_RECIPIENT',
    action: { kind: 'ft.transfer', asset: 'USDC', amount: '5', to: 'c\u043empute.near' },
  },
  {
    name: 'Agent claims the owner account',
    wall: 'agent identity binding',
    expect: 'deny',
    code: 'ACTOR_NOT_AGENT',
    action: { kind: 'ft.transfer', asset: 'USDC', amount: '5', to: 'compute.near', actor: 'alice.near' },
  },
  {
    name: 'Add a new access key',
    wall: 'action kind allow list',
    expect: 'deny',
    code: 'ACTION_NOT_ALLOWED',
    action: { kind: 'key.add', asset: 'NEAR', amount: '0.01', to: 'compute.near' },
  },
  {
    name: 'Delete the owner key',
    wall: 'action kind allow list',
    expect: 'deny',
    code: 'ACTION_NOT_ALLOWED',
    action: { kind: 'key.delete', asset: 'NEAR', amount: '0.01', to: 'compute.near' },
  },
  {
    name: 'Call an arbitrary contract',
    wall: 'action kind allow list',
    expect: 'deny',
    code: 'ACTION_NOT_ALLOWED',
    action: { kind: 'contract.call', asset: 'NEAR', amount: '0.01', to: 'compute.near' },
  },
  {
    name: 'Swap with no quote to inspect',
    wall: 'quote required for swaps',
    expect: 'deny',
    code: 'MISSING_QUOTE',
    action: { kind: 'intent.swap', asset: 'NEAR', amount: '1' },
  },
  {
    name: 'Swap with 5% slippage',
    wall: 'slippage ceiling',
    expect: 'deny',
    code: 'SLIPPAGE_TOO_HIGH',
    action: {
      kind: 'intent.swap',
      asset: 'NEAR',
      amount: '1',
      quote: { originAsset: 'NEAR', destinationAddress: PINNED_DESTINATION, slippageBps: 500 },
    },
  },
  {
    name: 'Swap that redirects the output',
    wall: 'pinned destination address',
    expect: 'deny',
    code: 'DESTINATION_NOT_ALLOWED',
    action: {
      kind: 'intent.swap',
      asset: 'NEAR',
      amount: '1',
      quote: { originAsset: 'NEAR', destinationAddress: ATTACKER_DESTINATION, slippageBps: 50 },
    },
  },
  {
    name: 'Swap on an unknown venue',
    wall: 'venue allow list',
    expect: 'deny',
    code: 'VENUE_NOT_ALLOWED',
    action: {
      kind: 'intent.swap',
      asset: 'NEAR',
      amount: '1',
      venue: 'sketchy-dex',
      quote: { originAsset: 'NEAR', destinationAddress: PINNED_DESTINATION, slippageBps: 50 },
    },
  },
  {
    name: 'Swap with an expired quote',
    wall: 'quote freshness',
    expect: 'deny',
    code: 'QUOTE_EXPIRED',
    action: {
      kind: 'intent.swap',
      asset: 'NEAR',
      amount: '1',
      quote: {
        originAsset: 'NEAR',
        destinationAddress: PINNED_DESTINATION,
        slippageBps: 50,
        expiresAt: '2026-11-02T11:59:00Z',
      },
    },
  },
  {
    name: 'Swap spending a different asset than declared',
    wall: 'quote/action consistency',
    expect: 'deny',
    code: 'ORIGIN_ASSET_MISMATCH',
    action: {
      kind: 'intent.swap',
      asset: 'NEAR',
      amount: '1',
      quote: { originAsset: 'USDC', destinationAddress: PINNED_DESTINATION, slippageBps: 50 },
    },
  },
  {
    name: 'Payment above the human approval line',
    wall: 'approval threshold',
    expect: 'require_approval',
    code: 'APPROVAL_REQUIRED',
    action: { kind: 'ft.transfer', asset: 'USDC', amount: '20', to: 'compute.near' },
  },
  {
    name: 'Legitimate API payment',
    wall: 'none - this one is allowed',
    expect: 'allow',
    action: { kind: 'ft.transfer', asset: 'USDC', amount: '5', to: 'compute.near' },
  },
  {
    name: 'Legitimate cross-chain swap',
    wall: 'none - this one is allowed',
    expect: 'allow',
    action: {
      kind: 'intent.swap',
      asset: 'NEAR',
      amount: '1',
      quote: {
        originAsset: 'NEAR',
        destinationAddress: PINNED_DESTINATION,
        slippageBps: 50,
        expiresAt: '2026-11-02T12:05:00Z',
      },
    },
  },
  {
    name: 'Anything at all, once paused',
    wall: 'owner pause switch',
    expect: 'deny',
    code: 'POLICY_PAUSED',
    policy: 'paused',
    action: { kind: 'ft.transfer', asset: 'USDC', amount: '5', to: 'compute.near' },
  },
  {
    name: 'Anything at all, once expired',
    wall: 'policy expiry',
    expect: 'deny',
    code: 'POLICY_EXPIRED',
    policy: 'expired',
    action: { kind: 'ft.transfer', asset: 'USDC', amount: '5', to: 'compute.near' },
  },
];

export interface ScenarioResult {
  name: string;
  wall: string;
  expect: Expect;
  verdict: Expect;
  passed: boolean;
  codes: string[];
  detail: string;
}

export function makeGuard(policyName = 'lab', start = START): { guard: VetoGuard; clock: { t: number } } {
  const clock = { t: start };
  const guard = VetoGuard.create({
    policyText: policyNames[policyName] ?? LAB,
    clock: () => clock.t,
    prices: PRICES,
  });
  return { guard, clock };
}

/** Run one scenario against a fresh guard; used by tests and the demo. */
export async function runScenario(entry: Scenario, index = 0): Promise<ScenarioResult> {
  const { guard } = makeGuard(entry.policy ?? 'lab');
  const action: ActionRequest = {
    id: `scenario_${index}`,
    kind: 'ft.transfer',
    actor: 'argo.near',
    asset: 'USDC',
    amount: '5',
    to: 'compute.near',
    ...entry.action,
  };
  const { decision } = await guard.submit(action);
  const codes = decision.reasons.map((r) => r.code);
  return {
    name: entry.name,
    wall: entry.wall,
    expect: entry.expect,
    verdict: decision.verdict,
    passed: decision.verdict === entry.expect && (entry.code === undefined || codes.includes(entry.code)),
    codes,
    detail: decision.reasons.map((r) => r.message).join(' | '),
  };
}

export async function runCatalogue(entries: Scenario[] = CATALOGUE): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const [index, entry] of entries.entries()) {
    results.push(await runScenario(entry, index));
  }
  return results;
}

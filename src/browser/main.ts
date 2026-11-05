/**
 * The engine, in a browser tab.
 *
 * This is the same `evaluate()` the CLI and the contract tests use, bundled as a browser
 * global (`window.Veto`). The compiled policy is shipped as JSON produced by the real
 * compiler at build time, so the page needs no server and no network: a judge opens a URL
 * and sees the policy decide.
 *
 * Everything here is read-only apart from a local ledger in memory, which is what makes the
 * demo honest: click "pay 20 USDC" twice and the daily budget really does run out, because
 * the same reservation and window logic is used.
 */
import { evaluate, type ActionRequest, type Decision } from '../core/engine.ts';
import { SpendLedger, type LedgerRecord } from '../core/ledger.ts';
import { parseAmount } from '../core/money.ts';
import type { CompiledPolicy, ActionKind } from '../core/policy.ts';
import snapshot from './snapshot.json';

interface Snapshot {
  now: number;
  prices: Record<string, string>;
  doc: CompiledPolicy['doc'];
  hash: string;
  assets: [string, { id: string; decimals: number }][];
  limits: {
    perTx: [string, string][];
    daily: [string, string][];
    monthly: [string, string][];
    defaultPerTxUsdCents: string | null;
  };
  allow: string[];
  deny: string[];
  strictCounterparties: boolean;
  requireApprovalForNew: boolean;
  allowedActions: ActionKind[] | null;
  deniedActions: ActionKind[];
  approval: { thresholdUsdCents: string | null; approvers: string[]; ttlSeconds: number };
  velocity: { maxTxPerHour: number; minIntervalSeconds: number };
  intents: { venues: string[]; maxSlippageBps: number; requireAllowlistedDestination: boolean; allowedDestinations: string[] };
  risk: { escalateAboveBudgetFraction: number | null; escalateOnNewCounterparty: boolean };
  expiresAt: number | null;
}

const raw = snapshot as unknown as Snapshot;

const big = (value: string | null): bigint | undefined => (value === null ? undefined : BigInt(value));

function hydrate(data: Snapshot): CompiledPolicy {
  return {
    doc: data.doc,
    hash: data.hash,
    assets: new Map(data.assets),
    limits: {
      perTx: new Map(data.limits.perTx.map(([key, value]) => [key, BigInt(value)])),
      daily: new Map(data.limits.daily.map(([key, value]) => [key, BigInt(value)])),
      monthly: new Map(data.limits.monthly.map(([key, value]) => [key, BigInt(value)])),
      defaultPerTxUsdCents: big(data.limits.defaultPerTxUsdCents),
    },
    allow: new Set(data.allow),
    deny: new Set(data.deny),
    strictCounterparties: data.strictCounterparties,
    requireApprovalForNew: data.requireApprovalForNew,
    allowedActions: data.allowedActions ? new Set(data.allowedActions) : null,
    deniedActions: new Set(data.deniedActions),
    approval: {
      thresholdUsdCents: big(data.approval.thresholdUsdCents),
      approvers: data.approval.approvers,
      ttlSeconds: data.approval.ttlSeconds,
    },
    velocity: data.velocity,
    intents: {
      venues: new Set(data.intents.venues),
      maxSlippageBps: data.intents.maxSlippageBps,
      requireAllowlistedDestination: data.intents.requireAllowlistedDestination,
      allowedDestinations: new Set(data.intents.allowedDestinations),
    },
    risk: data.risk,
    expiresAt: data.expiresAt,
    warnings: [],
  };
}

const policy = hydrate(raw);
// The demo has its own clock so that clicking twice does not trip the "5 seconds between
// transfers" rule: each decision happens twelve minutes later in the simulated day.
const STEP_MS = 12 * 60_000;
let tick = 0;
const now = raw.now;
const prices = Object.fromEntries(Object.entries(raw.prices).map(([asset, cents]) => [asset, BigInt(cents)]));

/** The agent already paid each allow-listed vendor yesterday, so a first click is not an approval. */
function warmRecords(): LedgerRecord[] {
  return raw.allow.map((vendor, index) => ({
    actionId: `demo_warm_${index}`,
    kind: 'ft.transfer' as ActionKind,
    asset: 'USDC',
    amountMinor: '1000000',
    amount: '1',
    to: vendor,
    at: now - 24 * 60 * 60 * 1000,
    status: 'committed' as const,
    verdict: 'allow' as const,
  }));
}

let ledger = new SpendLedger(warmRecords(), now);
let counter = 0;

export interface UiAction {
  kind: ActionKind;
  asset: string;
  amount: string;
  to: string;
}

export interface UiBudget {
  asset: string;
  spent: string;
  limit: string;
  remaining: string;
}

function minorOf(asset: string, amount: string): string {
  const meta = policy.assets.get(asset);
  if (!meta) return '0';
  try {
    return parseAmount(amount, meta.decimals).toString();
  } catch {
    return '0';
  }
}

export function decide(input: UiAction): Decision {
  tick += 1;
  const at = now + tick * STEP_MS;
  ledger = ledger.withClock(at);
  const action: ActionRequest = {
    id: `browser_${++counter}`,
    kind: input.kind,
    actor: policy.doc.agent,
    asset: input.asset,
    amount: input.amount,
    to: input.to,
    reason: 'clicked in the browser demo',
  };
  const decision = evaluate(policy, action, ledger, { now: at, prices });

  if (decision.verdict === 'allow') {
    ledger.record({
      actionId: action.id,
      kind: action.kind,
      asset: input.asset,
      amountMinor: decision.amountMinor ?? minorOf(input.asset, input.amount),
      amount: input.amount,
      to: input.to || null,
      at,
      status: 'committed',
      verdict: 'allow',
    });
  }
  return decision;
}

export function reset(): void {
  ledger = new SpendLedger(warmRecords(), now);
  counter = 0;
  tick = 0;
}

/** The simulated time of the last decision, for the page to display. */
export function clock(): string {
  return new Date(now + tick * STEP_MS).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export function budgets(): UiBudget[] {
  const out: UiBudget[] = [];
  for (const [assetId, meta] of policy.assets) {
    const limit = policy.limits.daily.get(assetId);
    if (limit === undefined) continue;
    const spent = ledger.spent(assetId, 'day');
    out.push({
      asset: assetId,
      spent: formatMinor(spent, meta.decimals),
      limit: formatMinor(limit, meta.decimals),
      remaining: formatMinor(limit - spent, meta.decimals),
    });
  }
  return out;
}

function formatMinor(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals) || '0';
  const fraction = decimals === 0 ? '' : '.' + digits.slice(digits.length - decimals).replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction === '.' ? '' : fraction}`;
}

export function info() {
  return {
    policyName: policy.doc.name,
    policyHash: policy.hash,
    owner: policy.doc.owner,
    agent: policy.doc.agent,
    allow: [...policy.allow],
    deny: [...policy.deny],
    thresholdUsdCents: policy.approval.thresholdUsdCents?.toString() ?? null,
    assets: [...policy.assets].map(([id, meta]) => ({ id, decimals: meta.decimals })),
  };
}

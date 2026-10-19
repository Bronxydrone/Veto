/**
 * Policy documents: parsing, strict validation, and compilation to the immutable
 * form the engine evaluates.
 *
 * Design rule: the policy is data, never code. It is written by a human, pinned
 * by hash, and evaluated by a pure function. Nothing an agent says at runtime
 * can add a rule, relax a limit or reorder a comparison.
 */
import { AmountError, DEFAULT_ASSETS, parseAmount, formatAmount, type Asset } from './money.ts';
import { hashObject, canonicalJson } from './canonical.ts';
import { parseConfig } from './yaml.ts';

export const POLICY_VERSION = 1;

export type ActionKind =
  | 'near.transfer'
  | 'ft.transfer'
  | 'intent.swap'
  | 'api.pay'
  | 'key.add'
  | 'key.delete'
  | 'contract.call'
  | 'stake.delegate';

export const ACTION_KINDS: readonly ActionKind[] = [
  'near.transfer',
  'ft.transfer',
  'intent.swap',
  'api.pay',
  'key.add',
  'key.delete',
  'contract.call',
  'stake.delegate',
];

export interface AssetSpec {
  symbol: string;
  decimals: number;
  contract?: string;
}

export type AmountMap = Record<string, string | number>;

export interface PolicyDoc {
  version: number;
  name: string;
  owner: string;
  agent: string;
  expiresAt?: string;
  paused?: boolean;
  assets?: Record<string, AssetSpec>;
  limits: {
    perTx?: AmountMap;
    daily?: AmountMap;
    monthly?: AmountMap;
    defaultPerTxUsd?: number;
  };
  counterparties?: {
    mode?: 'strict' | 'open';
    allow?: string[];
    deny?: string[];
    requireApprovalForNew?: boolean;
  };
  approvals?: {
    thresholdUsd?: number;
    approvers?: string[];
    ttlSeconds?: number;
  };
  velocity?: {
    maxTxPerHour?: number;
    minIntervalSeconds?: number;
  };
  actions?: {
    allow?: ActionKind[];
    deny?: ActionKind[];
  };
  intents?: {
    venues?: string[];
    maxSlippageBps?: number;
    requireAllowlistedDestination?: boolean;
    /** Foreign-chain addresses (0x..., bc1..., etc.) the agent may swap out to. */
    allowedDestinations?: string[];
  };
  risk?: {
    escalateAboveBudgetFraction?: number;
    escalateOnNewCounterparty?: boolean;
  };
}

export interface PolicyIssue {
  path: string;
  message: string;
}

export class PolicyError extends Error {
  issues: PolicyIssue[];
  constructor(issues: PolicyIssue[]) {
    super(`invalid policy: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
    this.name = 'PolicyError';
    this.issues = issues;
  }
}

export interface CompiledPolicy {
  doc: PolicyDoc;
  hash: string;
  assets: Map<string, Asset>;
  /** Resolved bigint limits, keyed by asset id. */
  limits: {
    perTx: Map<string, bigint>;
    daily: Map<string, bigint>;
    monthly: Map<string, bigint>;
    defaultPerTxUsdCents?: bigint;
  };
  allow: Set<string>;
  deny: Set<string>;
  strictCounterparties: boolean;
  requireApprovalForNew: boolean;
  allowedActions: Set<ActionKind> | null;
  deniedActions: Set<ActionKind>;
  approval: {
    thresholdUsdCents?: bigint;
    approvers: string[];
    ttlSeconds: number;
  };
  velocity: { maxTxPerHour: number; minIntervalSeconds: number };
  intents: {
    venues: Set<string>;
    maxSlippageBps: number;
    requireAllowlistedDestination: boolean;
    allowedDestinations: Set<string>;
  };
  risk: {
    escalateAboveBudgetFraction: number | null;
    escalateOnNewCounterparty: boolean;
  };
  expiresAt: number | null;
  warnings: PolicyIssue[];
}

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function isValidAccountId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length < 2 || value.length > 64) return false;
  return ACCOUNT_RE.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Normalise an amount that may have been written as a number in YAML. */
function amountText(value: unknown, path: string, issues: PolicyIssue[]): string | null {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) {
    // YAML turns 1.5 into a float; render it back exactly as a decimal string.
    return value.toString();
  }
  issues.push({ path, message: `expected an amount (string or number), got ${typeof value}` });
  return null;
}

function readAssetMap(
  source: Record<string, unknown>,
  path: string,
  issues: PolicyIssue[],
  registry: Map<string, Asset>,
): Map<string, bigint> | null {
  const out = new Map<string, bigint>();
  for (const [key, raw] of Object.entries(source)) {
    const text = amountText(raw, `${path}.${key}`, issues);
    if (text === null) continue;
    if (!registry.has(key) && !key.match(/^[A-Za-z0-9:_-]{1,64}$/)) {
      issues.push({ path: `${path}.${key}`, message: 'asset id has invalid characters' });
      continue;
    }
    try {
      const decimals = registry.get(key)?.decimals ?? 0;
      const parsed = parseAmount(text, decimals);
      if (parsed <= 0n) issues.push({ path: `${path}.${key}`, message: 'limit must be positive' });
      else out.set(key, parsed);
    } catch (err) {
      issues.push({ path: `${path}.${key}`, message: (err as AmountError).message });
    }
  }
  return out;
}

/** Validate raw parsed YAML/JSON into a structurally sound policy document. */
export function validatePolicy(input: unknown): { doc: PolicyDoc; warnings: PolicyIssue[] } {
  const issues: PolicyIssue[] = [];
  const warnings: PolicyIssue[] = [];

  if (!isPlainObject(input)) throw new PolicyError([{ path: '', message: 'policy must be an object' }]);

  const doc: PolicyDoc = {
    version: 0,
    name: '',
    owner: '',
    agent: '',
    limits: {},
  };

  if (input.version !== POLICY_VERSION) {
    issues.push({ path: 'version', message: `expected ${POLICY_VERSION}, got ${String(input.version)}` });
  } else {
    doc.version = POLICY_VERSION;
  }

  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    issues.push({ path: 'name', message: 'required, non-empty' });
  } else doc.name = input.name.trim();

  if (!isValidAccountId(input.owner)) issues.push({ path: 'owner', message: 'must be a lowercase NEAR account id' });
  else doc.owner = input.owner;

  if (!isValidAccountId(input.agent)) issues.push({ path: 'agent', message: 'must be a lowercase NEAR account id' });
  else doc.agent = input.agent;

  if (doc.owner && doc.agent && doc.owner === doc.agent) {
    issues.push({ path: 'agent', message: 'agent must be a different account than owner, otherwise nothing is enforced' });
  }

  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    if (typeof input.expiresAt !== 'string' || Number.isNaN(Date.parse(input.expiresAt))) {
      issues.push({ path: 'expiresAt', message: 'must be an ISO 8601 timestamp' });
    } else doc.expiresAt = input.expiresAt;
  }

  if (input.paused !== undefined) {
    if (typeof input.paused !== 'boolean') issues.push({ path: 'paused', message: 'must be a boolean' });
    else doc.paused = input.paused;
  }

  if (input.assets !== undefined) {
    if (!isPlainObject(input.assets)) issues.push({ path: 'assets', message: 'must be a map' });
    else {
      const assets: Record<string, AssetSpec> = {};
      for (const [id, raw] of Object.entries(input.assets)) {
        if (!isPlainObject(raw)) {
          issues.push({ path: `assets.${id}`, message: 'must be a map with symbol and decimals' });
          continue;
        }
        const decimals = raw.decimals;
        if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0 || decimals > 24) {
          issues.push({ path: `assets.${id}.decimals`, message: 'must be an integer between 0 and 24' });
          continue;
        }
        const symbol = typeof raw.symbol === 'string' && raw.symbol.length > 0 ? raw.symbol : id;
        const spec: AssetSpec = { symbol, decimals };
        if (typeof raw.contract === 'string') spec.contract = raw.contract;
        assets[id] = spec;
      }
      doc.assets = assets;
    }
  }

  const registry = new Map<string, Asset>(Object.entries(DEFAULT_ASSETS));
  for (const [id, spec] of Object.entries(doc.assets ?? {})) {
    registry.set(id, { id, symbol: spec.symbol, decimals: spec.decimals, contract: spec.contract });
  }

  const limitsRaw = input.limits;
  if (!isPlainObject(limitsRaw)) {
    issues.push({ path: 'limits', message: 'required map (perTx/daily/monthly)' });
  } else {
    const limits: PolicyDoc['limits'] = {};
    for (const key of ['perTx', 'daily', 'monthly'] as const) {
      const raw = limitsRaw[key];
      if (raw === undefined) continue;
      if (!isPlainObject(raw)) {
        issues.push({ path: `limits.${key}`, message: 'must be a map of asset id to amount' });
        continue;
      }
      limits[key] = readAssetMap(raw, `limits.${key}`, issues, registry) ? (raw as AmountMap) : undefined;
    }
    if (limitsRaw.defaultPerTxUsd !== undefined) {
      const v = limitsRaw.defaultPerTxUsd;
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        issues.push({ path: 'limits.defaultPerTxUsd', message: 'must be a positive number' });
      } else limits.defaultPerTxUsd = v;
    }
    doc.limits = limits;
  }

  if (input.counterparties !== undefined) {
    if (!isPlainObject(input.counterparties)) issues.push({ path: 'counterparties', message: 'must be a map' });
    else {
      const cp = input.counterparties;
      const out: NonNullable<PolicyDoc['counterparties']> = {};
      if (cp.mode !== undefined) {
        if (cp.mode !== 'strict' && cp.mode !== 'open') issues.push({ path: 'counterparties.mode', message: "must be 'strict' or 'open'" });
        else out.mode = cp.mode;
      }
      for (const key of ['allow', 'deny'] as const) {
        const raw = cp[key];
        if (raw === undefined) continue;
        if (!Array.isArray(raw)) {
          issues.push({ path: `counterparties.${key}`, message: 'must be a list of account ids' });
          continue;
        }
        const list: string[] = [];
        for (const [i, entry] of raw.entries()) {
          if (!isValidAccountId(entry)) issues.push({ path: `counterparties.${key}[${i}]`, message: `invalid account id: ${String(entry)}` });
          else list.push(entry);
        }
        out[key] = list;
      }
      if (cp.requireApprovalForNew !== undefined) {
        if (typeof cp.requireApprovalForNew !== 'boolean') issues.push({ path: 'counterparties.requireApprovalForNew', message: 'must be a boolean' });
        else out.requireApprovalForNew = cp.requireApprovalForNew;
      }
      doc.counterparties = out;
    }
  }

  if (input.approvals !== undefined) {
    if (!isPlainObject(input.approvals)) issues.push({ path: 'approvals', message: 'must be a map' });
    else {
      const ap = input.approvals;
      const out: NonNullable<PolicyDoc['approvals']> = {};
      if (ap.thresholdUsd !== undefined) {
        if (typeof ap.thresholdUsd !== 'number' || !Number.isFinite(ap.thresholdUsd) || ap.thresholdUsd <= 0) {
          issues.push({ path: 'approvals.thresholdUsd', message: 'must be a positive number' });
        } else out.thresholdUsd = ap.thresholdUsd;
      }
      if (ap.approvers !== undefined) {
        if (!Array.isArray(ap.approvers) || ap.approvers.length === 0) {
          issues.push({ path: 'approvals.approvers', message: 'must be a non-empty list of account ids' });
        } else {
          const list: string[] = [];
          for (const [i, entry] of ap.approvers.entries()) {
            if (!isValidAccountId(entry)) issues.push({ path: `approvals.approvers[${i}]`, message: `invalid account id: ${String(entry)}` });
            else list.push(entry);
          }
          out.approvers = list;
        }
      }
      if (ap.ttlSeconds !== undefined) {
        if (typeof ap.ttlSeconds !== 'number' || !Number.isInteger(ap.ttlSeconds) || ap.ttlSeconds < 0) {
          issues.push({ path: 'approvals.ttlSeconds', message: 'must be a non-negative integer' });
        } else out.ttlSeconds = ap.ttlSeconds;
      }
      if (out.thresholdUsd !== undefined && out.approvers?.length === 0) {
        issues.push({ path: 'approvals.approvers', message: 'required when thresholdUsd is set' });
      }
      doc.approvals = out;
    }
  }

  if (input.velocity !== undefined) {
    if (!isPlainObject(input.velocity)) issues.push({ path: 'velocity', message: 'must be a map' });
    else {
      const v = input.velocity;
      const out: NonNullable<PolicyDoc['velocity']> = {};
      for (const key of ['maxTxPerHour', 'minIntervalSeconds'] as const) {
        const raw = v[key];
        if (raw === undefined) continue;
        if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
          issues.push({ path: `velocity.${key}`, message: 'must be a non-negative integer' });
        } else out[key] = raw;
      }
      doc.velocity = out;
    }
  }

  if (input.actions !== undefined) {
    if (!isPlainObject(input.actions)) issues.push({ path: 'actions', message: 'must be a map' });
    else {
      const out: NonNullable<PolicyDoc['actions']> = {};
      for (const key of ['allow', 'deny'] as const) {
        const raw = input.actions[key];
        if (raw === undefined) continue;
        if (!Array.isArray(raw)) {
          issues.push({ path: `actions.${key}`, message: 'must be a list of action kinds' });
          continue;
        }
        const list: ActionKind[] = [];
        for (const [i, entry] of raw.entries()) {
          if (typeof entry !== 'string' || !ACTION_KINDS.includes(entry as ActionKind)) {
            issues.push({ path: `actions.${key}[${i}]`, message: `unknown action kind: ${String(entry)}` });
          } else list.push(entry as ActionKind);
        }
        out[key] = list;
      }
      if (out.allow && out.deny) {
        const overlap = out.allow.filter((k) => out.deny?.includes(k));
        for (const kind of overlap) {
          issues.push({ path: 'actions', message: `${kind} is both allowed and denied` });
        }
      }
      doc.actions = out;
    }
  }

  if (input.intents !== undefined) {
    if (!isPlainObject(input.intents)) issues.push({ path: 'intents', message: 'must be a map' });
    else {
      const it = input.intents;
      const out: NonNullable<PolicyDoc['intents']> = {};
      if (it.venues !== undefined) {
        if (!Array.isArray(it.venues) || it.venues.some((v) => typeof v !== 'string')) {
          issues.push({ path: 'intents.venues', message: 'must be a list of strings' });
        } else out.venues = it.venues as string[];
      }
      if (it.maxSlippageBps !== undefined) {
        const v = it.maxSlippageBps;
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 10_000) {
          issues.push({ path: 'intents.maxSlippageBps', message: 'must be an integer between 0 and 10000' });
        } else out.maxSlippageBps = v;
      }
      if (it.requireAllowlistedDestination !== undefined) {
        if (typeof it.requireAllowlistedDestination !== 'boolean') {
          issues.push({ path: 'intents.requireAllowlistedDestination', message: 'must be a boolean' });
        } else out.requireAllowlistedDestination = it.requireAllowlistedDestination;
      }
      if (it.allowedDestinations !== undefined) {
        if (!Array.isArray(it.allowedDestinations) || it.allowedDestinations.some((v) => typeof v !== 'string' || v.length === 0)) {
          issues.push({ path: 'intents.allowedDestinations', message: 'must be a list of non-empty address strings' });
        } else out.allowedDestinations = (it.allowedDestinations as string[]).map((v) => v.trim());
      }
      doc.intents = out;
    }
  }

  if (input.risk !== undefined) {
    if (!isPlainObject(input.risk)) issues.push({ path: 'risk', message: 'must be a map' });
    else {
      const r = input.risk;
      const out: NonNullable<PolicyDoc['risk']> = {};
      if (r.escalateAboveBudgetFraction !== undefined) {
        const v = r.escalateAboveBudgetFraction;
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1) {
          issues.push({ path: 'risk.escalateAboveBudgetFraction', message: 'must be between 0 and 1' });
        } else out.escalateAboveBudgetFraction = v;
      }
      if (r.escalateOnNewCounterparty !== undefined) {
        if (typeof r.escalateOnNewCounterparty !== 'boolean') issues.push({ path: 'risk.escalateOnNewCounterparty', message: 'must be a boolean' });
        else out.escalateOnNewCounterparty = r.escalateOnNewCounterparty;
      }
      doc.risk = out;
    }
  }

  if (doc.limits.perTx && doc.limits.daily) {
    for (const [asset, perTx] of Object.entries(doc.limits.perTx)) {
      const daily = doc.limits.daily[asset];
      if (daily === undefined) continue;
      try {
        const decimals = registry.get(asset)?.decimals ?? 0;
        if (parseAmount(String(daily), decimals) < parseAmount(String(perTx), decimals)) {
          warnings.push({ path: `limits.daily.${asset}`, message: 'daily limit is lower than the per-transaction limit' });
        }
      } catch {
        /* already reported */
      }
    }
  }

  const hasPerTxCap = doc.limits.perTx !== undefined && Object.keys(doc.limits.perTx).length > 0;
  if (!hasPerTxCap && doc.limits.defaultPerTxUsd === undefined) {
    issues.push({ path: 'limits.perTx', message: 'either perTx limits or defaultPerTxUsd is required, otherwise nothing bounds a transfer' });
  }

  if (issues.length > 0) throw new PolicyError(issues);
  return { doc, warnings };
}

/** Parse YAML or JSON text into a validated policy document. */
export function loadPolicy(source: string): { doc: PolicyDoc; warnings: PolicyIssue[] } {
  return validatePolicy(parseConfig(source));
}

const SECONDS = 1000;

/** Compile a validated document into the immutable structure the engine uses. */
export function compilePolicy(doc: PolicyDoc): CompiledPolicy {
  const warnings: PolicyIssue[] = [];
  const assets = new Map<string, Asset>();
  for (const [id, asset] of Object.entries(DEFAULT_ASSETS)) assets.set(id, asset);
  for (const [id, spec] of Object.entries(doc.assets ?? {})) {
    assets.set(id, { id, symbol: spec.symbol, decimals: spec.decimals, contract: spec.contract });
  }

  const resolve = (map: AmountMap | undefined): Map<string, bigint> => {
    const out = new Map<string, bigint>();
    for (const [id, raw] of Object.entries(map ?? {})) {
      const asset = assets.get(id);
      if (!asset) {
        throw new PolicyError([{ path: `limits.*.${id}`, message: 'asset is not in the registry; declare it under assets' }]);
      }
      out.set(id, parseAmount(String(raw), asset.decimals));
    }
    return out;
  };

  const allowedActions = doc.actions?.allow && doc.actions.allow.length > 0 ? new Set(doc.actions.allow) : null;
  const deniedActions = new Set<ActionKind>(doc.actions?.deny ?? []);
  const allow = new Set<string>(doc.counterparties?.allow ?? []);
  const deny = new Set<string>(doc.counterparties?.deny ?? []);
  const strictCounterparties =
    doc.counterparties?.mode === 'strict' || (doc.counterparties?.mode !== 'open' && allow.size > 0);

  const compiled: CompiledPolicy = {
    doc,
    hash: hashObject(doc),
    assets,
    limits: {
      perTx: resolve(doc.limits.perTx),
      daily: resolve(doc.limits.daily),
      monthly: resolve(doc.limits.monthly),
      defaultPerTxUsdCents:
        doc.limits.defaultPerTxUsd === undefined ? undefined : BigInt(Math.round(doc.limits.defaultPerTxUsd * 100)),
    },
    allow,
    deny,
    strictCounterparties,
    requireApprovalForNew: doc.counterparties?.requireApprovalForNew ?? false,
    allowedActions,
    deniedActions,
    approval: {
      thresholdUsdCents:
        doc.approvals?.thresholdUsd === undefined ? undefined : BigInt(Math.round(doc.approvals.thresholdUsd * 100)),
      approvers: doc.approvals?.approvers ?? [doc.owner],
      ttlSeconds: doc.approvals?.ttlSeconds ?? 900,
    },
    velocity: {
      maxTxPerHour: doc.velocity?.maxTxPerHour ?? 0,
      minIntervalSeconds: doc.velocity?.minIntervalSeconds ?? 0,
    },
    intents: {
      venues: new Set(doc.intents?.venues ?? ['near-intents']),
      maxSlippageBps: doc.intents?.maxSlippageBps ?? 100,
      requireAllowlistedDestination: doc.intents?.requireAllowlistedDestination ?? true,
      allowedDestinations: new Set((doc.intents?.allowedDestinations ?? []).map((a) => a.toLowerCase())),
    },
    risk: {
      escalateAboveBudgetFraction: doc.risk?.escalateAboveBudgetFraction ?? null,
      escalateOnNewCounterparty: doc.risk?.escalateOnNewCounterparty ?? false,
    },
    expiresAt: doc.expiresAt ? Date.parse(doc.expiresAt) : null,
    warnings,
  };
  return compiled;
}

export function loadCompiledPolicy(source: string): CompiledPolicy {
  const { doc } = loadPolicy(source);
  const compiled = compilePolicy(doc);
  return compiled;
}

/** Canonical on-the-wire form, used for hashing and display. */
export function serializePolicy(doc: PolicyDoc): string {
  return canonicalJson(doc);
}

export function describeLimitMap(map: Map<string, bigint>, policy: CompiledPolicy): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, value] of map) {
    const asset = policy.assets.get(id);
    out[id] = asset ? formatAmount(value, asset.decimals) : value.toString();
  }
  return out;
}

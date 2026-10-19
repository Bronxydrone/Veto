/**
 * Spend ledger: what the agent has already spent, what is reserved, and what has
 * already been attempted.
 *
 * Two properties matter for safety:
 *  - reservations. A decision that needs human approval still occupies budget,
 *    so ten pending approvals cannot be used to spend the same budget ten times.
 *  - replay protection. An action id is single-use; a replayed request is a denial.
 *
 * Amounts are stored twice: `amountMinor` is the exact chain base-unit integer as
 * a decimal string (bigint-safe in JSON), `amount` is the human string. All
 * comparisons use `amountMinor`, so 1 USDC and 1 NEAR never get confused.
 */
import type { ActionKind } from './policy.ts';
import type { Verdict } from './audit.ts';

export type Window = 'day' | 'month';

export interface LedgerRecord {
  actionId: string;
  kind: ActionKind;
  /** Asset id as used in the policy. */
  asset: string;
  /** Exact amount in the asset's smallest unit, as a decimal integer string. */
  amountMinor: string;
  /** Human-readable amount, for display only. Never used in arithmetic. */
  amount: string;
  /** Counterparty account id, if the action has one. */
  to: string | null;
  /** Epoch milliseconds when the record was created. */
  at: number;
  status: 'reserved' | 'committed';
  verdict: Verdict;
  /** Epoch milliseconds after which a reservation stops holding budget. */
  expiresAt?: number;
  reason?: string;
}

export interface LedgerView {
  /** Current time in epoch milliseconds. */
  readonly now: number;
  spent(assetId: string, window: Window): bigint;
  reserved(assetId: string, window: Window): bigint;
  /** Number of committed records at or after `since`. */
  txCountSince(since: number): number;
  lastSpendAt(): number | null;
  /** True when this action id was already evaluated and recorded. */
  hasAttempted(actionId: string): boolean;
  /** True when the account has been paid successfully before. */
  isKnownCounterparty(account: string): boolean;
  attemptsByAccount(account: string): number;
}

export function utcDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function utcMonthKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export class SpendLedger implements LedgerView {
  readonly now: number;
  private records: LedgerRecord[];

  constructor(records: LedgerRecord[] = [], now: number = Date.now()) {
    this.records = records;
    this.now = now;
  }

  withClock(now: number): SpendLedger {
    return new SpendLedger(this.records, now);
  }

  all(): readonly LedgerRecord[] {
    return this.records;
  }

  private active(record: LedgerRecord): boolean {
    if (record.status === 'committed') return true;
    if (record.expiresAt === undefined) return true;
    return record.expiresAt > this.now;
  }

  private inWindow(record: LedgerRecord, window: Window): boolean {
    const recordKey = window === 'day' ? utcDayKey(record.at) : utcMonthKey(record.at);
    const nowKey = window === 'day' ? utcDayKey(this.now) : utcMonthKey(this.now);
    return recordKey === nowKey;
  }

  private sum(assetId: string, window: Window, status: LedgerRecord['status']): bigint {
    let total = 0n;
    for (const record of this.records) {
      if (record.asset !== assetId) continue;
      if (record.status !== status) continue;
      if (!this.active(record)) continue;
      if (!this.inWindow(record, window)) continue;
      total += BigInt(record.amountMinor);
    }
    return total;
  }

  spent(assetId: string, window: Window): bigint {
    return this.sum(assetId, window, 'committed');
  }

  reserved(assetId: string, window: Window): bigint {
    return this.sum(assetId, window, 'reserved');
  }

  txCountSince(since: number): number {
    return this.records.filter((r) => r.at >= since && r.status === 'committed').length;
  }

  lastSpendAt(): number | null {
    const times = this.records.filter((r) => r.status === 'committed').map((r) => r.at);
    return times.length === 0 ? null : Math.max(...times);
  }

  hasAttempted(actionId: string): boolean {
    return this.records.some((r) => r.actionId === actionId);
  }

  isKnownCounterparty(account: string): boolean {
    return this.records.some((r) => r.to === account && r.status === 'committed' && r.verdict === 'allow');
  }

  attemptsByAccount(account: string): number {
    return this.records.filter((r) => r.to === account).length;
  }

  reserve(record: Omit<LedgerRecord, 'status'>): void {
    this.records.push({ ...record, status: 'reserved' });
  }

  commit(actionId: string): void {
    for (const record of this.records) {
      if (record.actionId === actionId) {
        record.status = 'committed';
        // A human said yes: the spend counts as allowed from now on, which is
        // what makes the counterparty "known" for later risk checks.
        record.verdict = 'allow';
        delete record.expiresAt;
      }
    }
  }

  record(record: LedgerRecord): void {
    this.records.push(record);
  }

  /** Drop reservations whose approval window has passed. */
  pruneExpired(): number {
    const before = this.records.length;
    this.records = this.records.filter((r) => r.status === 'committed' || this.active(r));
    return before - this.records.length;
  }

  toJSON(): LedgerRecord[] {
    return this.records.map((r) => ({ ...r }));
  }

  static fromJSON(raw: unknown, now: number = Date.now()): SpendLedger {
    if (!Array.isArray(raw)) return new SpendLedger([], now);
    return new SpendLedger(raw as LedgerRecord[], now);
  }
}

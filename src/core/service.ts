/**
 * VetoGuard: the stateful product around the pure engine.
 *
 * Responsibilities:
 *  - hold the pinned policy, the spend ledger and the audit chain;
 *  - turn an agent request into a decision, and a decision into a booked spend
 *    (or a reservation plus a human approval request);
 *  - re-check the policy at execution time, so an approval issued at 10:00 cannot
 *    be used to spend a limit that was already consumed at 10:05 (TOCTOU);
 *  - refuse to load a policy whose hash is not the one the owner pinned.
 *
 * Everything is persisted as plain JSON so a judge can read the state by eye.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLog, type AuditRecord, type Verdict } from './audit.ts';
import { compilePolicy, loadPolicy, type CompiledPolicy, type PolicyDoc } from './policy.ts';
import { SpendLedger, type LedgerRecord, type LedgerView, type Window } from './ledger.ts';
import { evaluate, DEFAULT_PRICES, type ActionRequest, type Decision } from './engine.ts';
import { formatAmount } from './money.ts';
import { hashObject } from './canonical.ts';

export interface ApprovalRequest {
  id: string;
  actionId: string;
  action: ActionRequest;
  decisionId: string;
  createdAt: string;
  expiresAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed' | 'superseded';
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
}

export interface Attempt {
  actionId: string;
  at: number;
  verdict: Verdict;
  reasonCodes: string[];
}

export interface GuardState {
  version: 1;
  policyHash: string;
  policy: PolicyDoc;
  ledger: LedgerRecord[];
  audit: AuditRecord[];
  approvals: ApprovalRequest[];
  attempts: Attempt[];
}

export interface GuardConfig {
  policyText: string;
  /** Directory used by `save()`. */
  stateDir?: string;
  /** Overridable clock, ms since epoch. */
  clock?: () => number;
  prices?: Record<string, bigint>;
  /** Executor invoked after a decision is allowed. Defaults to a dry run. */
  executor?: (action: ActionRequest, decision: Decision) => Promise<ExecutionResult> | ExecutionResult;
  /** Refuse to load a different policy than this hash. */
  expectedPolicyHash?: string;
}

export interface ExecutionResult {
  status: 'simulated' | 'submitted' | 'failed';
  detail: string;
  /** Chain transaction hash or 1Click deposit address, when a real executor is wired. */
  ref?: string;
}

export interface EvaluateOptions {
  /** When true, nothing is booked: the decision is informational only. */
  dryRun?: boolean;
}

export interface GuardEvaluateResult {
  decision: Decision;
  execution: ExecutionResult | null;
  approval: ApprovalRequest | null;
}

const STATE_FILE = 'state.json';

/** View over the ledger plus every attempt ever seen, for replay protection. */
class GuardView implements LedgerView {
  readonly now: number;
  private ledger: SpendLedger;
  private attempts: Attempt[];

  constructor(ledger: SpendLedger, attempts: Attempt[], now: number) {
    this.ledger = ledger;
    this.attempts = attempts;
    this.now = now;
  }

  spent(assetId: string, window: Window): bigint {
    return this.ledger.spent(assetId, window);
  }
  reserved(assetId: string, window: Window): bigint {
    return this.ledger.reserved(assetId, window);
  }
  txCountSince(since: number): number {
    return this.ledger.txCountSince(since);
  }
  lastSpendAt(): number | null {
    return this.ledger.lastSpendAt();
  }
  hasAttempted(actionId: string): boolean {
    return this.attempts.some((a) => a.actionId === actionId);
  }
  isKnownCounterparty(account: string): boolean {
    return this.ledger.isKnownCounterparty(account);
  }
  attemptsByAccount(account: string): number {
    return this.ledger.attemptsByAccount(account);
  }
}

export class VetoGuard {
  private policy: CompiledPolicy;
  private ledger: SpendLedger;
  private audit: AuditLog;
  private approvals: ApprovalRequest[] = [];
  private attempts: Attempt[] = [];
  private config: GuardConfig;

  private constructor(policy: CompiledPolicy, config: GuardConfig) {
    this.policy = policy;
    this.config = config;
    this.ledger = new SpendLedger([], this.now());
    this.audit = new AuditLog();
  }

  private now(): number {
    return this.config.clock ? this.config.clock() : Date.now();
  }

  static create(config: GuardConfig): VetoGuard {
    const { doc } = loadPolicy(config.policyText);
    const compiled = compilePolicy(doc);
    if (config.expectedPolicyHash && config.expectedPolicyHash !== compiled.hash) {
      throw new Error(
        `policy hash mismatch: owner pinned ${config.expectedPolicyHash}, file is ${compiled.hash}. Refusing to load.`,
      );
    }
    return new VetoGuard(compiled, config);
  }

  get policyHash(): string {
    return this.policy.hash;
  }

  get policyDoc(): PolicyDoc {
    return this.policy.doc;
  }

  get compiled(): CompiledPolicy {
    return this.policy;
  }

  get auditLog(): AuditLog {
    return this.audit;
  }

  get pendingApprovals(): ApprovalRequest[] {
    return this.approvals.filter((a) => a.status === 'pending');
  }

  private view(): GuardView {
    return new GuardView(this.ledger.withClock(this.now()), this.attempts, this.now());
  }

  /** Dry-run an action without touching ledger, audit or approvals. */
  preview(action: ActionRequest): Decision {
    return evaluate(this.policy, action, this.view(), { now: this.now(), prices: this.config.prices ?? DEFAULT_PRICES });
  }

  /** Evaluate and, when allowed, execute. When approval is needed, reserve and queue. */
  async submit(action: ActionRequest, options: EvaluateOptions = {}): Promise<GuardEvaluateResult> {
    const now = this.now();
    const decision = evaluate(this.policy, action, this.view(), { now, prices: this.config.prices ?? DEFAULT_PRICES });

    if (options.dryRun) {
      return { decision, execution: null, approval: null };
    }

    this.attempts.push({
      actionId: action.id,
      at: now,
      verdict: decision.verdict,
      reasonCodes: decision.reasons.map((r) => r.code),
    });

    const audit = (verdict: Verdict, reasons: string[]): void => {
      this.audit.append({
        at: decision.evaluatedAt,
        actor: action.actor,
        actionId: action.id,
        kind: action.kind,
        asset: action.asset,
        amount: decision.amount,
        to: action.to ?? null,
        verdict,
        reasons,
        riskScore: decision.risk.score,
        policyHash: this.policy.hash,
        payloadHash: hashObject(action),
      });
    };

    if (decision.verdict === 'deny') {
      audit('deny', decision.reasons.map((r) => r.code));
      return { decision, execution: null, approval: null };
    }

    if (decision.verdict === 'require_approval') {
      audit('require_approval', decision.reasons.map((r) => r.code));
      const approval = this.enqueueApproval(action, decision);
      return { decision, execution: null, approval };
    }

    // Allowed: only now, after the executor has actually run, do we say so.
    const execution = await this.execute(action, decision);
    if (execution.status === 'failed') {
      audit('deny', ['EXECUTION_FAILED']);
      return {
        decision: {
          ...decision,
          verdict: 'deny',
          reasons: [...decision.reasons, { code: 'EXECUTION_FAILED', severity: 'deny', message: execution.detail }],
        },
        execution,
        approval: null,
      };
    }
    audit('allow', decision.reasons.map((r) => r.code));
    this.commitSpend(action, decision);
    return { decision, execution, approval: null };
  }

  private enqueueApproval(action: ActionRequest, decision: Decision): ApprovalRequest {
    const now = this.now();
    const ttl = this.policy.approval.ttlSeconds;
    const approval: ApprovalRequest = {
      id: `apr_${hashObject({ actionId: action.id, at: now }).slice(0, 12)}`,
      actionId: action.id,
      action,
      decisionId: decision.decisionId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttl * 1000).toISOString(),
      status: 'pending',
    };
    this.approvals.push(approval);
    this.ledger.reserve({
      actionId: action.id,
      kind: action.kind,
      asset: action.asset,
      amountMinor: decision.amountMinor ?? '0',
      amount: decision.amount,
      to: action.to ?? null,
      at: now,
      verdict: decision.verdict,
      expiresAt: now + ttl * 1000,
      reason: 'awaiting human approval',
    });
    return approval;
  }

  /**
   * Replace the policy at runtime (the owner edits policy.yaml and reloads).
   *
   * Pending approvals are re-checked against the new policy at approval time, so
   * tightening the walls also retracts requests that were queued under the old
   * ones. The previous hash is recorded in the audit chain.
   */
  updatePolicy(policyText: string, options: { expectedCurrentHash?: string } = {}): { previousHash: string; policyHash: string } {
    if (options.expectedCurrentHash && options.expectedCurrentHash !== this.policy.hash) {
      throw new Error(`policy hash mismatch: pinned ${options.expectedCurrentHash}, current ${this.policy.hash}`);
    }
    const { doc } = loadPolicy(policyText);
    const compiled = compilePolicy(doc);
    const previousHash = this.policy.hash;
    this.policy = compiled;
    this.audit.append({
      at: new Date(this.now()).toISOString(),
      actor: doc.owner,
      actionId: `policy_${compiled.hash.slice(0, 12)}`,
      kind: 'policy.update',
      asset: '-',
      amount: '0',
      to: null,
      verdict: 'allow',
      reasons: ['POLICY_UPDATED'],
      riskScore: 0,
      policyHash: compiled.hash,
      payloadHash: hashObject({ previousHash, policyHash: compiled.hash, doc }),
    });
    return { previousHash, policyHash: compiled.hash };
  }

  /** Human approves: the policy is re-checked before anything is booked. */  async approve(approvalId: string, approver: string): Promise<{ status: string; decision?: Decision; execution?: ExecutionResult }> {
    const approval = this.approvals.find((a) => a.id === approvalId);
    if (!approval) return { status: 'not_found' };
    const approvers = this.policy.approval.approvers;
    if (!approvers.includes(approver)) return { status: 'not_an_approver' };
    if (approval.status !== 'pending') return { status: `already_${approval.status}` };

    const now = this.now();
    if (Date.parse(approval.expiresAt) < now) {
      approval.status = 'expired';
      this.auditDecision(approval, 'deny', approver, 'APPROVAL_EXPIRED');
      return { status: 'expired' };
    }

    // Release the reservation so the re-check sees the budget as it is now.
    this.releaseReservation(approval.actionId);

    // The request was already recorded when it was queued, so the replay guard
    // must not veto the legitimate re-check of that very request.
    const priorAttempt = this.takeAttempt(approval.actionId);
    const decision = evaluate(this.policy, approval.action, this.view(), { now, prices: this.config.prices ?? DEFAULT_PRICES });
    if (decision.verdict === 'deny') {
      this.restoreAttempt(priorAttempt);
      approval.status = 'superseded';
      approval.decidedBy = approver;
      approval.decidedAt = new Date(now).toISOString();
      approval.note = `re-check failed: ${decision.reasons.map((r) => r.code).join(', ')}`;
      this.auditDecision(approval, 'deny', approver, 'APPROVAL_RECHECK_FAILED');
      return { status: 'recheck_failed', decision };
    }

    const execution = await this.execute(approval.action, decision);
    if (execution.status === 'failed') {
      this.restoreAttempt(priorAttempt);
      approval.status = 'superseded';
      approval.note = execution.detail;
      this.auditDecision(approval, 'deny', approver, 'EXECUTION_FAILED');
      return { status: 'execution_failed', decision, execution };
    }

    approval.status = 'executed';
    approval.decidedBy = approver;
    approval.decidedAt = new Date(now).toISOString();
    this.commitSpend(approval.action, decision);
    this.attempts.push({
      actionId: approval.actionId,
      at: now,
      verdict: 'allow',
      reasonCodes: decision.reasons.map((r) => r.code),
    });
    this.auditDecision(approval, 'allow', approver, 'APPROVED_AND_EXECUTED');
    return { status: 'executed', decision, execution };
  }

  private takeAttempt(actionId: string): Attempt | null {
    const index = this.attempts.findIndex((a) => a.actionId === actionId);
    if (index < 0) return null;
    return this.attempts.splice(index, 1)[0];
  }

  private restoreAttempt(attempt: Attempt | null): void {
    if (attempt) this.attempts.push(attempt);
  }

  reject(approvalId: string, approver: string, note?: string): { status: string } {
    const approval = this.approvals.find((a) => a.id === approvalId);
    if (!approval) return { status: 'not_found' };
    if (!this.policy.approval.approvers.includes(approver)) return { status: 'not_an_approver' };
    if (approval.status !== 'pending') return { status: `already_${approval.status}` };
    approval.status = 'rejected';
    approval.decidedBy = approver;
    approval.decidedAt = new Date(this.now()).toISOString();
    approval.note = note;
    this.releaseReservation(approval.actionId);
    this.auditDecision(approval, 'deny', approver, 'REJECTED_BY_HUMAN');
    return { status: 'rejected' };
  }

  private auditDecision(approval: ApprovalRequest, verdict: Verdict, actor: string, code: string): void {
    this.audit.append({
      at: new Date(this.now()).toISOString(),
      actor,
      actionId: approval.actionId,
      kind: approval.action.kind,
      asset: approval.action.asset,
      amount: approval.action.amount,
      to: approval.action.to ?? null,
      verdict,
      reasons: [code],
      riskScore: 0,
      policyHash: this.policy.hash,
      payloadHash: hashObject(approval.action),
    });
  }

  private releaseReservation(actionId: string): void {
    const records = this.ledger.all() as LedgerRecord[];
    const index = records.findIndex((r) => r.actionId === actionId && r.status === 'reserved');
    if (index >= 0) {
      (records as LedgerRecord[]).splice(index, 1);
    }
  }

  private commitSpend(action: ActionRequest, decision: Decision): void {
    const existing = (this.ledger.all() as LedgerRecord[]).find((r) => r.actionId === action.id && r.status === 'reserved');
    if (existing) {
      this.ledger.commit(action.id);
      return;
    }
    this.ledger.record({
      actionId: action.id,
      kind: action.kind,
      asset: action.asset,
      amountMinor: decision.amountMinor ?? '0',
      amount: decision.amount,
      to: action.to ?? null,
      at: this.now(),
      status: 'committed',
      // Booked money is allowed money: the executor has run or the human said yes.
      verdict: 'allow',
    });
  }

  private async execute(action: ActionRequest, decision: Decision): Promise<ExecutionResult> {
    if (!this.config.executor) {
      return { status: 'simulated', detail: 'no executor configured; spend booked locally' };
    }
    try {
      return await this.config.executor(action, decision);
    } catch (err) {
      return { status: 'failed', detail: (err as Error).message };
    }
  }

  /** Human-readable spend summary, per asset. */
  summary(): { asset: string; perTx: string | null; daily: { limit: string; spent: string; reserved: string; remaining: string } | null; monthly: { limit: string; spent: string; remaining: string } | null }[] {
    const now = this.now();
    const view = new SpendLedger(this.ledger.toJSON(), now);
    const ids = new Set<string>([
      ...this.policy.limits.perTx.keys(),
      ...this.policy.limits.daily.keys(),
      ...this.policy.limits.monthly.keys(),
    ]);
    const out = [];
    for (const id of ids) {
      const asset = this.policy.assets.get(id);
      if (!asset) continue;
      const dailyLimit = this.policy.limits.daily.get(id);
      const monthlyLimit = this.policy.limits.monthly.get(id);
      const dailySpent = view.spent(id, 'day');
      const dailyReserved = view.reserved(id, 'day');
      const monthlySpent = view.spent(id, 'month');
      out.push({
        asset: id,
        perTx: this.policy.limits.perTx.has(id) ? formatAmount(this.policy.limits.perTx.get(id) as bigint, asset.decimals) : null,
        daily: dailyLimit
          ? {
              limit: formatAmount(dailyLimit, asset.decimals),
              spent: formatAmount(dailySpent, asset.decimals),
              reserved: formatAmount(dailyReserved, asset.decimals),
              remaining: formatAmount(dailyLimit - dailySpent - dailyReserved > 0n ? dailyLimit - dailySpent - dailyReserved : 0n, asset.decimals),
            }
          : null,
        monthly: monthlyLimit
          ? {
              limit: formatAmount(monthlyLimit, asset.decimals),
              spent: formatAmount(monthlySpent, asset.decimals),
              remaining: formatAmount(monthlyLimit - monthlySpent > 0n ? monthlyLimit - monthlySpent : 0n, asset.decimals),
            }
          : null,
      });
    }
    return out;
  }

  snapshot(): GuardState {
    return {
      version: 1,
      policyHash: this.policy.hash,
      policy: this.policy.doc,
      ledger: this.ledger.toJSON(),
      audit: this.audit.toJSON(),
      approvals: this.approvals,
      attempts: this.attempts,
    };
  }

  save(dir?: string): string {
    const target = dir ?? this.config.stateDir ?? 'data';
    mkdirSync(target, { recursive: true });
    const file = join(target, STATE_FILE);
    writeFileSync(file, JSON.stringify(this.snapshot(), null, 2), 'utf8');
    return file;
  }

  /** Load a guard from a saved state file plus the policy that produced it. */
  static load(policyText: string, stateDir: string, config: Partial<GuardConfig> = {}): VetoGuard {
    const file = join(stateDir, STATE_FILE);
    if (!existsSync(file)) throw new Error(`no state at ${file}`);
    const state = JSON.parse(readFileSync(file, 'utf8')) as GuardState;
    const guard = VetoGuard.create({ policyText, stateDir, ...config });
    if (state.policyHash !== guard.policyHash) {
      throw new Error(`state was produced by policy ${state.policyHash}, current policy is ${guard.policyHash}`);
    }
    guard.restore(state);
    return guard;
  }

  restore(state: GuardState): void {
    this.ledger = SpendLedger.fromJSON(state.ledger, this.now());
    this.audit = AuditLog.fromJSON(state.audit);
    this.approvals = state.approvals ?? [];
    this.attempts = state.attempts ?? [];
  }

  /** Verify the audit chain and report the head, which a caller can anchor on-chain. */
  verifyAudit(): { ok: boolean; records: number; head: string; brokenAt?: number; reason?: string } {
    return this.audit.verify();
  }

  /** Expire stale approvals and drop their reservations. */
  sweep(): { expired: number; approvals: ApprovalRequest[] } {
    const now = this.now();
    this.ledger.pruneExpired();
    let expired = 0;
    for (const approval of this.approvals) {
      if (approval.status === 'pending' && Date.parse(approval.expiresAt) < now) {
        approval.status = 'expired';
        approval.decidedAt = new Date(now).toISOString();
        this.releaseReservation(approval.actionId);
        expired++;
      }
    }
    return { expired, approvals: this.approvals };
  }
}

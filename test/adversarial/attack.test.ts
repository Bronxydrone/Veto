/**
 * Adversarial test suite.
 *
 * Two layers:
 *  1. the shared catalogue in src/demo/scenarios.ts, asserted case by case;
 *  2. stateful attacks that need history: draining budgets, replaying ids,
 *     stacking approvals, tampering with the audit chain, swapping the policy.
 *
 * Run: npm run test:all
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { join } from 'node:path';
import { AuditLog } from '../../src/core/audit.ts';
import { VetoGuard } from '../../src/core/service.ts';
import type { ActionRequest } from '../../src/core/engine.ts';
import {
  CATALOGUE,
  HIGH_TX,
  LAB,
  PRICES,
  START,
  makeGuard,
  policyText,
  runScenario,
} from '../../src/demo/scenarios.ts';

const base = (id: string, overrides: Partial<ActionRequest> = {}): ActionRequest => ({
  id,
  kind: 'ft.transfer',
  actor: 'argo.near',
  asset: 'USDC',
  amount: '5',
  to: 'compute.near',
  ...overrides,
});

test('the catalogue is big enough to be a claim, not a demo', () => {
  assert.ok(CATALOGUE.length >= 25, `expected at least 25 scenarios, got ${CATALOGUE.length}`);
  assert.ok(CATALOGUE.some((s) => s.expect === 'allow'), 'a catalogue with no allowed actions proves nothing');
  assert.ok(CATALOGUE.some((s) => s.expect === 'require_approval'));
});

test('attack catalogue: every attempt hits the expected wall', async (t) => {
  for (const [index, entry] of CATALOGUE.entries()) {
    await t.test(entry.name, async () => {
      const result = await runScenario(entry, index);
      assert.equal(
        result.verdict,
        entry.expect,
        `${entry.name}: expected ${entry.expect}, got ${result.verdict} [${result.codes.join(', ')}]`,
      );
      if (entry.code) {
        assert.ok(result.codes.includes(entry.code), `${entry.name}: expected ${entry.code} in [${result.codes.join(', ')}]`);
      }
    });
  }
});

test('draining the daily budget runs out of room exactly at the cap', async () => {
  const { guard, clock } = makeGuard();
  for (let i = 0; i < 4; i++) {
    const { decision } = await guard.submit(base(`drain_${i}`, { asset: 'NEAR', amount: '1.25' }));
    assert.equal(decision.verdict, 'allow', `slice ${i} should fit: ${JSON.stringify(decision.reasons)}`);
    clock.t += 10_000;
  }
  const { decision } = await guard.submit(base('drain_5', { asset: 'NEAR', amount: '1.25' }));
  assert.equal(decision.verdict, 'deny');
  assert.ok(decision.reasons.some((r) => r.code === 'DAILY_LIMIT'));
});

test('the daily window really is a day, and the monthly window really is a month', async () => {
  const { guard, clock } = makeGuard();
  let allowed = 0;
  for (let day = 0; day < 20; day++) {
    for (let i = 0; i < 4; i++) {
      const { decision } = await guard.submit(base(`spread_${day}_${i}`, { asset: 'NEAR', amount: '1.25' }));
      if (decision.verdict === 'allow') allowed++;
      clock.t += 10_000;
    }
    clock.t += 86_400_000; // next day
  }
  // 60 NEAR monthly cap / 1.25 NEAR slices = 48 allowed transactions in 20 days.
  assert.equal(allowed, 48);
});

test('a replayed action id cannot spend twice', async () => {
  const { guard, clock } = makeGuard();
  assert.equal((await guard.submit(base('same_id'))).decision.verdict, 'allow');
  clock.t += 10_000;
  const second = await guard.submit(base('same_id'));
  assert.equal(second.decision.verdict, 'deny');
  assert.ok(second.decision.reasons.some((r) => r.code === 'REPLAY'));
});

test('a burst of small transfers trips the hourly rate limit', async () => {
  const { guard, clock } = makeGuard();
  let allowed = 0;
  for (let i = 0; i < 9; i++) {
    const { decision } = await guard.submit(base(`burst_${i}`, { asset: 'NEAR', amount: '0.1' }));
    if (decision.verdict === 'allow') allowed++;
    clock.t += 6_000;
  }
  assert.equal(allowed, 6, 'the policy allows at most 6 transfers per hour');
});

test('two pending approvals cannot book the same budget twice', async () => {
  const { guard, clock } = makeGuard('highTx');
  const a = await guard.submit(base('pend_a', { amount: '60' }));
  const b = await guard.submit(base('pend_b', { amount: '30' }));
  const c = await guard.submit(base('pend_c', { amount: '10' }));
  assert.equal(a.decision.verdict, 'require_approval');
  assert.equal(b.decision.verdict, 'require_approval');
  assert.equal(c.decision.verdict, 'allow', '10 USDC is below the approval line');
  clock.t += 1_000;
  const d = await guard.submit(base('pend_d', { amount: '10' }));
  assert.equal(d.decision.verdict, 'deny', 'the reservations left only 10 USDC of daily budget');
  assert.ok(d.decision.reasons.some((r) => r.code === 'DAILY_LIMIT'));
});

test('approval expires and releases the reservation', async () => {
  const { guard, clock } = makeGuard('highTx');
  const pending = await guard.submit(base('exp_1', { amount: '60' }));
  assert.ok(pending.approval);
  clock.t += 901_000; // ttl is 900s
  assert.equal((await guard.approve(pending.approval.id, 'alice.near')).status, 'expired');
  const after = await guard.submit(base('exp_2', { amount: '20' }));
  assert.equal(after.decision.verdict, 'require_approval', 'the reservation must be gone, so budget is back');
});

test('only a configured approver can release a payment', async () => {
  const { guard } = makeGuard('highTx');
  const pending = await guard.submit(base('who_1', { amount: '60' }));
  assert.ok(pending.approval);
  assert.equal((await guard.approve(pending.approval.id, 'random.near')).status, 'not_an_approver');
  assert.equal(
    (await guard.approve(pending.approval.id, 'argo.near')).status,
    'not_an_approver',
    'the agent must not be able to approve its own spending',
  );
});

test('an approval is re-checked against the current policy (TOCTOU)', async () => {
  const { guard } = makeGuard('highTx');
  const big = await guard.submit(base('toctou_big', { amount: '60' }));
  assert.ok(big.approval);
  guard.updatePolicy(
    policyText((doc) => {
      doc.risk = {};
      doc.velocity = {};
      doc.limits.perTx = { ...doc.limits.perTx, USDC: 5 };
    }),
  );
  const result = await guard.approve(big.approval.id, 'alice.near');
  assert.equal(result.status, 'recheck_failed');
  assert.ok(result.decision?.reasons.some((r) => r.code === 'PER_TX_LIMIT'));
});

test('a human rejection frees the budget immediately', async () => {
  const { guard } = makeGuard('highTx');
  const pending = await guard.submit(base('rej_1', { amount: '90' }));
  assert.ok(pending.approval);
  assert.equal(guard.reject(pending.approval.id, 'alice.near', 'not this month').status, 'rejected');
  const next = await guard.submit(base('rej_2', { amount: '90' }));
  assert.equal(next.decision.verdict, 'require_approval', 'the rejected reservation must not consume budget');
});

test('the audit chain detects tampering', async () => {
  const { guard } = makeGuard();
  await guard.submit(base('audit_1'));
  await guard.submit(base('audit_2', { amount: '6' }));

  const state = guard.snapshot();
  const clean = AuditLog.fromJSON(state.audit);
  assert.equal(clean.verify().ok, true);

  const edited = structuredClone(state.audit);
  edited[0].amount = '0.01';
  const broken = AuditLog.fromJSON(edited).verify();
  assert.equal(broken.ok, false);
  assert.equal(broken.brokenAt, 1);

  const dropped = structuredClone(state.audit);
  dropped.splice(0, 1);
  assert.equal(AuditLog.fromJSON(dropped).verify().ok, false, 'dropping a record breaks the next link');

  // Honest limit: deleting the tail leaves a valid prefix chain. That is exactly
  // why the head hash has to be anchored where the agent cannot rewrite it - the
  // contract's decision hash chain (see contract/src/lib.rs).
  const tailDropped = structuredClone(state.audit);
  tailDropped.pop();
  const prefix = AuditLog.fromJSON(tailDropped).verify();
  assert.equal(prefix.ok, true);
  assert.notEqual(prefix.head, clean.verify().head);
});

test('a swapped-in policy is refused unless its hash matches the pin', () => {
  const generous = policyText((doc) => {
    doc.limits.perTx = { ...doc.limits.perTx, USDC: 10_000 };
  });
  assert.throws(() => VetoGuard.create({ policyText: generous, expectedPolicyHash: 'a'.repeat(64) }), /hash mismatch/);
  const { guard } = makeGuard();
  assert.doesNotThrow(() => VetoGuard.create({ policyText: LAB, expectedPolicyHash: guard.policyHash }));
});

test('splitting below the approval line is bounded by the daily cap', async () => {
  const { guard, clock } = makeGuard(LAB, START);
  assert.equal((await guard.submit(base('split_1', { amount: '9.99' }))).decision.verdict, 'allow');
  clock.t += 10_000;
  assert.equal((await guard.submit(base('split_2', { amount: '9.99' }))).decision.verdict, 'allow');

  let denied = 0;
  for (let i = 0; i < 12; i++) {
    clock.t += 10_000;
    const { decision } = await guard.submit(base(`split_loop_${i}`, { amount: '9.99' }));
    if (decision.verdict === 'deny') denied++;
  }
  assert.ok(denied > 0, 'the daily budget eventually stops the loop');
});

test('an audit record is written for denials too, not only for spends', async () => {
  const { guard } = makeGuard();
  await guard.submit(base('denied_1', { amount: '26' }));
  const state = guard.snapshot();
  assert.equal(state.audit.length, 1);
  assert.equal(state.audit[0].verdict, 'deny');
  assert.ok(state.audit[0].reasons.includes('PER_TX_LIMIT'));
  assert.equal(guard.verifyAudit().ok, true);
});

test('a failing executor is recorded as a denial, not as an allow', async () => {
  const clock = { t: START };
  const guard = VetoGuard.create({
    policyText: LAB,
    clock: () => clock.t,
    prices: PRICES,
    executor: () => {
      throw new Error('relayer refused the transaction');
    },
  });
  const { decision, execution } = await guard.submit(base('exec_1'));
  assert.equal(decision.verdict, 'deny');
  assert.equal(execution?.status, 'failed');
  const state = guard.snapshot();
  assert.equal(state.audit.length, 1);
  assert.equal(state.audit[0].verdict, 'deny');
  assert.ok(state.audit[0].reasons.includes('EXECUTION_FAILED'));
  assert.equal(state.ledger.length, 0, 'a failed execution must not book a spend');
});

test('the guard survives a save/load round trip', async () => {  const dir = join(import.meta.dirname, '..', '..', 'data', 'tmp-state');
  const { guard } = makeGuard('highTx');
  await guard.submit(base('persist_1', { amount: '10' }));
  const file = guard.save(dir);
  assert.ok(file.endsWith('state.json'));

  const reloaded = VetoGuard.load(HIGH_TX, dir, { clock: () => START + 60_000, prices: PRICES });
  assert.equal(reloaded.policyHash, guard.policyHash);
  assert.equal(reloaded.auditLog.length, 1);
  assert.equal(reloaded.verifyAudit().ok, true);
});

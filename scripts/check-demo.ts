/**
 * Verify the committed browser bundle.
 *
 * `docs/demo/veto.js` is a build artefact: if it drifts from the engine, the page lies. This
 * loads the bundle exactly as a browser would, drives the same five cases the CLI documents,
 * and fails if any verdict or the budget accounting is wrong.
 *
 *   node scripts/check-demo.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = join(import.meta.dirname, '..');
const bundle = join(root, 'docs', 'demo', 'veto.js');
const page = join(root, 'docs', 'demo', 'index.html');

if (!existsSync(bundle)) {
  console.error(`missing ${bundle}: run npm run demo:build`);
  process.exit(2);
}
if (!existsSync(page)) {
  console.error(`missing ${page}`);
  process.exit(2);
}

vm.runInThisContext(readFileSync(bundle, 'utf8'), { filename: bundle });
const Veto = (globalThis as { Veto?: Record<string, (...args: unknown[]) => unknown> }).Veto;
if (!Veto || typeof Veto.decide !== 'function') {
  console.error('the bundle did not expose Veto.decide');
  process.exit(1);
}

type Decision = { verdict: string; reasons: { code: string }[] };
const decide = Veto.decide as (action: unknown) => Decision;
const budgets = Veto.budgets as () => { asset: string; spent: string; limit: string }[];
const reset = Veto.reset as () => void;

const cases: { label: string; action: unknown; verdict: string; code?: string }[] = [
  {
    label: 'an allowed payment',
    action: { kind: 'ft.transfer', asset: 'USDC', amount: '5', to: 'compute.near' },
    verdict: 'allow',
  },
  {
    label: 'over the per-tx cap',
    action: { kind: 'ft.transfer', asset: 'USDC', amount: '40', to: 'compute.near' },
    verdict: 'deny',
    code: 'PER_TX_LIMIT',
  },
  {
    label: 'a denied recipient',
    action: { kind: 'ft.transfer', asset: 'USDC', amount: '5', to: 'drainer.near' },
    verdict: 'deny',
    code: 'RECIPIENT_DENIED',
  },
  {
    label: 'a forbidden action kind',
    action: { kind: 'key.add', asset: 'NEAR', amount: '0.01', to: 'compute.near' },
    verdict: 'deny',
    code: 'ACTION_NOT_ALLOWED',
  },
  {
    label: 'above the approval threshold',
    action: { kind: 'ft.transfer', asset: 'USDC', amount: '20', to: 'storage.near' },
    verdict: 'require_approval',
    code: 'APPROVAL_REQUIRED',
  },
];

reset();
let failures = 0;
for (const entry of cases) {
  const decision = decide(entry.action);
  const codes = decision.reasons.map((reason) => reason.code);
  const ok = decision.verdict === entry.verdict && (entry.code === undefined || codes.includes(entry.code));
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${entry.label.padEnd(30)} -> ${decision.verdict} ${codes.join(', ')}`);
}

// The budget must actually move: an allow spends, a deny does not.
reset();
const before = Number(budgets().find((row) => row.asset === 'USDC')?.spent ?? '0');
decide({ kind: 'ft.transfer', asset: 'USDC', amount: '5', to: 'compute.near' });
const after = Number(budgets().find((row) => row.asset === 'USDC')?.spent ?? '0');
const spentOk = after - before === 5;
if (!spentOk) failures += 1;
console.log(`  ${spentOk ? 'ok  ' : 'FAIL'} the browser budget moves with an allowed payment (${before} -> ${after})`);

reset();
console.log(
  failures === 0
    ? 'the committed browser bundle behaves like the engine'
    : `${failures} case(s) disagree with the engine`,
);
process.exitCode = failures === 0 ? 0 : 1;

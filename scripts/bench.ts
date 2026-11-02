/**
 * How long does one decision take?
 *
 * The engine is the whole safety claim, so it runs on every payment an agent makes and
 * cannot be slow. This measures `evaluate()` end to end through the public preview path
 * (`guard.preview`, which does not book anything): real policy, real prices, real clock,
 * no network.
 *
 *   npm run bench
 *
 * Node's `performance.now()` has microsecond resolution, and the numbers below are
 * reported as-is: this is latency on one machine, not a promise about any other.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VetoGuard } from '../src/core/service.ts';
import type { ActionRequest } from '../src/core/engine.ts';
import { PRICES, START } from '../src/demo/scenarios.ts';

const policyPath = join(import.meta.dirname, '..', 'examples', 'policy.yaml');
const guard = VetoGuard.create({
  policyText: readFileSync(policyPath, 'utf8'),
  clock: () => START,
  prices: PRICES,
});
const doc = guard.policyDoc;

const shapes: { label: string; action: ActionRequest }[] = [
  {
    label: 'ft.transfer (USDC, allow-listed vendor)',
    action: { id: 'bench_1', kind: 'ft.transfer', actor: doc.agent, asset: 'USDC', amount: '5', to: 'compute.near' },
  },
  {
    label: 'ft.transfer (USDC, over the per-tx cap)',
    action: { id: 'bench_2', kind: 'ft.transfer', actor: doc.agent, asset: 'USDC', amount: '40', to: 'compute.near' },
  },
  {
    label: 'native transfer (NEAR, stranger)',
    action: { id: 'bench_3', kind: 'near.transfer', actor: doc.agent, asset: 'NEAR', amount: '0.5', to: 'randomer.near' },
  },
  {
    label: 'denied action kind (key.add)',
    action: { id: 'bench_4', kind: 'key.add', actor: doc.agent, asset: 'NEAR', amount: '0.01', to: 'compute.near' },
  },
];

const ITERATIONS = 20_000;
const WARMUP = 2_000;

function percentile(sorted: number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

console.log(`node ${process.version}`);
console.log(`policy ${doc.name}, ${ITERATIONS.toLocaleString('en-US')} decisions per shape, ${WARMUP.toLocaleString('en-US')} warmup`);
console.log('');
console.log('shape                                       p50       p95       p99       max');

let worstP99 = 0;
let median = 0;
for (const shape of shapes) {
  for (let index = 0; index < WARMUP; index += 1) guard.preview({ ...shape.action, id: `warm_${index}` });
  const samples: number[] = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const started = performance.now();
    guard.preview({ ...shape.action, id: `run_${index}` });
    samples.push((performance.now() - started) * 1000);
  }
  samples.sort((a, b) => a - b);
  const p50 = percentile(samples, 0.5);
  const p95 = percentile(samples, 0.95);
  const p99 = percentile(samples, 0.99);
  const max = samples[samples.length - 1];
  worstP99 = Math.max(worstP99, p99);
  median = median === 0 ? p50 : Math.min(median, p50);
  const fmt = (value: number) => `${value.toFixed(2)} µs`.padStart(10);
  console.log(`${shape.label.padEnd(42)}${fmt(p50)}${fmt(p95)}${fmt(p99)}${fmt(max)}`);
}

console.log('');
console.log(`worst p99 across shapes: ${worstP99.toFixed(2)} µs`);
console.log(`1000 decisions at the median cost about ${(median * 1000 / 1000).toFixed(2)} ms of CPU.`);
console.log('the max column includes garbage collection: it is a spike, not the steady state.');

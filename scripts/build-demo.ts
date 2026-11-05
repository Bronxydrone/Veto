/**
 * Build the static demo that runs in a browser tab.
 *
 * Two artefacts, both committed so a judge never needs to build anything:
 *   docs/demo/snapshot.json  - the compiled policy, prices and clock, produced by the real
 *                              compiler (not hand-written JSON that could drift);
 *   docs/demo/veto.js        - the engine bundled for the browser.
 *
 *   node scripts/build-demo.ts
 */
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { compilePolicy, loadPolicy } from '../src/core/policy.ts';
import { PRICES, START } from '../src/demo/scenarios.ts';

const root = join(import.meta.dirname, '..');
const policyPath = join(root, 'examples', 'policy.yaml');
const outDir = join(root, 'docs', 'demo');

const { doc } = loadPolicy(readFileSync(policyPath, 'utf8'));
const policy = compilePolicy(doc);

const pairs = (map: Map<string, bigint>): [string, string][] => [...map].map(([key, value]) => [key, value.toString()]);

const snapshot = {
  now: START,
  // Prices are bigint cents in the engine; JSON carries them as decimal strings.
  prices: Object.fromEntries(Object.entries(PRICES).map(([asset, cents]) => [asset, String(cents)])),
  doc: policy.doc,
  hash: policy.hash,
  assets: [...policy.assets].map(([id, asset]) => [id, { id: asset.id, decimals: asset.decimals }]),
  limits: {
    perTx: pairs(policy.limits.perTx),
    daily: pairs(policy.limits.daily),
    monthly: pairs(policy.limits.monthly),
    defaultPerTxUsdCents: policy.limits.defaultPerTxUsdCents?.toString() ?? null,
  },
  allow: [...policy.allow],
  deny: [...policy.deny],
  strictCounterparties: policy.strictCounterparties,
  requireApprovalForNew: policy.requireApprovalForNew,
  allowedActions: policy.allowedActions ? [...policy.allowedActions] : null,
  deniedActions: [...policy.deniedActions],
  approval: {
    thresholdUsdCents: policy.approval.thresholdUsdCents?.toString() ?? null,
    approvers: policy.approval.approvers,
    ttlSeconds: policy.approval.ttlSeconds,
  },
  velocity: policy.velocity,
  intents: {
    venues: [...policy.intents.venues],
    maxSlippageBps: policy.intents.maxSlippageBps,
    requireAllowlistedDestination: policy.intents.requireAllowlistedDestination,
    allowedDestinations: [...policy.intents.allowedDestinations],
  },
  risk: policy.risk,
  expiresAt: policy.expiresAt,
};

mkdirSync(join(outDir), { recursive: true });
mkdirSync(join(root, 'src', 'browser'), { recursive: true });
writeFileSync(join(root, 'src', 'browser', 'snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

const kb = (path: string) => Math.round(statSync(path).size / 1024);
console.log(`policy ${policy.doc.name}, hash ${policy.hash.slice(0, 12)}`);
console.log(`snapshot       ${kb(join(root, 'src', 'browser', 'snapshot.json'))} KB -> src/browser/snapshot.json`);
console.log('now bundle it: npm run demo:bundle');

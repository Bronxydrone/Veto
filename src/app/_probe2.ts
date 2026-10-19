// Temporary: inspect why the 5% slippage case also reports DESTINATION_NOT_ALLOWED.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPolicy } from '../core/policy.ts';
import { VetoGuard } from '../core/service.ts';

const root = join(import.meta.dirname, '..', '..');
const shipped = readFileSync(join(root, 'examples', 'policy.yaml'), 'utf8');
const doc = loadPolicy(shipped).doc;
doc.risk = { ...(doc.risk ?? {}), escalateOnNewCounterparty: false };
const guard = VetoGuard.create({ policyText: JSON.stringify(doc) });
console.log('allowedDestinations', [...guard.compiled.intents.allowedDestinations]);

const quote = {
  venue: 'near-intents',
  originAsset: 'NEAR',
  destinationAsset: 'x',
  amountIn: '1000000000000000000000000',
  amountOut: '4914535',
  minAmountOut: '4668808',
  slippageBps: 500,
  destinationAddress: '0x9a1f4b0c2d7e8f6a3b5c1d9e0f2a4b6c8d0e1f3a',
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};
const decision = guard.preview({
  id: 'dbg',
  kind: 'intent.swap',
  actor: 'argo.near',
  asset: 'NEAR',
  amount: '1',
  venue: 'near-intents',
  slippageBps: 500,
  quote,
});
console.log(decision.verdict, decision.reasons.map((r) => `${r.code}: ${r.message}`));

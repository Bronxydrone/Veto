// Temporary probe: checks the verdicts the attack script will produce. Deleted before delivery.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadPolicy, type PolicyDoc } from '../core/policy.ts';
import { VetoGuard } from '../core/service.ts';
import type { ActionRequest } from '../core/engine.ts';

const root = join(import.meta.dirname, '..', '..');
const shipped = readFileSync(join(root, 'examples', 'policy.yaml'), 'utf8');
const fixture = JSON.parse(readFileSync(join(root, 'data', 'fixtures', 'quote.json'), 'utf8'));

const PINNED = '0x9a1f4b0c2d7e8f6a3b5c1d9e0f2a4b6c8d0e1f3a';
const ATTACKER = '0xdeadbeef00000000000000000000000000000000';
const START = Date.now();
let t = START;

const doc: PolicyDoc = loadPolicy(shipped).doc;
doc.risk = { ...(doc.risk ?? {}), escalateOnNewCounterparty: false };
const sandboxText = JSON.stringify(doc);

const guard = VetoGuard.create({ policyText: sandboxText, clock: () => t });
const quote = fixture.response.quote;

function swapQuote(tamper: boolean, slippageBps: number) {
  return {
    venue: 'near-intents',
    originAsset: 'NEAR',
    destinationAsset: fixture.request.destinationAsset,
    amountIn: quote.amountIn,
    amountOut: quote.amountOut,
    minAmountOut: slippageBps === 500 ? '4668808' : quote.minAmountOut,
    slippageBps,
    destinationAddress: tamper ? ATTACKER : PINNED,
    expiresAt: new Date(t + 300_000).toISOString(),
  };
}

const cases: { name: string; action: ActionRequest }[] = [
  { name: 'overspend per-tx', action: { id: 'a1', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '26', to: 'compute.near' } },
  { name: 'not allowlisted', action: { id: 'a2', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'attacker.near' } },
  { name: 'drainer', action: { id: 'a3', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'drainer.near' } },
  { name: 'key.add', action: { id: 'a4', kind: 'key.add', actor: 'argo.near', asset: 'NEAR', amount: '0.01' } },
  { name: 'swap slippage', action: { id: 'a5', kind: 'intent.swap', actor: 'argo.near', asset: 'NEAR', amount: '1', venue: 'near-intents', slippageBps: 500, quote: swapQuote(false, 500) } },
  { name: 'swap attacker dest', action: { id: 'a6', kind: 'intent.swap', actor: 'argo.near', asset: 'NEAR', amount: '1', venue: 'near-intents', slippageBps: 50, destinationAddress: ATTACKER, quote: swapQuote(true, 50) } },
  { name: 'too many decimals', action: { id: 'a7', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5.0000001', to: 'compute.near' } },
  { name: 'replay seed', action: { id: 'a8_replay', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'api.data-market.near' } },
  { name: 'replay same id', action: { id: 'a8_replay', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'api.data-market.near' } },
  { name: 'legit payment', action: { id: 'a9', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '4.914535', to: 'compute.near' } },
  { name: 'impersonate owner', action: { id: 'a10', kind: 'ft.transfer', actor: 'alice.near', asset: 'USDC', amount: '5', to: 'compute.near' } },
  { name: 'unknown kind', action: { id: 'a11', kind: 'bridge.teleport' as never, actor: 'argo.near', asset: 'USDC', amount: '5', to: 'compute.near' } },
  { name: 'swap no quote', action: { id: 'a12', kind: 'intent.swap', actor: 'argo.near', asset: 'NEAR', amount: '1' } },
  { name: 'uppercase recipient', action: { id: 'a13', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'Compute.NEAR' } },
];

for (const c of cases) {
  const { decision } = await guard.submit(c.action);
  console.log(c.name, '=>', decision.verdict, decision.reasons.map((r) => r.code).join(','));
  t += 10_000;
}
console.log('sim hash', guard.policyHash.slice(0, 12), 'audit', guard.verifyAudit());
console.log('summary', JSON.stringify(guard.summary()));

// Live policy, fresh guard, exactly the acceptance action.
const live = VetoGuard.create({ policyText: shipped });
const t1 = await live.submit({ id: 't1', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'compute.near' });
console.log('live t1 =>', t1.decision.verdict, t1.decision.reasons.map((r) => r.code).join(','), 'approval', t1.approval?.id);

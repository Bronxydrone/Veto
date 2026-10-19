#!/usr/bin/env node
/**
 * Veto CLI.
 *
 *   node src/cli/veto.ts demo      full narrative: allowed payments, refusals,
 *                                  a live NEAR Intents quote, an approval, audit
 *   node src/cli/veto.ts attack    run the whole attack catalogue
 *   node src/cli/veto.ts quote     fetch a real 1Click quote and gate it
 *   node src/cli/veto.ts evaluate <action.json>
 *   node src/cli/veto.ts audit verify
 *
 * Everything runs against the shipped example policy. No keys, no funds, no
 * network needed for `demo` and `attack` (the quote fixture is recorded).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VetoGuard } from '../core/service.ts';
import { formatAmount } from '../core/money.ts';
import type { ActionRequest, Decision } from '../core/engine.ts';
import {
  ATTACKER_DESTINATION,
  CATALOGUE,
  PINNED_DESTINATION,
  PRICES,
  START,
  makeGuard,
  runCatalogue,
} from '../demo/scenarios.ts';
import { loadQuoteFixture, ONE_CLICK_ASSETS, requestQuote, IntentsError, snapshotFromQuote, type QuoteFixture } from '../chain/intents.ts';
import { SIGNER_ACCOUNTS, derivedPublicKey } from '../chain/chainsig.ts';

const color = process.stdout.isTTY ?? false;
const paint = (code: string, text: string): string => (color ? `\u001b[${code}m${text}\u001b[0m` : text);
const bold = (text: string): string => paint('1', text);
const dim = (text: string): string => paint('2', text);
const green = (text: string): string => paint('32', text);
const red = (text: string): string => paint('31', text);
const amber = (text: string): string => paint('33', text);
const cyan = (text: string): string => paint('36', text);

function verdictChip(verdict: Decision['verdict']): string {
  if (verdict === 'allow') return green('ALLOW          ');
  if (verdict === 'deny') return red('DENY           ');
  return amber('NEEDS APPROVAL ');
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function policyPath(): string {
  return join(import.meta.dirname, '..', '..', 'examples', 'policy.yaml');
}

function buildGuard(clock: { t: number }): VetoGuard {
  return VetoGuard.create({
    policyText: readFileSync(policyPath(), 'utf8'),
    clock: () => clock.t,
    prices: PRICES,
  });
}

function printHeader(guard: VetoGuard): void {
  const doc = guard.policyDoc;
  const summary = guard.summary();
  console.log(bold('VETO') + dim(' - the spending firewall for AI agents'));
  console.log(`${dim('policy')} ${doc.name}  ${dim('hash')} ${guard.policyHash.slice(0, 16)}…`);
  console.log(`${dim('owner')}  ${doc.owner}   ${dim('agent')} ${doc.agent}`);
  const limits = summary
    .map((entry) => `${entry.asset}: ${entry.perTx ?? '-'}/tx, ${entry.daily?.limit ?? '-'}/day`)
    .join('   ');
  console.log(`${dim('limits')} ${limits}`);
  console.log(
    `${dim('escalation')} above $${doc.approvals?.thresholdUsd ?? '-'} a human co-signs (${doc.approvals?.approvers?.join(', ')})`,
  );
  console.log('');
}

function printDecision(index: number, label: string, decision: Decision, note?: string): void {
  const reasons = decision.reasons.length === 0 ? dim('all checks passed') : decision.reasons.map((r) => r.code).join(', ');
  console.log(`${String(index).padStart(2)}. ${verdictChip(decision.verdict)} ${pad(label, 42)} ${dim(reasons)}`);
  if (note) console.log(`    ${dim(note)}`);
}

async function commandDemo(): Promise<number> {
  const clock = { t: START - 2 * 86_400_000 };
  const guard = buildGuard(clock);
  // Warm-up: the owner already approved these vendors two days ago, so the
  // first-payment-to-a-stranger escalation does not fire on the narrative.
  for (const [id, amount, to] of [
    ['demo_warmup', '3', 'compute.near'],
    ['demo_warmup_2', '3', 'api.data-market.near'],
  ] as const) {
    const warm = await guard.submit({ id, kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount, to });
    if (warm.approval) await guard.approve(warm.approval.id, 'alice.near');
  }
  clock.t = START;
  printHeader(guard);

  const actions: { label: string; action: ActionRequest; note?: string }[] = [
    { label: 'pay compute.near for 5 USDC of inference', action: { id: 'demo_1', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'compute.near' } },
    { label: 'pay for a data feed, 12 USDC', action: { id: 'demo_2', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '12', to: 'api.data-market.near' }, note: 'above the $10 line: a human must co-sign' },
    { label: 'try 26 USDC in one go', action: { id: 'demo_3', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '26', to: 'compute.near' } },
    { label: 'pay a stranger', action: { id: 'demo_4', kind: 'ft.transfer', actor: 'argo.near', asset: 'USDC', amount: '5', to: 'attacker.near' } },
    { label: 'add its own access key', action: { id: 'demo_5', kind: 'key.add', actor: 'argo.near', asset: 'NEAR', amount: '0.01', to: 'compute.near' } },
  ];

  let index = 1;
  for (const entry of actions) {
    const { decision } = await guard.submit(entry.action);
    printDecision(index++, entry.label, decision, entry.note);
    clock.t += 7_000;
  }

  // ---- a real cross-chain quote from NEAR Intents -------------------------
  let fixture: QuoteFixture | null = null;
  try {
    fixture = loadQuoteFixture(join(import.meta.dirname, '..', '..', 'data', 'fixtures'));
  } catch {
    fixture = null;
  }
  if (fixture) {
    const quote = fixture.response.quote;
    const out = `${quote.amountOutFormatted} USDC on Arbitrum`;
    console.log('');
    console.log(
      dim(`NEAR Intents quote (recorded live ${fixture.capturedAt}): ${quote.amountInFormatted} NEAR -> ${out}`),
    );
    const swap: ActionRequest = {
      id: 'demo_swap_ok',
      kind: 'intent.swap',
      actor: 'argo.near',
      asset: 'NEAR',
      amount: '1',
      quote: snapshotFromQuote(quote, fixture, {
        policyAsset: 'NEAR',
        destinationAddress: PINNED_DESTINATION,
        expiresAt: new Date(clock.t + 300_000).toISOString(),
      }),
    };
    const allowed = await guard.submit(swap);
    printDecision(index++, `swap 1 NEAR -> ${out}, pinned address`, allowed.decision, 'the policy checks venue, slippage, expiry and destination before the quote is used');
    clock.t += 7_000;

    const tampered = await guard.submit({
      ...swap,
      id: 'demo_swap_bad',
      quote: { ...swap.quote, destinationAddress: ATTACKER_DESTINATION },
    });
    printDecision(index++, 'same quote, output redirected to 0xdeadbeef…', tampered.decision, 'a swapped destination cannot be smuggled through an otherwise valid quote');
    clock.t += 7_000;
  }

  // ---- human approval -----------------------------------------------------
  const pending = await guard.submit({
    id: 'demo_approval',
    kind: 'ft.transfer',
    actor: 'argo.near',
    asset: 'USDC',
    amount: '20',
    to: 'compute.near',
  });
  printDecision(index++, 'pay 20 USDC (needs a human)', pending.decision, pending.approval ? `queued as ${pending.approval.id}, expires ${pending.approval.expiresAt}` : undefined);
  if (pending.approval) {
    const wrong = await guard.approve(pending.approval.id, 'argo.near');
    console.log(`    ${dim('agent tries to approve itself:')} ${wrong.status === 'not_an_approver' ? red('refused') : wrong.status}`);
    const approved = await guard.approve(pending.approval.id, 'alice.near');
    console.log(`    ${dim('owner approves:')} ${approved.status === 'executed' ? green('executed, budget booked') : approved.status}`);
  }

  // ---- audit chain --------------------------------------------------------
  const verify = guard.verifyAudit();
  console.log('');
  console.log(
    `${dim('audit chain')} ${verify.records} records, head ${cyan(verify.head.slice(0, 16))}…, ${verify.ok ? green('verified') : red('BROKEN')}`,
  );
  const snapshot = guard.snapshot();
  const tamperedState = structuredClone(snapshot.audit);
  if (tamperedState.length > 2) {
    tamperedState[1].amount = '0.01';
    const { AuditLog } = await import('../core/audit.ts');
    const broken = AuditLog.fromJSON(tamperedState).verify();
    console.log(
      `${dim('tamper check')} edited record 2 by hand -> ${broken.ok ? red('not detected') : red(`detected at record ${broken.brokenAt}`)}`,
    );
  }
  console.log('');
  console.log(bold('Result: ') + `${verify.records} decisions, no money left the walls.`);
  return 0;
}

async function commandAttack(): Promise<number> {
  console.log(bold('VETO') + dim(' - attack catalogue'));
  console.log('');
  const rows = await runCatalogue(CATALOGUE);
  console.log(`${pad('#', 3)} ${pad('attempt', 46)} ${pad('expected', 16)} ${pad('actual', 16)} wall`);
  console.log(dim('-'.repeat(120)));
  let failures = 0;
  rows.forEach((row, i) => {
    if (!row.passed) failures++;
    const mark = row.passed ? green('ok') : red('FAIL');
    console.log(
      `${pad(String(i + 1), 3)} ${pad(row.name, 46)} ${pad(row.expect, 16)} ${pad(row.verdict, 16)} ${dim(row.wall)} ${mark}`,
    );
  });
  console.log('');
  const denied = rows.filter((r) => r.verdict === 'deny').length;
  const escalated = rows.filter((r) => r.verdict === 'require_approval').length;
  const allowed = rows.filter((r) => r.verdict === 'allow').length;
  console.log(
    `${bold(String(rows.length))} attempts: ${red(`${denied} denied`)}, ${amber(`${escalated} to a human`)}, ${green(`${allowed} allowed`)}`,
  );
  if (failures > 0) console.log(red(`${failures} scenario(s) did not hit the expected wall`));
  return failures === 0 ? 0 : 1;
}

async function commandQuote(destination = PINNED_DESTINATION): Promise<number> {
  const clock = { t: Date.now() };
  const guard = buildGuard(clock);
  const amount = '1';
  console.log(dim('requesting a live 1Click quote...'));
  let quote;
  try {
    const response = await requestQuote({
      originAsset: ONE_CLICK_ASSETS.NEAR,
      destinationAsset: ONE_CLICK_ASSETS.USDC_ARB,
      amount: (BigInt(amount) * 10n ** 24n).toString(),
      recipient: destination,
      refundTo: guard.policyDoc.owner,
      slippageTolerance: 50,
      deadline: new Date(clock.t + 600_000).toISOString(),
      dry: true,
    });
    quote = response.quote;
    console.log(
      green(`live quote: ${amount} NEAR -> ${quote.amountOutFormatted} USDC on Arbitrum (min ${formatAmount(BigInt(quote.minAmountOut), 6)})`),
    );
  } catch (err) {
    if (err instanceof IntentsError) console.log(red(`1Click rejected the quote (${err.status}); falling back to the recorded fixture`));
    else console.log(red(`network unavailable (${(err as Error).message}); falling back to the recorded fixture`));
    const fixture = loadQuoteFixture();
    quote = fixture.response.quote;
  }

  const action: ActionRequest = {
    id: `quote_${clock.t}`,
    kind: 'intent.swap',
    actor: guard.policyDoc.agent,
    asset: 'NEAR',
    amount,
    quote: {
      venue: 'near-intents',
      originAsset: 'NEAR',
      originAssetId: ONE_CLICK_ASSETS.NEAR,
      destinationAsset: ONE_CLICK_ASSETS.USDC_ARB,
      destinationAddress: destination,
      amountOut: quote.amountOut,
      minAmountOut: quote.minAmountOut,
      slippageBps: 50,
      expiresAt: new Date(clock.t + 300_000).toISOString(),
    },
  };
  const { decision } = await guard.submit(action);
  console.log('');
  console.log(`${verdictChip(decision.verdict)} destination ${destination}`);
  for (const check of decision.checks) {
    if (check.id === 'amount-parses') continue;
    console.log(`   ${check.passed ? green('pass') : red('FAIL')} ${pad(check.title, 46)} ${dim(check.detail)}`);
  }
  return decision.verdict === 'allow' ? 0 : 1;
}

async function commandEvaluate(file: string): Promise<number> {
  const clock = { t: Date.now() };
  const guard = buildGuard(clock);
  const action = JSON.parse(readFileSync(file, 'utf8')) as ActionRequest;
  const decision = guard.preview(action);
  console.log(JSON.stringify(decision, null, 2));
  // The JSON is the machine-readable output; the summary goes to stderr so a pipe
  // still receives clean JSON.
  console.error(
    `\n${verdictChip(decision.verdict)} ${decision.amount} ${decision.asset} ${action.kind} ${
      decision.reasons.length === 0 ? '' : '[' + decision.reasons.map((r) => r.code).join(', ') + ']'
    }`,
  );
  return decision.verdict === 'deny' ? 1 : 0;
}

async function commandAudit(args: string[]): Promise<number> {
  const clock = { t: Date.now() };
  const guard = buildGuard(clock);
  const verify = guard.verifyAudit();
  if (args[0] === 'verify') {
    console.log(JSON.stringify(verify, null, 2));
    return verify.ok ? 0 : 1;
  }
  console.log(JSON.stringify(guard.snapshot().audit, null, 2));
  return 0;
}

async function commandChainsig(network: 'mainnet' | 'testnet' = 'mainnet'): Promise<number> {
  const guard = buildGuard({ t: Date.now() });
  const agent = guard.policyDoc.agent;
  const pinned = [...guard.compiled.intents.allowedDestinations][0];
  console.log(`${dim('signer')}  ${SIGNER_ACCOUNTS[network]}  ${dim('agent')} ${agent}  ${dim('path')} ethereum-1`);
  let derived;
  try {
    derived = await derivedPublicKey({ account: agent, path: 'ethereum-1', network });
  } catch (err) {
    console.log(red(`could not reach the MPC signer: ${(err as Error).message}`));
    return 1;
  }
  console.log(`${dim('public key')} ${derived.publicKey}`);
  console.log(`${dim('derived EVM address')} ${cyan(derived.evmAddress)}`);
  console.log(`${dim('pinned in policy')}     ${pinned ?? dim('(none)')}`);
  const matches = pinned !== undefined && pinned.toLowerCase() === derived.evmAddress.toLowerCase();
  console.log('');
  console.log(
    matches
      ? green('match: the only address this agent may receive swaps on is the one the MPC derives for it')
      : red('MISMATCH: the policy pins an address the agent does not control'),
  );
  return matches ? 0 : 1;
}

function usage(): number {
  console.log(
    [
      bold('veto') + ' - policy firewall for AI agent wallets',
      '',
      '  node src/cli/veto.ts demo                     run the full narrative demo',
      '  node src/cli/veto.ts attack                   run the attack catalogue',
      '  node src/cli/veto.ts quote [destination]      live 1Click quote, gated by the policy',
      '  node src/cli/veto.ts chainsig [network]       verify the pinned address against the MPC signer',
      '  node src/cli/veto.ts evaluate <action.json>   dry-run a single action',
      '  node src/cli/veto.ts audit [verify]           print or verify the audit chain',
      '  node src/app/server.ts                        dashboard on http://127.0.0.1:8787',
      '',
    ].join('\n'),
  );
  return 0;
}

const [, , command, ...args] = process.argv;
let code = 0;
switch (command) {
  case 'demo':
    code = await commandDemo();
    break;
  case 'attack':
    code = await commandAttack();
    break;
  case 'quote':
    code = await commandQuote(args[0]);
    break;
  case 'chainsig':
    code = await commandChainsig(args[0] === 'testnet' ? 'testnet' : 'mainnet');
    break;
  case 'evaluate':
    if (!args[0]) {
      console.error('usage: veto evaluate <action.json>');
      code = 2;
    } else code = await commandEvaluate(args[0]);
    break;
  case 'audit':
    code = await commandAudit(args);
    break;
  default:
    code = usage();
}
process.exitCode = code;

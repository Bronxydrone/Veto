/**
 * On-chain proof on NEAR testnet.
 *
 * Three implicit accounts, all funded by the testnet faucet, each with a job:
 *  - contract/owner : holds the funds and the policy;
 *  - vendor         : the only account the agent may pay (no keys needed);
 *  - agent          : ends up with a single function-call key scoped to `spend`.
 *
 * Then the four transactions that matter:
 *   1. owner deploys and installs the policy
 *   2. agent spends inside the limits              -> succeeds
 *   3. agent tries to spend above the per-tx cap   -> rejected by the contract
 *   4. agent tries to pause the contract           -> rejected by the key itself
 *
 * Testnet only: never touches mainnet, never spends anything but faucet NEAR.
 *
 *   node scripts/testnet-demo.ts
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from 'near-api-js';
import { hashObject } from '../src/core/canonical.ts';
import { loadPolicy } from '../src/core/policy.ts';
import { base58Encode } from '../src/chain/chainsig.ts';

// `rpc.testnet.near.org` started answering 429 with a "this endpoint is deprecated"
// notice, so the demo uses FastNEAR's public testnet RPC.
const RPC = 'https://rpc.testnet.fastnear.com';
const FAUCET = 'https://faucet-near-testnet.onrender.com/api/faucet';
const GAS = 100_000_000_000_000n; // 100 Tgas
const ONE_NEAR = 10n ** 24n;
/**
 * The contract calls native NEAR "near" (lowercase) while the policy layer calls it
 * "NEAR". The translation happens here, at the boundary, exactly once.
 */
const CONTRACT_NATIVE = 'near';
const root = join(import.meta.dirname, '..');
const wasmPath = join(root, 'contract', 'res', 'veto_policy.wasm');
const dataDir = join(root, 'data');
const statePath = join(dataDir, 'testnet-roles.json');

interface KeyFile {
  accountId: string;
  publicKey: string;
  secretKey: string;
}

interface Roles {
  owner?: KeyFile;
  vendor?: KeyFile;
  agent?: KeyFile;
  /** The restricted (function-call) key the agent ends up with. */
  agentKey?: { publicKey: string; secretKey: string };
  deployedAt?: string;
  transactions?: Record<string, string>;
}

const provider = new JsonRpcProvider({ url: RPC });
const accountFor = (key: KeyFile): Account =>
  new Account(key.accountId, provider, new KeyPairSigner(KeyPair.fromString(key.secretKey)));
const explorer = (hash: string): string => `https://testnet.nearblocks.io/txns/${hash}`;

function newImplicitAccount(): KeyFile {
  const keyPair = KeyPair.fromRandom('ed25519');
  const rawPublic = Buffer.from(keyPair.getPublicKey().data);
  return {
    accountId: rawPublic.toString('hex'),
    publicKey: keyPair.getPublicKey().toString(),
    secretKey: keyPair.toString(),
  };
}

async function balanceOf(accountId: string): Promise<bigint> {
  const view = await provider.viewAccount({ accountId }).catch(() => null);
  return view ? BigInt((view as { amount?: string }).amount ?? '0') : 0n;
}

async function ensureFunded(role: 'owner' | 'vendor' | 'agent', key: KeyFile): Promise<KeyFile> {
  const balance = await balanceOf(key.accountId);
  if (balance > 0n) {
    console.log(`  ${role.padEnd(6)} ${key.accountId} (${(balance / ONE_NEAR).toString()} NEAR, already funded)`);
    return key;
  }
  const response = await fetch(FAUCET, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: key.accountId }),
  });
  const text = await response.text();
  console.log(`  ${role.padEnd(6)} ${key.accountId} -> faucet ${response.status} ${text.slice(0, 90)}`);
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    if ((await balanceOf(key.accountId)) > 0n) break;
  }
  const funded = await balanceOf(key.accountId);
  if (funded === 0n) throw new Error(`faucet did not fund ${key.accountId}`);
  return key;
}

async function send(account: Account, receiverId: string, actionList: unknown[], label: string): Promise<string> {
  const outcome = (await account.signAndSendTransaction({ receiverId, actions: actionList })) as {
    transaction_outcome?: { id?: string };
  };
  const hash = outcome.transaction_outcome?.id ?? 'unknown';
  console.log(`  ${label}`);
  console.log(`    tx  ${hash}`);
  console.log(`    url ${explorer(hash)}`);
  return hash;
}

async function expectFailure(fn: () => Promise<unknown>, label: string): Promise<string> {
  try {
    await fn();
  } catch (err) {
    const message = (err as Error).message.replace(/\s+/g, ' ').slice(0, 400);
    console.log(`  ${label}: REJECTED`);
    console.log(`    ${message}`);
    return message;
  }
  console.log(`  ${label}: UNEXPECTEDLY SUCCEEDED`);
  return 'unexpected-success';
}

if (!existsSync(wasmPath)) {
  console.error(`no wasm at ${wasmPath}. Build it first: cd contract && ./build.ps1`);
  process.exit(2);
}

mkdirSync(dataDir, { recursive: true });
let roles: Roles = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as Roles) : {};

console.log('1. accounts');
roles.owner ??= newImplicitAccount();
roles.vendor ??= newImplicitAccount();
roles.agent ??= newImplicitAccount();
roles.owner = await ensureFunded('owner', roles.owner);
roles.vendor = await ensureFunded('vendor', roles.vendor);
roles.agent = await ensureFunded('agent', roles.agent);
writeFileSync(statePath, JSON.stringify(roles, null, 2), 'utf8');

const wasm = readFileSync(wasmPath);
const { doc } = loadPolicy(readFileSync(join(root, 'examples', 'policy.yaml'), 'utf8'));
const policyHash = hashObject(doc);

const owner = accountFor(roles.owner);
const vendor = roles.vendor;
const agentInitial = accountFor(roles.agent);

// --- deploy + init (resumable) ---------------------------------------------
const ownerView = await provider.viewAccount({ accountId: roles.owner.accountId });
const EMPTY_CODE_HASH = '11111111111111111111111111111111';
const hasCode = (ownerView as { code_hash?: string }).code_hash !== EMPTY_CODE_HASH;
let deployHash = roles.transactions?.deploy ?? 'skipped-already-deployed';
let initHash = roles.transactions?.init ?? 'skipped-already-initialised';

console.log('\n2. deploy the policy contract and initialise it (owner)');
if (!hasCode) {
  deployHash = await send(owner, roles.owner.accountId, [actions.deployContract(wasm)], 'deployContract');
} else {
  console.log('  contract code already deployed, skipping deployContract');
}

const alreadyInitialised = await owner
  .callFunction({ contractId: roles.owner.accountId, methodName: 'get_config', args: {} })
  .then(() => true)
  .catch(() => false);
if (!alreadyInitialised) {
  initHash = await send(
    owner,
    roles.owner.accountId,
    [actions.functionCall('new', { owner: roles.owner.accountId, agent: roles.agent.accountId }, GAS, 0n)],
    'new(owner, agent)',
  );
} else {
  console.log('  contract already initialised, skipping new()');
}

// --- the agent gives up its full key ---------------------------------------
console.log('\n3. the agent replaces its full-access key with a function-call key scoped to spend()');
const agentKeysBefore = await provider.viewAccessKeyList({ accountId: roles.agent.accountId });
const hasFullKey = (agentKeysBefore as { keys?: { access_key: { permission: unknown } }[] }).keys?.some(
  (entry) => entry.access_key.permission === 'FullAccess',
);
let addKeyHash = 'skipped-key-exists';
let deleteKeyHash = 'skipped-key-exists';

if (!roles.agentKey) {
  const restrictedKeyPair = KeyPair.fromRandom('ed25519');
  if (hasFullKey) {
    addKeyHash = await send(
      agentInitial,
      roles.agent.accountId,
      [
        actions.addFunctionCallAccessKey(
          restrictedKeyPair.getPublicKey(),
          roles.owner.accountId,
          ['spend'],
          2n * ONE_NEAR,
        ),
      ],
      'addKey(function-call: spend only)',
    );
    deleteKeyHash = await send(
      agentInitial,
      roles.agent.accountId,
      [actions.deleteKey(KeyPair.fromString(roles.agent.secretKey).getPublicKey())],
      'deleteKey(full access)',
    );
  } else {
    throw new Error('agent account has no full-access key and no restricted key was recorded; delete data/testnet-roles.json and re-run');
  }
  // Persist the restricted key immediately: the full key is gone, so losing this
  // file locks the agent account forever.
  roles.agentKey = { publicKey: restrictedKeyPair.getPublicKey().toString(), secretKey: restrictedKeyPair.toString() };
  writeFileSync(statePath, JSON.stringify(roles, null, 2), 'utf8');
} else {
  console.log('  the agent already holds a recorded function-call key, skipping key rotation');
}

const agent = new Account(roles.agent.accountId, provider, new KeyPairSigner(KeyPair.fromString(roles.agentKey.secretKey)));
const agentKeys = await provider.viewAccessKeyList({ accountId: roles.agent.accountId });
console.log(
  `  agent holds ${(agentKeys as { keys?: unknown[] }).keys?.length ?? 0} key(s), permissions: ${JSON.stringify(
    (agentKeys as { keys?: { access_key: { permission: unknown } }[] }).keys?.map((entry) =>
      typeof entry.access_key.permission === 'string' ? entry.access_key.permission : Object.keys(entry.access_key.permission as object),
    ),
  )}`,
);

// --- owner installs the policy --------------------------------------------
console.log('\n4. owner installs the policy on-chain: 1 NEAR/tx, 2 NEAR/day, 10 NEAR/month');
const limits = [
  { asset_id: CONTRACT_NATIVE, per_tx: ONE_NEAR.toString(), daily: (2n * ONE_NEAR).toString(), monthly: (10n * ONE_NEAR).toString() },
];
const setPolicyHash = await send(
  owner,
  roles.owner.accountId,
  [actions.functionCall('set_policy', { policy_hash: policyHash, limits, allowlist: [vendor.accountId] }, GAS, 0n)],
  'set_policy(...)',
);

// --- spend inside the limits ----------------------------------------------
console.log('\n5. agent spends 0.25 NEAR to the allow-listed vendor (must succeed)');
const decisionHash = hashObject({ kind: 'near.transfer', amount: '0.25', to: vendor.accountId, at: new Date().toISOString() });
const spendHash = await send(
  agent,
  roles.owner.accountId,
  [
    actions.functionCall(
      'spend',
      { asset_id: CONTRACT_NATIVE, amount: (ONE_NEAR / 4n).toString(), to: vendor.accountId, decision_hash: decisionHash },
      GAS,
      0n,
    ),
  ],
  'spend(0.25 NEAR) -> vendor',
);

// --- over the cap ----------------------------------------------------------
console.log('\n6. agent tries 1.5 NEAR in one transaction (the contract must reject it)');
const overLimit = await expectFailure(
  () =>
    send(
      agent,
      roles.owner.accountId,
      [
        actions.functionCall(
          'spend',
          { asset_id: CONTRACT_NATIVE, amount: ((ONE_NEAR * 3n) / 2n).toString(), to: vendor.accountId, decision_hash: decisionHash },
          GAS,
          0n,
        ),
      ],
      'spend(1.5 NEAR)',
    ),
  'spend(1.5 NEAR) above the 1 NEAR per-tx cap',
);

// --- the key itself forbids anything else ---------------------------------
console.log('\n7. agent tries to pause the contract (its key cannot do that)');
const pauseAttempt = await expectFailure(
  () => send(agent, roles.owner.accountId, [actions.functionCall('set_paused', { paused: true }, GAS, 0n)], 'set_paused(true)'),
  'set_paused(true) from the agent key',
);

// --- read the on-chain state back ----------------------------------------
console.log('\n8. state read back from the contract');
const view = (methodName: string, args: Record<string, unknown> = {}) =>
  owner.callFunction({ contractId: roles.owner!.accountId, methodName, args });
const config = await view('get_config');
const usage = await view('get_usage', { asset_id: CONTRACT_NATIVE });
const lastHash = await view('get_last_decision_hash');
const decisionCount = await view('get_decision_count');
const checkOk = await view('check', { asset_id: CONTRACT_NATIVE, amount: (ONE_NEAR / 10n).toString(), to: vendor.accountId });
const checkBad = await view('check', { asset_id: CONTRACT_NATIVE, amount: (ONE_NEAR * 5n).toString(), to: vendor.accountId });
const checkStranger = await view('check', { asset_id: CONTRACT_NATIVE, amount: (ONE_NEAR / 10n).toString(), to: 'nobody-in-particular.testnet' });
const vendorBalance = await balanceOf(vendor.accountId);

console.log('  config        :', JSON.stringify(config));
console.log('  usage         :', JSON.stringify(usage));
console.log('  decision hash :', JSON.stringify(lastHash), 'count:', JSON.stringify(decisionCount));
console.log('  check(0.1)    :', JSON.stringify(checkOk));
console.log('  check(5.0)    :', JSON.stringify(checkBad));
console.log('  check(stranger):', JSON.stringify(checkStranger));
console.log('  vendor balance:', (vendorBalance / ONE_NEAR).toString(), 'NEAR');

roles.deployedAt = new Date().toISOString();
roles.transactions = {
  deploy: deployHash,
  init: initHash,
  addRestrictedKey: addKeyHash,
  deleteFullKey: deleteKeyHash,
  setPolicy: setPolicyHash,
  spend: spendHash,
};
writeFileSync(statePath, JSON.stringify(roles, null, 2), 'utf8');

writeFileSync(
  join(dataDir, 'testnet-demo.json'),
  JSON.stringify(
    {
      network: 'testnet',
      contract: roles.owner.accountId,
      vendor: vendor.accountId,
      agent: roles.agent.accountId,
      policyHash,
      transactions: roles.transactions,
      rejected: { overLimit, pauseAttempt },
      onchain: { config, usage, lastHash, decisionCount, checkOk, checkBad, checkStranger, vendorBalance: vendorBalance.toString() },
      agentPublicKey: roles.agentKey?.publicKey ?? null,
    },
    null,
    2,
  ),
  'utf8',
);
console.log('\nsummary written to data/testnet-demo.json');



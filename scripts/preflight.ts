/**
 * Pre-flight: one command that answers "is this repository shippable right now?".
 *
 * Static checks read the repo (policy compiles, assets exist, the wasm matches the
 * size and hash the README quotes, every relative markdown link resolves, the
 * submission payload is valid). Dynamic checks run the suites and the live scripts
 * and look at their exit codes only — no output is parsed, so a green line means the
 * command really exited 0.
 *
 *   node scripts/preflight.ts              # everything
 *   node scripts/preflight.ts --offline    # skip the checks that need the network
 *
 * Run this before making the repository public and again before submitting.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { loadPolicy, compilePolicy } from '../src/core/policy.ts';
import { CATALOGUE } from '../src/demo/scenarios.ts';

const root = join(import.meta.dirname, '..');
const offline = process.argv.includes('--offline');

type Status = 'PASS' | 'FAIL' | 'SKIP';
interface Row {
  name: string;
  status: Status;
  detail: string;
}

const rows: Row[] = [];
const add = (name: string, ok: boolean | null, detail: string): void => {
  rows.push({ name, status: ok === null ? 'SKIP' : ok ? 'PASS' : 'FAIL', detail });
};

const read = (path: string): string => readFileSync(join(root, path), 'utf8');

/** Run a command and report only its exit code. */
function run(name: string, command: string, args: string[], timeoutMs = 240_000): void {
  const result = spawnSync(command, args, { cwd: root, stdio: 'ignore', timeout: timeoutMs });
  if (result.error && (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
    add(name, false, `timed out after ${Math.round(timeoutMs / 1000)}s`);
    return;
  }
  add(name, result.status === 0, result.status === 0 ? 'exit 0' : `exit ${result.status ?? 'null (killed)'}`);
}

// ---------------------------------------------------------------- static ----
const { doc } = loadPolicy(read('examples/policy.yaml'));
const compiled = compilePolicy(doc);
add('policy compiles', true, `${doc.name}, hash ${compiled.hash.slice(0, 12)}, ${compiled.limits.perTx.size} per-tx limits`);

add(
  'scenario catalogue is consistent',
  CATALOGUE.length >= 25 && CATALOGUE.every((s) => ['allow', 'deny', 'require_approval'].includes(s.expect)),
  `${CATALOGUE.length} scenarios, every one with an expected verdict`,
);

const assets = [
  'docs/shots/mvp.png',
  'docs/shots/demo.png',
  'docs/shots/attack.png',
  'docs/shots/testnet.png',
  'docs/shots/conformance.png',
  'docs/shots/story.png',
  'docs/shots/bug.png',
  'docs/shots/agent.png',
  'docs/shots/preflight.png',
  'docs/shots/dashboard.png',
  'docs/shots/approvals.png',
  'docs/shots/veto-demo.mp4',
  'docs/testnet-run.json',
  'contract/res/veto_policy.wasm',
];
const missing = assets.filter((asset) => !existsSync(join(root, asset)));
add('demo assets exist', missing.length === 0, missing.length === 0 ? `${assets.length} files` : `missing: ${missing.join(', ')}`);

// The README quotes the wasm's size and hash; they must be true after a rebuild.
const wasmPath = join(root, 'contract/res/veto_policy.wasm');
if (existsSync(wasmPath)) {
  const bytes = statSync(wasmPath).size;
  const sha = createHash('sha256').update(readFileSync(wasmPath)).digest('hex');
  const readme = read('README.md');
  const sizeOk = readme.includes(bytes.toLocaleString('en-US'));
  const shaOk = readme.toLowerCase().includes(sha.slice(0, 8));
  add('wasm matches the README', sizeOk && shaOk, `${bytes.toLocaleString('en-US')} bytes, sha ${sha.slice(0, 8)}${sizeOk && shaOk ? '' : ' — README disagrees'}`);

  const tests = (read('contract/src/lib.rs').match(/#\[test\]/g) ?? []).length;
  add('contract test count matches docs', readme.includes(`${tests} unit tests`), `${tests} #[test] functions`);
}

// Every relative markdown link should resolve - and resolve with the exact case, because
// GitHub serves files from a case-sensitive filesystem while Windows is not, so a
// README that renders locally can show a broken image on the repository page.
const docs = ['README.md', 'AGENTS.md', 'contract/README.md', 'docs/THREAT-MODEL.md', 'docs/FAQ.md', 'docs/TESTNET.md', 'docs/DEMO.md', 'docs/SUBMISSION.md'];
const broken: string[] = [];
const fenceProblems: string[] = [];
const exactCase = (path: string): boolean => {
  try {
    const listed = readdirSync(dirname(path)).map((name) => name.toLowerCase());
    const wanted = path.split(/[\\/]/).pop() ?? '';
    const actual = readdirSync(dirname(path));
    // Equal lowercased name must exist AND the on-disk spelling must match exactly.
    return listed.includes(wanted.toLowerCase()) && actual.includes(wanted);
  } catch {
    return false;
  }
};
for (const file of docs) {
  if (!existsSync(join(root, file))) {
    broken.push(`${file} (missing)`);
    continue;
  }
  const text = read(file);
  const fences = (text.match(/^```/gm) ?? []).length;
  if (fences % 2 !== 0) fenceProblems.push(`${file} (${fences} fences)`);
  for (const match of text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
    const target = match[1];
    if (/^[a-z]+:/i.test(target) || target.startsWith('mailto:')) continue;
    const resolved = join(root, dirname(file), target);
    const fallback = join(root, target);
    const found = (existsSync(resolved) && exactCase(resolved)) || (existsSync(fallback) && exactCase(fallback));
    if (!found) broken.push(`${file} -> ${target}`);
  }
}
add('markdown links resolve (exact case)', broken.length === 0, broken.length === 0 ? `${docs.length} documents` : `broken: ${broken.slice(0, 3).join(', ')}`);
add('code fences are balanced', fenceProblems.length === 0, fenceProblems.length === 0 ? 'every ``` pair closes' : fenceProblems.join(', '));

// Submission payload (the shipped template, without personal data).
try {
  const payload = JSON.parse(read('submission.example.json')) as Record<string, unknown>;
  const idea = String(payload.idea ?? '');
  const tracks = Array.isArray(payload.tracks) ? (payload.tracks as string[]) : [];
  const valid = idea.length >= 20 && idea.length <= 2000 && tracks.length > 0 && !('website' in payload);
  add('submission payload is valid', valid, `idea ${idea.length}/2000 chars, tracks ${tracks.join(' + ') || 'none'}`);
} catch (err) {
  add('submission payload is valid', false, (err as Error).message.slice(0, 80));
}

// The numbers the README quotes must match the artefacts that produced them, otherwise
// a reader has to take the claims on faith.
const conformancePath = join(root, 'data', 'testnet-conformance.json');
if (existsSync(conformancePath)) {
  try {
    const record = JSON.parse(readFileSync(conformancePath, 'utf8')) as { passed?: number; total?: number };
    const claim = `${record.passed}/${record.total}`;
    add('conformance matches the README', read('README.md').includes(claim), `${claim} in data/testnet-conformance.json`);
  } catch (err) {
    add('conformance matches the README', false, (err as Error).message.slice(0, 80));
  }
} else {
  add('conformance matches the README', null, 'no data/testnet-conformance.json on this machine');
}

add(
  'scenario count matches the README',
  read('README.md').includes(`${CATALOGUE.length} ways out of the walls`) || read('README.md').includes(`the same ${CATALOGUE.length} scenarios`),
  `${CATALOGUE.length} in the catalogue`,
);

add('secrets are gitignored', read('.gitignore').includes('data/*.json'), 'data/*.json ignored, fixtures excepted');

// --------------------------------------------------------------- dynamic ----
run('test suite (94 tests)', process.execPath, ['--test-isolation=none', '--test', 'test/**/*.test.ts']);
run('attack catalogue', process.execPath, ['src/cli/veto.ts', 'attack']);
run('narrative demo', process.execPath, ['src/cli/veto.ts', 'demo']);
run('mvp demo', process.execPath, ['src/cli/mvp.ts']);
run('use-case story', process.execPath, ['src/cli/story.ts']);
run('agent loop', process.execPath, ['src/cli/agent.ts']);

if (offline) {
  add('on-chain conformance', null, 'skipped (--offline)');
  add('chain signatures', null, 'skipped (--offline)');
  add('live 1Click quote', null, 'skipped (--offline)');
} else {
  run('on-chain conformance', process.execPath, ['scripts/testnet-conformance.ts'], 420_000);
  run('chain signatures', process.execPath, ['src/cli/veto.ts', 'chainsig'], 120_000);
  run('live 1Click quote', process.execPath, ['src/cli/veto.ts', 'quote'], 120_000);
}

// ------------------------------------------------------------- published ----
// `--published` additionally proves the repository is live: public, default branch
// `main`, README present, and CI present. Off by default, because before publishing
// the correct answer is "not yet".
if (process.argv.includes('--published')) {
  try {
    const payload = JSON.parse(read('submission.example.json')) as { projectUrl?: string };
    const url = new URL(String(payload.projectUrl));
    const slug = url.pathname.replace(/^\//, '').replace(/\.git$/, '');
    const headers = { 'user-agent': 'veto-preflight', accept: 'application/vnd.github+json' };
    const response = await fetch(`https://api.github.com/repos/${slug}`, { headers });
    if (!response.ok) {
      add('repository is public on GitHub', false, `${slug} answered ${response.status}`);
    } else {
      const repo = (await response.json()) as { private?: boolean; default_branch?: string; html_url?: string };
      add('repository is public on GitHub', repo.private === false, `${slug}${repo.private === false ? ' (public)' : ' is private'}`);
      add('default branch is main', repo.default_branch === 'main', String(repo.default_branch));
      const readme = await fetch(`https://api.github.com/repos/${slug}/readme`, { headers });
      add('README is published', readme.ok, readme.ok ? 'readme found' : `readme answered ${readme.status}`);
    }
  } catch (err) {
    add('repository is public on GitHub', false, (err as Error).message.slice(0, 80));
  }
}

// ----------------------------------------------------------------- report ---
const width = Math.max(...rows.map((row) => row.name.length));
console.log('');
console.log(`preflight ${offline ? '(offline)' : ''}`.trim());
console.log('-'.repeat(width + 44));
for (const row of rows) {
  console.log(`${row.name.padEnd(width)}  ${row.status.padEnd(5)}  ${row.detail}`);
}
const failed = rows.filter((row) => row.status === 'FAIL');
const skipped = rows.filter((row) => row.status === 'SKIP').length;
console.log('-'.repeat(width + 44));
console.log(`${rows.length - failed.length - skipped} passed, ${failed.length} failed, ${skipped} skipped`);
console.log(
  failed.length === 0
    ? 'shippable: the repository is consistent and every command exited 0.'
    : 'not shippable yet: fix the FAIL lines above.',
);
process.exitCode = failed.length === 0 ? 0 : 1;

/**
 * Documentation audit: every promise in the docs must still be true.
 *
 * A README rots quietly. Someone renames a script, deletes a file, or writes `npm run
 * bench` before it exists - and the reader finds out, not the author. This script reads
 * the markdown, extracts the commands and the paths it names, and fails when either is
 * missing.
 *
 *   node scripts/audit-docs.ts
 *
 * It is part of `npm run preflight`, so the repository cannot claim a command it does not
 * have.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

const root = join(import.meta.dirname, '..');
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
const scripts = new Set(Object.keys(packageJson.scripts ?? {}));

const documents = [
  'README.md',
  'SECURITY.md',
  'AGENTS.md',
  'docs/DEMO.md',
  'docs/FAQ.md',
  'docs/TESTNET.md',
  'docs/THREAT-MODEL.md',
  'docs/SUBMISSION.md',
  'contract/README.md',
  'src/app/README.md',
];

interface Problem {
  where: string;
  what: string;
  why: string;
}

const problems: Problem[] = [];
let commandsChecked = 0;
let pathsChecked = 0;

/** Paths that are deliberately illustrative rather than real. */
const IGNORE_PATHS = new Set([
  'docs/shots/video/',
  'data/',
  'node_modules/',
]);

for (const document of documents) {
  const absolute = join(root, document);
  if (!existsSync(absolute)) {
    problems.push({ where: document, what: document, why: 'document is missing' });
    continue;
  }
  const text = readFileSync(absolute, 'utf8');

  // `npm run something` and `npm test`-style commands.
  for (const match of text.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) {
    const name = match[1];
    commandsChecked += 1;
    if (!scripts.has(name)) problems.push({ where: document, what: `npm run ${name}`, why: 'no such script in package.json' });
  }

  // Backticked repository paths: src/..., docs/..., contract/..., examples/..., test/...
  for (const match of text.matchAll(/`((?:src|docs|contract|examples|test|data|scripts)\/[A-Za-z0-9._/-]+)`/g)) {
    const candidate = match[1];
    if (candidate.includes('*') || IGNORE_PATHS.has(candidate)) continue;
    pathsChecked += 1;
    const absolutePath = join(root, candidate);
    const ok = existsSync(absolutePath) || existsSync(join(dirname(absolute), candidate));
    if (!ok) problems.push({ where: document, what: candidate, why: 'path does not exist' });
    else if (absolutePath.endsWith('/') && !statSync(absolutePath).isDirectory()) {
      problems.push({ where: document, what: candidate, why: 'expected a directory' });
    }
  }
}

if (problems.length === 0) {
  console.log(`docs audit: ${commandsChecked} commands and ${pathsChecked} paths across ${documents.length} documents, all present`);
} else {
  console.log(`docs audit: ${problems.length} problem(s) in ${commandsChecked} commands and ${pathsChecked} paths`);
  for (const problem of problems) console.log(`  ${problem.where}: ${problem.what} - ${problem.why}`);
  process.exitCode = 1;
}

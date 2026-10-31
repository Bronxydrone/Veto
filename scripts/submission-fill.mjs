#!/usr/bin/env node
/**
 * Fill `submission.json` from a handful of flags, then validate it.
 *
 * The hackathon form cannot be edited after sending, so this script refuses to write
 * anything until every required field is present, and it re-uses one `requestId` so a
 * retry after a network error is still the same submission.
 *
 *   node scripts/submission-fill.mjs \
 *     --name "Boris T" --email you@example.com --near your-account.near \
 *     --repo https://github.com/you/veto \
 *     --demo https://x.com/you/status/1234567890123456789 \
 *     --consent
 *
 * Then:  node scripts/submit.mjs            (prints the payload, sends nothing)
 *        node scripts/submit.mjs --send     (asks you to type the project name)
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith('--') ? value : undefined;
};
const has = (name) => args.includes(`--${name}`);

const name = flag('name');
const email = flag('email');
const near = flag('near');
const repo = flag('repo');
const demo = flag('demo');
const path = flag('out') ?? 'submission.json';

const missing = [];
if (!name) missing.push('--name "Your Name"');
if (!email) missing.push('--email you@example.com');
if (!near) missing.push('--near your-account.near');
if (!repo) missing.push('--repo https://github.com/you/veto');
if (!demo) missing.push('--demo https://x.com/you/status/...');
if (!has('consent')) missing.push('--consent  (only after you agree to the contact notice)');

if (missing.length > 0) {
  console.error('Missing:\n  ' + missing.join('\n  '));
  console.error('\nThe contact notice you are agreeing to:\n  "I agree that the organizers may use these details to review our submission and contact us about this hackathon."');
  process.exit(2);
}

// The template carries the project name, tracks, team size and the 1,737-character
// description; only personal data and links change here.
const template = existsSync('submission.example.json')
  ? JSON.parse(readFileSync('submission.example.json', 'utf8'))
  : {};

// Keep an existing requestId: a retry must be the same submission.
let requestId = template.requestId;
if (!requestId && existsSync(path)) {
  try {
    requestId = JSON.parse(readFileSync(path, 'utf8')).requestId;
  } catch {
    /* fall through and generate one */
  }
}
requestId ??= randomUUID();

const payload = {
  requestId,
  projectName: template.projectName ?? 'Veto',
  leadName: name,
  email,
  size: template.size ?? '1',
  tracks: template.tracks ?? ['security', 'agents'],
  nearAddress: near,
  projectUrl: repo,
  demoUrl: demo,
  idea: template.idea ?? '',
  consent: true,
};

writeFileSync(path, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(`wrote ${path} (requestId ${requestId})`);
console.log('\nNext: node scripts/submit.mjs   — it validates every field and prints the payload.');

// Fail fast if the personal data is obviously wrong (the validator checks the rest).
const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const nearOk = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(near) && near === near.toLowerCase();
const demoOk = /^https?:\/\/(x|twitter)\.com\//i.test(demo);
if (!emailOk) console.warn('warning: the email does not look valid');
if (!nearOk) console.warn('warning: the NEAR account must be lowercase and match the account-id rules');
if (!demoOk) console.warn('warning: the demo link does not look like an X post');

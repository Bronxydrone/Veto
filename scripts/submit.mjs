#!/usr/bin/env node
/**
 * Submission helper for NEAR HACKATHON.
 *
 * The form accepts one submission per team and cannot be edited afterwards, so
 * this script validates every field against the published contract before
 * anything leaves the machine, prints the exact payload for a human to read, and
 * only sends when told to with `--send`.
 *
 * Usage:
 *   node scripts/submit.mjs                 # validate submission.json and print the payload
 *   node scripts/submit.mjs --send          # POST it (asks for confirmation first)
 *   node scripts/submit.mjs --send --yes    # POST without the interactive prompt (CI)
 *
 * Contract: https://nearhackathon.com/HACKATHON.md
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

const ENDPOINT = 'https://nearhackathon.com/api/applications';
const TRACKS = ['defi', 'thesis', 'privacy', 'business', 'swarms', 'security', 'agents', 'realworld', 'games', 'nfts', 'memecoins', 'social', 'open'];
const SIZES = ['1', '2 - 4', '4 - 6', '6 - 8', '8+'];
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const file = process.argv.includes('--file')
  ? process.argv[process.argv.indexOf('--file') + 1]
  : 'submission.json';

if (!existsSync(file)) {
  console.error(`no ${file}. Copy submission.example.json and fill every field by hand.`);
  process.exit(2);
}

const raw = JSON.parse(readFileSync(file, 'utf8'));
const errors = [];
const warnings = [];

// requestId: generate once and keep it, so a retry after a network error is the
// same submission rather than a duplicate.
if (!raw.requestId) {
  raw.requestId = randomUUID();
  writeFileSync(file, JSON.stringify(raw, null, 2) + '\n', 'utf8');
  warnings.push(`requestId was empty; generated ${raw.requestId} and wrote it back to ${file}`);
} else if (!UUID_RE.test(raw.requestId)) {
  errors.push('requestId must be a UUID');
}

const checkText = (field, min, max) => {
  const value = raw[field];
  if (typeof value !== 'string') return errors.push(`${field} must be a string`);
  const length = value.trim().length;
  if (length < min || length > max) errors.push(`${field} must be ${min}-${max} characters, got ${length}`);
  return length;
};

checkText('projectName', 2, 80);
checkText('leadName', 2, 80);
checkText('idea', 20, 2000);

if (typeof raw.email !== 'string' || raw.email.length === 0 || raw.email.length > 160 || !EMAIL_RE.test(raw.email)) {
  errors.push('email must be a valid address of at most 160 characters');
}

if (!SIZES.includes(raw.size)) errors.push(`size must be exactly one of: ${SIZES.join(' | ')}`);

if (!Array.isArray(raw.tracks) || raw.tracks.length === 0) {
  errors.push('tracks must be a non-empty array');
} else {
  const unknown = raw.tracks.filter((t) => !TRACKS.includes(t));
  if (unknown.length) errors.push(`unknown track ids: ${unknown.join(', ')}`);
  if (new Set(raw.tracks).size !== raw.tracks.length) errors.push('tracks must not repeat an id');
}

if (typeof raw.nearAddress !== 'string' || raw.nearAddress !== raw.nearAddress.toLowerCase() || raw.nearAddress.length < 2 || raw.nearAddress.length > 64 || !ACCOUNT_RE.test(raw.nearAddress)) {
  errors.push('nearAddress must be a lowercase mainnet NEAR account id (2-64 chars)');
}

for (const field of ['projectUrl', 'demoUrl']) {
  const value = raw[field];
  if (typeof value !== 'string' || value.length > 300 || !/^https?:\/\//.test(value)) {
    errors.push(`${field} must be an http(s) URL of at most 300 characters`);
  }
}

if (raw.consent !== true) errors.push('consent must be true, and only after the team lead agreed to the contact notice');

// `website` is a spam trap: any non-empty value rejects the submission.
if ('website' in raw) {
  if (raw.website) errors.push('website must be absent or empty (it is a spam trap)');
  else delete raw.website;
}

const allowed = ['requestId', 'projectName', 'leadName', 'email', 'size', 'tracks', 'nearAddress', 'projectUrl', 'demoUrl', 'idea', 'consent'];
const extra = Object.keys(raw).filter((key) => !allowed.includes(key));
if (extra.length) errors.push(`unexpected fields: ${extra.join(', ')}`);

const body = JSON.stringify(Object.fromEntries(allowed.filter((k) => k in raw).map((k) => [k, raw[k]])));
if (Buffer.byteLength(body, 'utf8') > 12_000) errors.push(`payload is ${Buffer.byteLength(body, 'utf8')} bytes, the limit is 12000`);

// Cheap sanity checks that catch the mistakes people actually make.
if (/\bexample\.com\b/i.test(String(raw.email))) warnings.push('email looks like a placeholder');
if (/<.*>/.test(String(raw.projectUrl)) || /<.*>/.test(String(raw.demoUrl))) warnings.push('a URL still contains a <placeholder>');
if (raw.projectUrl && raw.demoUrl && raw.projectUrl === raw.demoUrl) errors.push('projectUrl and demoUrl must be different links');
if (String(raw.idea).trim().length < 300) warnings.push('idea is short; the form allows 2,000 characters and judges read it');
if (!/x\.com|twitter\.com/i.test(String(raw.demoUrl))) warnings.push('demoUrl does not look like an X post');

console.log('Payload to be submitted:\n');
console.log(JSON.stringify(JSON.parse(body), null, 2));
console.log(`\n${Buffer.byteLength(body, 'utf8')} bytes of 12000 allowed.`);

if (warnings.length) {
  console.log('\nWarnings:');
  for (const warning of warnings) console.log(`  - ${warning}`);
}

if (errors.length) {
  console.error('\nRefusing to continue:');
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

if (!process.argv.includes('--send')) {
  console.log('\nValid. Nothing was sent. Re-run with --send when the repository is public and the X post is live.');
  process.exit(0);
}

if (!process.argv.includes('--yes')) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('\nThis cannot be edited or resubmitted. Type the project name to send: ');
  await rl.close();
  if (answer.trim() !== String(raw.projectName).trim()) {
    console.error('aborted: the name did not match');
    process.exit(1);
  }
}

// The submission window is part of the contract: outside it the API answers 403.
const now = new Date();
const opens = Date.parse('2026-11-01T00:00:00Z');
const closes = Date.parse('2026-11-14T23:59:00Z');
if (now.getTime() < opens || now.getTime() > closes) {
  console.error(`Refusing to send: submissions are only accepted 2026-11-01T00:00:00Z .. 2026-11-14T23:59:00Z (now ${now.toISOString()}).`);
  process.exit(1);
}

const response = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
const text = await response.text();
console.log(`\nHTTP ${response.status}\n${text}`);

switch (response.status) {
  case 201:
    console.log('\nSaved. Keep this requestId for your records: ' + raw.requestId);
    break;
  case 400:
    console.error('\nA field failed validation; fix the fields in the response and re-run. Same requestId, so it is still one submission.');
    break;
  case 403:
    console.error('\nSubmissions are not open (or the request looked cross-site). Do not retry.');
    break;
  case 409:
    console.error('\nThis project name or email was already used. Do not rename to work around it - ask the organisers.');
    break;
  case 413:
    console.error('\nPayload too large. Shorten the idea field.');
    break;
  case 503:
    console.error('\nStorage is temporarily unavailable. Wait a minute and re-run with the same requestId.');
    break;
  default:
    console.error('\nUnexpected status; check the body above before retrying.');
}
process.exit(response.status === 201 ? 0 : 1);

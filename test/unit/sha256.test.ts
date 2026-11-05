import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createHash as nodeCreateHash } from 'node:crypto';
import { createHash as shimCreateHash } from '../../src/browser/crypto-shim.ts';

/**
 * The browser demo hashes decision fingerprints with a hand-written SHA-256, because
 * `crypto.subtle` is async and `evaluate()` is synchronous. This proves the two agree, so a
 * decision shown in the browser has the same fingerprint as the same decision in the CLI.
 */
const vectors = [
  '',
  'a',
  'abc',
  'The quick brown fox jumps over the lazy dog',
  'Veto: policy firewall for AI agents on NEAR',
  '{"actionId":"browser_1","verdict":"allow"}',
  'Привет, мир',
  '🙂 unicode and emoji 🙂',
  'x'.repeat(55),
  'x'.repeat(56),
  'x'.repeat(63),
  'x'.repeat(64),
  'x'.repeat(1000),
  JSON.stringify({ limits: [1.5, 25], owner: 'alice.near', nested: { allow: ['compute.near'] } }),
];

test('the browser shim produces the same SHA-256 as node:crypto', () => {
  for (const input of vectors) {
    const expected = nodeCreateHash('sha256').update(input, 'utf8').digest('hex');
    const actual = shimCreateHash('sha256').update(input, 'utf8').digest('hex');
    assert.equal(actual, expected, `mismatch for ${JSON.stringify(input.slice(0, 40))}`);
    assert.equal(actual.length, 64);
  }
});

test('update() can be called in pieces, like a stream', () => {
  const expected = nodeCreateHash('sha256').update('hello world').digest('hex');
  const actual = shimCreateHash('sha256').update('hello ').update('world').digest('hex');
  assert.equal(actual, expected);
});

test('a non-sha256 algorithm is refused rather than silently wrong', () => {
  assert.throws(() => shimCreateHash('md5'), /only sha256/);
});

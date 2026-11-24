// Covers: request validation (POST /run-agent body, branch names) and LogBuffer/LineSplitter (logs_tail source).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isValidBranchName, validateRunAgentBody, MAX_PROMPT_LENGTH } from '../src/lib/validate.js';
import { LogBuffer, LineSplitter, MAX_LINE_LENGTH } from '../src/lib/logBuffer.js';

test('isValidBranchName accepts main, dev, feature/x-1, release/1.2', () => {
  for (const b of ['main', 'dev', 'feature/x-1', 'release/1.2', 'a_b.c']) assert.equal(isValidBranchName(b), true, b);
});

test('isValidBranchName rejects "", "-rf", "/a", "a/", "a..b", "a//b", "a@{1}", "x.lock", "a b", ";rm", non-strings', () => {
  for (const b of ['', '-rf', '/a', 'a/', 'a..b', 'a//b', 'a@{1}', 'x.lock', 'a b', ';rm', 'a.', 'x'.repeat(201)]) {
    assert.equal(isValidBranchName(b), false, JSON.stringify(b));
  }
  for (const b of [null, undefined, 1, {}, ['main']]) assert.equal(isValidBranchName(b), false, String(b));
});

test('validateRunAgentBody: ok with prompt only -> branch null; ok with branch', () => {
  assert.deepEqual(validateRunAgentBody({ prompt: ' hi ' }), { ok: true, prompt: ' hi ', branch: null });
  assert.deepEqual(validateRunAgentBody({ prompt: 'hi', branch: 'dev', extra: 1 }), { ok: true, prompt: 'hi', branch: 'dev' });
  assert.deepEqual(validateRunAgentBody({ prompt: 'hi', branch: null }), { ok: true, prompt: 'hi', branch: null });
});

test('validateRunAgentBody: missing/empty/whitespace/non-string prompt -> error', () => {
  for (const body of [{}, { prompt: '' }, { prompt: '  \n ' }, { prompt: 42 }, { prompt: ['x'] }]) {
    const v = validateRunAgentBody(body);
    assert.equal(v.ok, false);
    assert.equal(v.error, 'prompt is required and must be a non-empty string');
  }
});

test('validateRunAgentBody: prompt > MAX_PROMPT_LENGTH -> error', () => {
  assert.equal(validateRunAgentBody({ prompt: 'x'.repeat(MAX_PROMPT_LENGTH) }).ok, true);
  const v = validateRunAgentBody({ prompt: 'x'.repeat(MAX_PROMPT_LENGTH + 1) });
  assert.equal(v.ok, false);
  assert.equal(v.error, `prompt exceeds ${MAX_PROMPT_LENGTH} characters`);
});

test('validateRunAgentBody: array / null body -> error; bad branch -> error', () => {
  for (const body of [null, [], 'str', 5, undefined]) {
    assert.deepEqual(validateRunAgentBody(body), { ok: false, error: 'body must be a JSON object' });
  }
  for (const branch of ['-x', 'a..b', 5, '']) {
    assert.deepEqual(validateRunAgentBody({ prompt: 'p', branch }), { ok: false, error: 'branch is not a valid branch name' });
  }
});

test('LogBuffer keeps last `capacity` lines and tail(n) joins with \\n', () => {
  const b = new LogBuffer(3);
  assert.equal(b.tail(5), '');
  b.push('a\nb\n');
  assert.equal(b.size, 2);
  b.push('c\r\nd');
  assert.equal(b.size, 3);
  assert.equal(b.tail(10), 'b\nc\nd');
  assert.equal(b.tail(2), 'c\nd');
  assert.equal(b.tail(0), '');
});

test('LogBuffer truncates lines longer than MAX_LINE_LENGTH', () => {
  const b = new LogBuffer();
  b.push('x'.repeat(MAX_LINE_LENGTH + 10));
  b.push('y'.repeat(MAX_LINE_LENGTH));
  const [first, second] = b.lines;
  assert.equal(first, 'x'.repeat(MAX_LINE_LENGTH) + '…[truncated]');
  assert.equal(second, 'y'.repeat(MAX_LINE_LENGTH));
});

test('LineSplitter handles chunks split mid-line and \\r\\n; flush emits partial', () => {
  const out = [];
  const s = new LineSplitter((l) => out.push(l));
  s.write('hel');
  s.write('lo\r');
  s.write('\nwor');
  s.write('ld\nlast');
  assert.deepEqual(out, ['hello', 'world']);
  s.flush();
  assert.deepEqual(out, ['hello', 'world', 'last']);
  s.flush();
  assert.equal(out.length, 3);
});

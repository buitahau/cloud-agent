// Covers: src/secrets.js — key parsing/ring, AES-256-GCM round trip, tamper/move/wrong-key failures, rotation
// helpers, no plaintext in errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import util from 'node:util';
import { openDb, closeDb } from '../src/db.js';
import { migrate } from '../src/db/migrations.js';
import {
  ALG, IV_BYTES, TAG_BYTES, SecretDecryptError, decodeMasterKey, parseKeyRingEnv, deriveKeyId, createKeyRing,
  originOf, buildAad, makeHint, encryptSecret, decryptSecret, needsRotation, reencryptSecret,
} from '../src/secrets.js';

const K1 = crypto.randomBytes(32);
const K2 = crypto.randomBytes(32);
const B1 = K1.toString('base64');
const B2 = K2.toString('base64');
const ring = createKeyRing(K1);
const AAD = Object.freeze({ repoId: 'web', name: 'token', origin: 'https://github.com' });
const PLAIN = 'ghp_SuperSecret1234567890';

/** @type {Error[]} every error captured by errOf, checked for leaks at the end */
const seen = [];
function errOf(fn) {
  try {
    fn();
  } catch (err) {
    seen.push(err);
    return err;
  }
  assert.fail('expected a throw');
}
const reasonOf = (fn) => {
  const err = errOf(fn);
  assert.ok(err instanceof SecretDecryptError, `expected SecretDecryptError, got ${err?.name}`);
  return err.reason;
};

test('key id is pinned and derived from the master key', () => {
  assert.equal(deriveKeyId(Buffer.alloc(32)), '5942ffd0bf6f45bd');
  assert.equal(ring.currentKeyId, deriveKeyId(K1));
  assert.match(ring.currentKeyId, /^[0-9a-f]{16}$/);
});

test('round trip', () => {
  assert.equal(decryptSecret(ring, encryptSecret(ring, PLAIN, AAD), AAD), PLAIN);
  const uni = 'tökén-✓-12345678';
  assert.equal(decryptSecret(ring, encryptSecret(ring, uni, AAD), AAD), uni);
});

test('encrypted shape', () => {
  const enc = encryptSecret(ring, PLAIN, AAD);
  assert.equal(enc.alg, ALG);
  assert.equal(enc.key_id, ring.currentKeyId);
  assert.equal(enc.iv.length, IV_BYTES);
  assert.equal(enc.tag.length, TAG_BYTES);
  assert.equal(enc.ciphertext.length, Buffer.byteLength(PLAIN));
  assert.equal(enc.hint, '7890');
  assert.ok(!enc.ciphertext.includes(PLAIN));
});

test('same value twice -> different iv and ciphertext', () => {
  const a = encryptSecret(ring, PLAIN, AAD);
  const b = encryptSecret(ring, PLAIN, AAD);
  assert.ok(!a.iv.equals(b.iv));
  assert.ok(!a.ciphertext.equals(b.ciphertext));
});

test('flipping any byte of iv/ciphertext/tag -> auth-failed', () => {
  const enc = encryptSecret(ring, PLAIN, AAD);
  for (const field of ['iv', 'ciphertext', 'tag']) {
    for (let i = 0; i < enc[field].length; i++) {
      const copy = Buffer.from(enc[field]);
      copy[i] ^= 0x01;
      assert.equal(reasonOf(() => decryptSecret(ring, { ...enc, [field]: copy }, AAD)), 'auth-failed', `${field}[${i}]`);
    }
  }
});

test('truncated or mistyped fields -> malformed', () => {
  const enc = encryptSecret(ring, PLAIN, AAD);
  assert.equal(reasonOf(() => decryptSecret(ring, { ...enc, tag: enc.tag.subarray(0, 15) }, AAD)), 'malformed');
  assert.equal(reasonOf(() => decryptSecret(ring, { ...enc, iv: enc.iv.subarray(0, 11) }, AAD)), 'malformed');
  assert.equal(reasonOf(() => decryptSecret(ring, { ...enc, ciphertext: enc.ciphertext.toString('hex') }, AAD)), 'malformed');
});

test('a row moved to another repo/name/origin -> auth-failed', () => {
  const enc = encryptSecret(ring, PLAIN, AAD);
  assert.equal(reasonOf(() => decryptSecret(ring, enc, { ...AAD, repoId: 'api' })), 'auth-failed');
  assert.equal(reasonOf(() => decryptSecret(ring, enc, { ...AAD, name: 'tokenx' })), 'auth-failed');
  assert.equal(reasonOf(() => decryptSecret(ring, enc, { ...AAD, origin: 'https://evil.example' })), 'auth-failed');
});

test('wrong key / unknown key / unsupported alg', () => {
  const other = encryptSecret(createKeyRing(K2), PLAIN, AAD);
  assert.equal(reasonOf(() => decryptSecret(ring, other, AAD)), 'unknown-key');
  assert.equal(reasonOf(() => decryptSecret(ring, { ...other, key_id: ring.currentKeyId }, AAD)), 'auth-failed');
  assert.equal(reasonOf(() => decryptSecret(ring, { ...other, alg: 'XYZ' }, AAD)), 'unsupported-alg');
});

test('previous key decrypts; rotation re-encrypts with the current key', () => {
  const old = encryptSecret(ring, PLAIN, AAD);
  const r2 = createKeyRing(K2, [K1]);
  assert.deepEqual([...r2.keyIds], [deriveKeyId(K2), deriveKeyId(K1)]);
  assert.ok(r2.has(deriveKeyId(K1)));
  assert.equal(decryptSecret(r2, old, AAD), PLAIN);
  assert.equal(needsRotation(r2, old), true);
  const re = reencryptSecret(r2, old, AAD);
  assert.equal(re.key_id, r2.currentKeyId);
  assert.equal(needsRotation(r2, re), false);
  assert.ok(!re.iv.equals(old.iv));
  assert.equal(re.hint, old.hint);
  assert.equal(decryptSecret(r2, re, AAD), PLAIN);
  assert.equal(needsRotation(r2, { ...re, alg: 'OLD' }), true);
});

test('decodeMasterKey', () => {
  const ok = decodeMasterKey(B1);
  assert.equal(ok.ok, true);
  assert.ok(ok.key.equals(K1));
  const zeros = decodeMasterKey('A'.repeat(43) + '=');
  assert.equal(zeros.ok, true);
  assert.ok(zeros.key.equals(Buffer.alloc(32)));
  const bad = [
    crypto.randomBytes(31).toString('base64'),
    crypto.randomBytes(33).toString('base64'),
    'not base64!!',
    '',
    42,
    ` ${B1} `,
    'A'.repeat(42) + 'B=',
  ];
  for (const raw of bad) {
    const r = decodeMasterKey(raw);
    assert.equal(r.ok, false, String(raw));
    assert.match(r.error, /^MASTER_KEY must be base64 that decodes to exactly 32 bytes/);
  }
});

test('parseKeyRingEnv', () => {
  const base = { masterKey: B1, masterKeyPrevious: null, apiKey: null, adminPassword: null };
  const all = [];
  const parse = (over) => {
    const r = parseKeyRingEnv({ ...base, ...over });
    all.push(...r.problems);
    return r;
  };

  const valid = parse({});
  assert.deepEqual(valid.problems, []);
  assert.equal(valid.keyRing.currentKeyId, deriveKeyId(K1));

  assert.deepEqual(parse({ masterKey: null }), { keyRing: null, problems: [] });
  assert.deepEqual(parse({ apiKey: B1 }).problems, ['MASTER_KEY must differ from API_KEY']);
  assert.deepEqual(parse({ adminPassword: B1 }).problems, ['MASTER_KEY must differ from ADMIN_PASSWORD']);
  assert.deepEqual(parse({ masterKey: null, masterKeyPrevious: B2 }), {
    keyRing: null, problems: ['MASTER_KEY_PREVIOUS is set but MASTER_KEY is not'],
  });

  const badEntry = parse({ masterKeyPrevious: `${B2}, bad` });
  assert.equal(badEntry.keyRing, null);
  assert.equal(badEntry.problems.length, 1);
  assert.match(badEntry.problems[0], /^MASTER_KEY_PREVIOUS entry 2 must be base64/);

  const trailing = parse({ masterKeyPrevious: `${B2},` });
  assert.deepEqual(trailing.problems, []);
  assert.equal(trailing.keyRing.keyIds.length, 2);

  const dup = parse({ masterKeyPrevious: `${B2},${B2}` });
  assert.deepEqual(dup.problems, []);
  assert.equal(dup.keyRing.keyIds.length, 2);

  assert.deepEqual(parse({ masterKeyPrevious: B1 }).problems, ['MASTER_KEY_PREVIOUS entry 1 equals MASTER_KEY']);

  for (const p of all) {
    assert.ok(!p.includes(B1) && !p.includes(B2) && !p.includes('bad'), p);
  }
});

test('createKeyRing validates keys and never exposes key bytes', () => {
  assert.throws(() => createKeyRing(crypto.randomBytes(31)), TypeError);
  assert.throws(() => createKeyRing(K1, ['nope']), TypeError);
  assert.ok(Object.isFrozen(ring));
  assert.ok(Object.isFrozen(ring.keyIds));
  const subkey = Buffer.from(crypto.hkdfSync('sha256', K1, '', 'cloud-agent/repo-secrets/v1', 32)).toString('hex');
  for (const shown of [JSON.stringify(ring), util.inspect(ring, { depth: 5, showHidden: true })]) {
    assert.ok(!shown.includes(K1.toString('hex')));
    assert.ok(!shown.includes(B1));
    assert.ok(!shown.includes(subkey));
  }
});

test('buildAad and originOf', () => {
  assert.equal(buildAad(AAD).toString('utf8'), 'cloud-agent|v1|repo_secrets|web|token|https://github.com');
  const pipe = errOf(() => buildAad({ ...AAD, repoId: 'we|b-secretvalue' }));
  assert.ok(pipe instanceof TypeError);
  assert.ok(!pipe.message.includes('secretvalue'));
  assert.throws(() => buildAad({ ...AAD, name: '' }), TypeError);

  assert.equal(originOf('https://x:y@GitHub.com:443/o/r.git'), 'https://github.com');
  assert.equal(originOf('https://git.example.com:8443/o/r.git'), 'https://git.example.com:8443');
  assert.throws(() => originOf('ssh://git@github.com/o/r.git'), TypeError);
  assert.throws(() => originOf('/srv/git/r.git'), TypeError);
});

test('makeHint and encrypt input validation', () => {
  assert.equal(makeHint('abcdefgh1234'), '1234');
  assert.equal(makeHint('12345678'), '5678');
  assert.equal(makeHint('1234567'), '');
  assert.equal(encryptSecret(ring, 'short', AAD).hint, '');
  assert.ok(errOf(() => encryptSecret(ring, '', AAD)) instanceof TypeError);
  assert.ok(errOf(() => encryptSecret(ring, 123, AAD)) instanceof TypeError);
  assert.ok(errOf(() => encryptSecret({ currentKeyId: ring.currentKeyId }, PLAIN, AAD)) instanceof TypeError);
});

test('no error message or stack contains secret material', () => {
  const enc = encryptSecret(ring, PLAIN, AAD);
  errOf(() => decryptSecret(createKeyRing(K2), enc, AAD));
  errOf(() => decryptSecret(ring, { ...enc, tag: Buffer.alloc(16) }, AAD));
  errOf(() => decryptSecret(ring, { ...enc, alg: PLAIN }, AAD));
  errOf(() => decryptSecret(ring, { ...enc, key_id: PLAIN }, AAD));
  errOf(() => encryptSecret(ring, PLAIN, { ...AAD, origin: `x|${PLAIN}` }));
  assert.ok(seen.length > 10);
  for (const err of seen) {
    for (const s of [err.message, String(err.stack)]) {
      assert.ok(!s.includes(PLAIN) && !s.includes(B1) && !s.includes(B2), s);
    }
  }
});

test('DB integration: store and read back an encrypted secret', () => {
  const db = openDb(':memory:');
  try {
    migrate(db);
    const now = new Date().toISOString();
    db.prepare('INSERT INTO repos (id, url, kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('web', 'https://github.com/o/web.git', 'https', now, now);
    const enc = encryptSecret(ring, PLAIN, AAD);
    db.prepare(
      `INSERT INTO repo_secrets (repo_id, name, alg, key_id, iv, ciphertext, tag, hint, updated_at)
       VALUES (:repo_id, :name, :alg, :key_id, :iv, :ciphertext, :tag, :hint, :updated_at)`,
    ).run({ repo_id: 'web', name: 'token', ...enc, updated_at: now });
    const row = db.prepare('SELECT * FROM repo_secrets WHERE repo_id = ? AND name = ?').get('web', 'token');
    assert.ok(row.iv instanceof Uint8Array);
    assert.equal(row.hint, '7890');
    assert.equal(decryptSecret(ring, row, { repoId: row.repo_id, name: row.name, origin: originOf('https://github.com/o/web.git') }), PLAIN);
  } finally { closeDb(db); }
});

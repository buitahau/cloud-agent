// src/secrets.js
// Encryption of per-repo secrets at rest: master key parsing, key ring (MASTER_KEY + MASTER_KEY_PREVIOUS),
// HKDF subkey, AES-256-GCM bound to repo/name/origin via AAD. Pure, node:crypto only. Never puts secret
// values (plaintext, keys, ciphertext) in error messages.

import crypto from 'node:crypto';

export const ALG = 'A256GCM';
export const KEY_BYTES = 32;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;
/** Tokens shorter than this get no hint. */
export const MIN_HINT_LENGTH = 8;

const KID_INFO = 'cloud-agent/kid';
const HKDF_INFO = 'cloud-agent/repo-secrets/v1';
const AAD_PREFIX = 'cloud-agent|v1|repo_secrets';
const KEY_FORMAT = `must be base64 that decodes to exactly ${KEY_BYTES} bytes (generate one with: openssl rand -base64 32)`;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** keyRing -> Map<kid, subkey Buffer>; kept outside the object so console.log/JSON never shows key bytes. */
const SUBKEYS = new WeakMap();

/**
 * @typedef {Object} KeyRing
 * @property {string} currentKeyId          key id of MASTER_KEY; new secrets are encrypted with it
 * @property {ReadonlyArray<string>} keyIds all usable key ids, current first
 * @property {(kid: string) => boolean} has whether a row with this key_id can be decrypted
 */

/**
 * @typedef {Object} AadParts
 * @property {string} repoId
 * @property {string} name    secret name, e.g. 'token'
 * @property {string} origin  https origin the secret is for (see originOf)
 */

/**
 * @typedef {Object} EncryptedSecret  snake_case keys matching the repo_secrets columns
 * @property {'A256GCM'} alg
 * @property {string} key_id
 * @property {Buffer} iv
 * @property {Buffer} ciphertext
 * @property {Buffer} tag
 * @property {string} hint  last 4 chars, or '' for short values
 */

/**
 * @typedef {Object} SecretRow  a repo_secrets row (extra columns ignored); node:sqlite returns BLOBs as Uint8Array
 * @property {string} alg
 * @property {string} key_id
 * @property {Uint8Array} iv
 * @property {Uint8Array} ciphertext
 * @property {Uint8Array} tag
 */

/** Thrown when a stored secret cannot be decrypted. Message never contains secret material. */
export class SecretDecryptError extends Error {
  /**
   * @param {'unsupported-alg'|'unknown-key'|'malformed'|'auth-failed'} reason
   * @param {string} message
   */
  constructor(reason, message) {
    super(`secret cannot be decrypted: ${message}`);
    this.name = 'SecretDecryptError';
    this.reason = reason;
  }
}

/**
 * Strictly decode a base64 master key (canonical, padded, exactly 32 bytes).
 * @param {unknown} raw
 * @param {string} [name]  env var name used in the error
 * @returns {{ ok: true, key: Buffer } | { ok: false, error: string }}
 */
export function decodeMasterKey(raw, name = 'MASTER_KEY') {
  const error = `${name} ${KEY_FORMAT}`;
  if (typeof raw !== 'string' || !BASE64_RE.test(raw) || raw.length % 4 !== 0) return { ok: false, error };
  const key = Buffer.from(raw, 'base64');
  if (key.toString('base64') !== raw || key.length !== KEY_BYTES) return { ok: false, error };
  return { ok: true, key };
}

/**
 * Build the key ring from env values. Collects every problem; any problem -> keyRing null.
 * @param {{ masterKey: string|null, masterKeyPrevious: string|null, apiKey?: string|null, adminPassword?: string|null }} env
 *   trimmed strings, or null when unset
 * @returns {{ keyRing: KeyRing|null, problems: string[] }}
 */
export function parseKeyRingEnv({ masterKey, masterKeyPrevious, apiKey = null, adminPassword = null }) {
  /** @type {string[]} */
  const problems = [];
  if (masterKey === null || masterKey === undefined) {
    if (masterKeyPrevious !== null && masterKeyPrevious !== undefined) {
      problems.push('MASTER_KEY_PREVIOUS is set but MASTER_KEY is not');
    }
    return { keyRing: null, problems };
  }

  const cur = decodeMasterKey(masterKey);
  if (!cur.ok) problems.push(cur.error);
  if (apiKey != null && masterKey === apiKey) problems.push('MASTER_KEY must differ from API_KEY');
  if (adminPassword != null && masterKey === adminPassword) problems.push('MASTER_KEY must differ from ADMIN_PASSWORD');

  /** @type {Buffer[]} */
  const previous = [];
  const seen = new Set();
  const entries = (masterKeyPrevious ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  entries.forEach((entry, idx) => {
    const label = `MASTER_KEY_PREVIOUS entry ${idx + 1}`;
    if (seen.has(entry)) return;
    seen.add(entry);
    const dec = decodeMasterKey(entry, label);
    if (!dec.ok) problems.push(dec.error);
    if (entry === masterKey) problems.push(`${label} equals MASTER_KEY`);
    if (apiKey != null && entry === apiKey) problems.push(`${label} must differ from API_KEY`);
    if (adminPassword != null && entry === adminPassword) problems.push(`${label} must differ from ADMIN_PASSWORD`);
    if (dec.ok) previous.push(dec.key);
  });

  if (problems.length > 0) return { keyRing: null, problems };
  return { keyRing: createKeyRing(/** @type {Buffer} */ (cur.ok && cur.key), previous), problems };
}

/**
 * Public, non-secret identifier of a master key (stored in repo_secrets.key_id).
 * @param {Uint8Array} key
 * @returns {string} 16 hex chars
 */
export function deriveKeyId(key) {
  return crypto.createHmac('sha256', key).update(KID_INFO).digest('hex').slice(0, 16);
}

/**
 * @param {unknown} key
 * @returns {key is Uint8Array}
 */
function isMasterKey(key) {
  return key instanceof Uint8Array && key.length === KEY_BYTES;
}

/**
 * Build a key ring. Subkeys are HKDF-derived and kept in a private WeakMap, never on the returned object.
 * @param {Uint8Array} current  MASTER_KEY bytes
 * @param {Uint8Array[]} [previous]  MASTER_KEY_PREVIOUS bytes (decrypt only)
 * @returns {KeyRing}
 * @throws {TypeError} if a key is not 32 bytes
 */
export function createKeyRing(current, previous = []) {
  /** @type {Map<string, Buffer>} */
  const map = new Map();
  for (const key of [current, ...previous]) {
    if (!isMasterKey(key)) throw new TypeError('master key must be 32 bytes');
    const kid = deriveKeyId(key);
    if (map.has(kid)) continue;
    map.set(kid, Buffer.from(crypto.hkdfSync('sha256', key, '', HKDF_INFO, KEY_BYTES)));
  }
  const keyIds = Object.freeze([...map.keys()]);
  const ring = Object.freeze({ currentKeyId: keyIds[0], keyIds, has: (kid) => map.has(kid) });
  SUBKEYS.set(ring, map);
  return ring;
}

/**
 * Origin a secret is bound to (credentials and default port stripped).
 * @param {string} url
 * @returns {string}
 * @throws {TypeError} if the URL is not https
 */
export function originOf(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new TypeError('secrets are bound to an https origin');
  }
  if (u.protocol !== 'https:') throw new TypeError('secrets are bound to an https origin');
  return u.origin;
}

/**
 * Additional authenticated data: a row only decrypts for the same repo, secret name and origin.
 * @param {AadParts} parts
 * @returns {Buffer}
 * @throws {TypeError} if a part is not a non-empty string without '|'
 */
export function buildAad(parts) {
  for (const k of /** @type {const} */ (['repoId', 'name', 'origin'])) {
    const v = parts?.[k];
    if (typeof v !== 'string' || v.length === 0 || v.includes('|')) throw new TypeError(`invalid AAD part: ${k}`);
  }
  return Buffer.from(`${AAD_PREFIX}|${parts.repoId}|${parts.name}|${parts.origin}`, 'utf8');
}

/**
 * Display hint: last 4 chars, only for values of at least MIN_HINT_LENGTH chars.
 * @param {string} plaintext
 * @returns {string}
 */
export function makeHint(plaintext) {
  return plaintext.length >= MIN_HINT_LENGTH ? plaintext.slice(-4) : '';
}

/**
 * Encrypt with the current key (AES-256-GCM, random 96-bit IV).
 * @param {KeyRing} keyRing
 * @param {string} plaintext
 * @param {AadParts} aadParts
 * @returns {EncryptedSecret}
 * @throws {TypeError} on bad input
 */
export function encryptSecret(keyRing, plaintext, aadParts) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) throw new TypeError('secret must be a non-empty string');
  const key = SUBKEYS.get(keyRing)?.get(keyRing.currentKeyId);
  if (!key) throw new TypeError('keyRing must come from createKeyRing()');
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(buildAad(aadParts));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { alg: ALG, key_id: keyRing.currentKeyId, iv, ciphertext, tag: cipher.getAuthTag(), hint: makeHint(plaintext) };
}

/**
 * Decrypt a stored row.
 * @param {KeyRing} keyRing
 * @param {SecretRow} row
 * @param {AadParts} aadParts
 * @returns {string}
 * @throws {SecretDecryptError} reason 'unsupported-alg' | 'unknown-key' | 'malformed' | 'auth-failed'
 * @throws {TypeError} on bad AAD parts
 */
export function decryptSecret(keyRing, row, aadParts) {
  if (row?.alg !== ALG) {
    throw new SecretDecryptError('unsupported-alg', `unsupported algorithm "${String(row?.alg).slice(0, 20)}"`);
  }
  const key = SUBKEYS.get(keyRing)?.get(row.key_id);
  if (!key) {
    throw new SecretDecryptError(
      'unknown-key',
      `key id ${String(row.key_id).slice(0, 16)} is not MASTER_KEY or in MASTER_KEY_PREVIOUS`,
    );
  }
  const isBytes = (b, n) => b instanceof Uint8Array && (n === undefined || b.length === n);
  if (!isBytes(row.iv, IV_BYTES) || !isBytes(row.tag, TAG_BYTES) || !isBytes(row.ciphertext)) {
    throw new SecretDecryptError('malformed', 'iv, tag or ciphertext has the wrong type or length');
  }
  const aad = buildAad(aadParts);
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, row.iv, { authTagLength: TAG_BYTES });
    d.setAAD(aad);
    d.setAuthTag(row.tag);
    return Buffer.concat([d.update(row.ciphertext), d.final()]).toString('utf8');
  } catch {
    throw new SecretDecryptError(
      'auth-failed',
      'authentication failed (wrong key, or the row was altered or belongs to another repo/secret/origin)',
    );
  }
}

/**
 * @param {KeyRing} keyRing
 * @param {{ alg: string, key_id: string }} row
 * @returns {boolean} true if the row is not encrypted with the current key/algorithm
 */
export function needsRotation(keyRing, row) {
  return row.alg !== ALG || row.key_id !== keyRing.currentKeyId;
}

/**
 * Decrypt with whichever ring key matches, re-encrypt with the current key (new IV).
 * @param {KeyRing} keyRing
 * @param {SecretRow} row
 * @param {AadParts} aadParts
 * @returns {EncryptedSecret}
 * @throws {SecretDecryptError}
 */
export function reencryptSecret(keyRing, row, aadParts) {
  return encryptSecret(keyRing, decryptSecret(keyRing, row, aadParts), aadParts);
}

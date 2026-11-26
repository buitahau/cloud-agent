// src/lib/secretEnv.js
// Service secrets that must never reach child processes (claude runs with bypassed permissions inside an
// untrusted repo; git may run hooks planted in a persistent workspace). Pure; never mutates its input.

/** Exact names always removed. MASTER_KEY* are reserved for the encrypted repo store (PR 1+). */
export const SECRET_ENV_VARS = Object.freeze(['API_KEY', 'ADMIN_PASSWORD', 'MASTER_KEY', 'MASTER_KEY_PREVIOUS', 'GIT_TOKEN']);
/** Any per-repo token following the documented naming convention (also leftovers of removed repos). */
export const SECRET_ENV_PATTERN = /^GIT_TOKEN_/;

/**
 * Copy of baseEnv without SECRET_ENV_VARS, names matching SECRET_ENV_PATTERN, and extraNames
 * (the configured repos' auth.tokenEnv names, which may be arbitrary).
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {Iterable<string>} [extraNames=[]]
 * @returns {NodeJS.ProcessEnv}
 */
export function withoutSecrets(baseEnv, extraNames = []) {
  const extra = new Set(extraNames);
  /** @type {NodeJS.ProcessEnv} */
  const env = {};
  for (const [k, v] of Object.entries(baseEnv)) {
    if (SECRET_ENV_VARS.includes(k) || SECRET_ENV_PATTERN.test(k) || extra.has(k)) continue;
    env[k] = v;
  }
  return env;
}

#!/usr/bin/env node
// test-support/fake-claude.js — stand-in for the `claude` CLI in tests (set CLAUDE_BIN / claudeBin to this path).
// Lives outside test/ because Node 18's `node --test test/` executes EVERY .js file under a dir named "test".
// This file is COMPLETE (not a stub) — it is part of the test contract. Mirrors claude 2.1.x output shapes.
//
// Supported invocations:
//   fake-claude --version                      -> "0.0.0-fake (Claude Code)", exit 0
//   fake-claude auth status --json             -> {"loggedIn":true,"authMethod":"claude.ai",...}, exit 0
//                                                 FAKE_CLAUDE_AUTH=logged_out -> loggedIn:false, exit 1
//                                                 FAKE_CLAUDE_AUTH=api_key -> loggedIn:true, authMethod "api_key", exit 0
//   fake-claude -p [flags...]  (prompt on stdin, or as last positional arg)
//
// -p behaviour is chosen by a directive in the prompt "[[fake:<mode>]]" or else env FAKE_CLAUDE_MODE (default "success"):
//   success          result = "echo: <prompt>", exit 0
//   cat=<relpath>    result = contents of <cwd>/<relpath> (T5: "[[fake:cat=MARKER.txt]]"), exit 0; missing file -> error
//   error            is_error:true, subtype "error_during_execution", exit 1
//   max_turns        is_error:true, subtype "error_max_turns", exit 1
//   garbage          non-JSON on stdout, "boom" on stderr, exit 2
//   stderr           3 lines on stderr ("fake stderr line 1..3"), then success
//   sleep=<sec>      spawns a grandchild `sleep <sec>` (same process group), writes "<selfPid> <grandchildPid>"
//                    to $FAKE_CLAUDE_PIDFILE if set, waits for it, then success. Used for T10 tree-kill.
//   junk             creates junk.txt, junkdir/a.txt, node_modules/keep.txt in cwd and modifies a tracked
//                    file README.md (appends a line) if present, then success. Used for T12.
//   pwd              result = process.cwd()
//   stream           (with --output-format stream-json) prints the event lines ONE BY ONE with ~150ms gaps,
//                    so tests can observe live SSE delivery; then the result line.
// With `--output-format stream-json` every mode prints NDJSON: system/init, assistant (thinking + text + tool_use),
// user (tool_result), then the result line. With `--output-format json` (auth probe) only the result object.
// FAKE_CLAUDE_AUTH=invalid makes every -p call return the real 401 shape (is_error:true, exit 1) — T1.
// If $FAKE_CLAUDE_RECORD is set, appends one JSON line per invocation:
//   { argv, cwd, stdin, env: { CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, CLAUDECODE } }   (values or null)

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);

function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function record(stdin) {
  const file = process.env.FAKE_CLAUDE_RECORD;
  if (!file) return;
  const pick = (k) => (process.env[k] === undefined ? null : process.env[k]);
  fs.appendFileSync(file, JSON.stringify({
    argv,
    cwd: process.cwd(),
    stdin,
    env: {
      CLAUDE_CODE_OAUTH_TOKEN: pick('CLAUDE_CODE_OAUTH_TOKEN'),
      ANTHROPIC_API_KEY: pick('ANTHROPIC_API_KEY'),
      CLAUDECODE: pick('CLAUDECODE'),
    },
  }) + '\n');
}

const STREAM = argv.includes('stream-json');
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const line = (o) => process.stdout.write(JSON.stringify(o) + '\n');

/** The intermediate stream-json lines (everything except the final result). */
function streamLines(prompt) {
  return [
    { type: 'system', subtype: 'init', session_id: '00000000-0000-4000-8000-000000000000', model: 'fake-model', tools: ['Bash', 'Read'] },
    { type: 'assistant', message: { content: [
      { type: 'thinking', thinking: 'I should look at the repo first.' },
      { type: 'text', text: `Working on: ${String(prompt).slice(0, 80)}` },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
    ] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'README.md\n' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done looking.' }] } },
  ];
}

function emit(obj, code) {
  if (STREAM && !emit.skipPrelude) for (const l of streamLines(emit.prompt)) line(l);
  const full = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 5,
    num_turns: 1,
    session_id: '00000000-0000-4000-8000-000000000000',
    total_cost_usd: 0,
    ...obj,
  };
  process.stdout.write(STREAM ? JSON.stringify(full) + '\n' : JSON.stringify(full));
  process.exitCode = code;
}

async function runPrint() {
  // Prompt: stdin, else last positional arg that isn't a flag value.
  let prompt = await readStdin();
  if (!prompt.trim()) {
    const last = argv[argv.length - 1];
    if (last && !last.startsWith('-')) prompt = last;
  }
  record(prompt);
  emit.prompt = prompt;

  if (process.env.FAKE_CLAUDE_AUTH === 'invalid') {
    return emit({
      subtype: 'success',
      is_error: true,
      api_error_status: 401,
      result: 'Failed to authenticate. API Error: 401 OAuth access token is invalid.',
    }, 1);
  }

  const m = /\[\[fake:([^\]]+)\]\]/.exec(prompt);
  const directive = m ? m[1] : (process.env.FAKE_CLAUDE_MODE || 'success');
  const [mode, arg] = directive.split('=');

  switch (mode) {
    case 'success':
      return emit({ result: `echo: ${prompt}` }, 0);
    case 'stream': {
      for (const l of streamLines(prompt)) { line(l); await sleepMs(150); }
      emit.skipPrelude = true;
      return emit({ result: `streamed: ${prompt}` }, 0);
    }
    case 'pwd':
      return emit({ result: process.cwd() }, 0);
    case 'cat': {
      const p = path.join(process.cwd(), arg || '');
      if (!fs.existsSync(p)) return emit({ subtype: 'error_during_execution', is_error: true, result: `no such file: ${arg}` }, 1);
      return emit({ result: fs.readFileSync(p, 'utf8') }, 0);
    }
    case 'error':
      return emit({ subtype: 'error_during_execution', is_error: true, result: 'fake failure: e2e tests failed' }, 1);
    case 'max_turns':
      return emit({ subtype: 'error_max_turns', is_error: true, num_turns: 50 }, 1);
    case 'garbage':
      process.stdout.write('this is not json\nstill not json\n');
      process.stderr.write('boom\n');
      process.exitCode = 2;
      return undefined;
    case 'stderr':
      process.stderr.write('fake stderr line 1\nfake stderr line 2\nfake stderr line 3\n');
      return emit({ result: `echo: ${prompt}` }, 0);
    case 'junk': {
      const cwd = process.cwd();
      fs.writeFileSync(path.join(cwd, 'junk.txt'), 'junk\n');
      fs.mkdirSync(path.join(cwd, 'junkdir'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'junkdir', 'a.txt'), 'junk\n');
      fs.mkdirSync(path.join(cwd, 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(cwd, 'node_modules', 'keep.txt'), 'kept by clean -e node_modules\n');
      const readme = path.join(cwd, 'README.md');
      if (fs.existsSync(readme)) fs.appendFileSync(readme, 'dirty change\n');
      return emit({ result: 'made junk' }, 0);
    }
    case 'sleep': {
      const secs = Number(arg || '30');
      const child = spawn('sleep', [String(secs)], { stdio: 'ignore' });
      if (process.env.FAKE_CLAUDE_PIDFILE) {
        fs.writeFileSync(process.env.FAKE_CLAUDE_PIDFILE, `${process.pid} ${child.pid}`);
      }
      await new Promise((resolve) => child.on('exit', resolve));
      return emit({ result: `slept ${secs}s` }, 0);
    }
    default:
      return emit({ subtype: 'error_during_execution', is_error: true, result: `unknown fake mode: ${mode}` }, 1);
  }
}

async function main() {
  if (argv[0] === '--version') {
    process.stdout.write('0.0.0-fake (Claude Code)\n');
    return;
  }
  if (argv[0] === 'auth' && argv[1] === 'status') {
    record('');
    if (process.env.FAKE_CLAUDE_AUTH === 'logged_out') {
      process.stdout.write(JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }, null, 2) + '\n');
      process.exitCode = 1;
      return;
    }
    const authMethod = process.env.FAKE_CLAUDE_AUTH === 'api_key' ? 'api_key' : 'claude.ai';
    process.stdout.write(JSON.stringify({ loggedIn: true, authMethod, apiProvider: 'firstParty' }, null, 2) + '\n');
    return;
  }
  if (argv.includes('-p') || argv.includes('--print')) {
    await runPrint();
    return;
  }
  process.stderr.write(`fake-claude: unsupported invocation: ${argv.join(' ')}\n`);
  process.exitCode = 64;
}

main();

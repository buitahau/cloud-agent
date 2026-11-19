# 10 — Claude Code integration on the laptop

**Estimate:** S · **Depends on:** 08, 09

## Goal
The laptop's Claude Code dev agent uses `cloudtest` instead of running E2E locally. It runs `cloudtest` as a background command, keeps working, and acts on the report.

## Scope
- In: a laptop-only rule file, a laptop permission allow-list entry for `cloudtest`.
- Out: an MCP wrapper, hooks.

## Steps
1. Put the rule in the target repo's **`CLAUDE.local.md`** (untracked, so the VPS agent never sees it; the VPS prompt also says `cloudtest` rules do not apply to it, task 04):
   > **E2E tests: never run Playwright locally.** Commit your change, then run `cloudtest run <project>` as a background command. Continue other work. When it finishes: exit 0 means pass; exit 1 means read the failures and fix; exit 2/3 means report the error to the user and do not retry blindly; exit 4 means fix what the message says (commit, token, push) and run again; exit 5 means run `cloudtest wait <run_id>`.
2. Allow `Bash(cloudtest:*)` in the laptop's `.claude/settings.local.json` so the background command does not prompt. Add `CLAUDE.local.md` and `.claude/settings.local.json` to the target repo's `.git/info/exclude`, so neither can be committed by `git add -A` and pushed to `agent/test`.
3. Check that the pinned laptop Claude Code version loads `CLAUDE.local.md` (ask it to quote the E2E rule in a fresh session). If it does not, move the rule into a file `@`-imported from `~/.claude/CLAUDE.md`.
4. Scenario (a **test-code** change, valid whatever the A3 answer from task 00): ask Claude Code "add an E2E assertion that page X shows heading `<wrong text>` and verify it with the E2E tests", where `<wrong text>` does not match what dev serves. Expected: it commits, runs `cloudtest`, gets FAIL, reads the report, corrects the expected text, and runs again to PASS. (An app-code change is only demonstrable once a deploy step exists, see README A3.)

## Acceptance criteria
- [ ] In a fresh Claude Code session, the agent starts `cloudtest run` without being told how: `grep -l '"run_in_background":true' ~/.claude/projects/<repo-slug>/*.jsonl` returns that session's file, and `grep -c 'npx playwright'` on the same file prints 0.
- [ ] The agent reacts to the FAIL report by changing the test and triggering a second run that passes.
- [ ] In the VPS runs of this task, `transcript.jsonl` contains no `Bash` call mentioning `cloudtest`, and task 04's hand-run checks (`agent_line_ok`, exactly one suite call) still hold for both runs.
- [ ] For every SHA run in this task, `git ls-tree -r <sha> --name-only | grep -c 'CLAUDE.local.md'` prints 0.

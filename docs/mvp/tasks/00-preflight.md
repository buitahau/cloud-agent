# 00 — Pre-flight: A3 answer and dev reachability

**Estimate:** S (≤ 1 h) · **Depends on:** none · If [task 00b](00b-local-smoke.md) was done, step 1 is already answered; only step 2 remains.

## Goal
Answer the two questions that can end the project before any setup work: is a test against what dev currently serves meaningful (A3), and can the VPS reach dev at all (A1, first look)?

## Scope
- In: a written A3 answer, one `curl` from the VPS.
- Out: Node, Playwright, the clone, the `cloudtest` user (task 01 onwards). The full suite run stays in task 02.

## Steps
1. Answer **A3** in writing (the repo owner is the user): do the E2E tests target what dev currently serves, or must the branch be deployed to dev first? Known input: dev is deployed only by `deploy-dev` on merges into `dev-v2` (target repo `docs/infra/dev-environment.md`), so a pushed `agent/test` is never deployed, and the suite tests the SHA's **test code** against the app dev serves. If the answer is "deploy first", the MVP still proves the plumbing, but the demo (task 10, README §3.6) exercises **test-code changes only**, and a deploy step is the first post-MVP task.
2. On the VPS (any user, plain image is enough): `curl -sS -o /dev/null -w '%{http_code}\n' "$E2E_BASE_URL/api/health"` (the dev URL `https://sweetmemories-dev.<account>.workers.dev`) and the same for any other host the tests use. Record the codes and the VPS public IP.

## Acceptance criteria
- [ ] `docs/mvp/findings/00-preflight.md` records the A3 answer and its consequence for the demo.
- [ ] Every dev host the suite uses returns 2xx/3xx from the VPS, or the blocker (IP allow-list, VPN) is recorded with an owner.

## Exit / stop condition
If dev is unreachable and the VPS cannot be allow-listed or put on the VPN, **stop** before task 01. The design has to change (e.g. a runner inside the network).

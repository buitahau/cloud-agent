# 01 — VPS provisioning

**Estimate:** M (Tailscale, the Claude login, the Python venv and the Playwright system packages rarely fit in 2 h) · **Depends on:** 00

## Goal
Get a VPS that is ready to run headless Chromium and Claude Code, that the laptop can reach privately, and that has a dedicated `cloudtest` user. Test the core of A2 (headless `claude -p` from a service context) on day one.

## Scope
- In: OS packages, Node 24, pnpm, Python 3 with venv, the shared E2E venv with Playwright Python and the Chromium system deps, git, the `cloudtest` user and SSH access to it, Tailscale, a pinned Claude Code, a sizing check, a hello-world headless run.
- Out: the app itself, systemd units (task 08), any repo checkout (task 02).

## Steps
1. Check the VPS size: `nproc`, `free -g`, `df -h`. Target ≥ 4 vCPU, ≥ 8 GB RAM, ≥ 20 GB free disk. Record the numbers.
2. Install git, curl, jq, `time` (for `/usr/bin/time`, task 02), `rsync` (deploy, task 05), `python3` and `python3-venv`, and Node 24 from NodeSource (`/usr/bin/node`; the only install path, see README §2; the target repo requires `>=24 <25`). Then, as root, `corepack enable` (puts the `pnpm` shim in `/usr/bin`).
3. Create the user: `useradd -m -s /bin/bash cloudtest`. Create `/var/lib/cloudtest` and `/var/lib/cloudtest/{runs,repo}`, all owned by `cloudtest` (the runner creates `run.lock` directly under `/var/lib/cloudtest`, task 05). Create `/etc/cloudtest/` owned `root:cloudtest`, mode `0750`. Create `/opt/cloudtest` owned by `cloudtest` (deploy target, used from task 05).
4. Build the shared E2E venv as `cloudtest`: `python3 -m venv /var/lib/cloudtest/venv-e2e && /var/lib/cloudtest/venv-e2e/bin/pip install playwright==<v> pytest==<v> pyyaml==<v> axe-playwright-python==<v>` (the package list from the target repo's `e2e/README.md`; the versions from the task 00b `pip freeze`, or the latest, recorded; the repo pins none). Do not install `pytest-timeout` (task 05 timeout drill). Then, as root, install the Chromium system packages once with that venv's Playwright: `/var/lib/cloudtest/venv-e2e/bin/playwright install-deps chromium` (the system-deps half of `install --with-deps`; the browser itself is installed as `cloudtest` in task 02, so it lands in `~cloudtest/.cache/ms-playwright`). Finally pin pnpm for `cloudtest`: `sudo -iu cloudtest corepack prepare pnpm@<packageManager version> --activate` (the version in the target repo's `package.json`, e.g. `10.33.0`).
5. Install Tailscale and join the tailnet. Note the VPS tailnet IP/hostname (e.g. `cloudtest-vps`). Give the laptop SSH access as `cloudtest` (authorized key in `~cloudtest/.ssh/authorized_keys`, or Tailscale SSH). If Tailscale SSH is used and task 06 AC 3 (run survives an SSH drop) fails, switch to OpenSSH with an authorized key.
6. Install a **fixed** Claude Code version as root: `sudo npm i -g @anthropic-ai/claude-code@<x.y.z>` (lands in `/usr/bin/claude`, root-owned, so `cloudtest` cannot update it). Also disable auto-update (`DISABLE_AUTOUPDATER=1` in `~cloudtest/.profile` and later in the unit, task 08). Log in as `cloudtest` (`sudo -iu cloudtest claude`, then `/login`). Make sure `ANTHROPIC_API_KEY` is not set in any profile file.
7. Hello-world headless check (A2 core): `systemd-run --uid=cloudtest --pipe --wait -p Environment=HOME=/home/cloudtest claude -p "say ok" --output-format json </dev/null`. Record the output and exit code.

## Acceptance criteria
- [ ] `sudo -iu cloudtest node -v` prints v24.x, `sudo -iu cloudtest pnpm -v` prints the pinned pnpm without a download prompt, `/var/lib/cloudtest/venv-e2e/bin/python -c 'import playwright, pytest, yaml, axe_playwright_python'` exits 0, and `sudo -iu cloudtest claude --version` prints the pinned version.
- [ ] From the laptop, `ping cloudtest-vps` (Tailscale) and `ssh cloudtest@cloudtest-vps true` succeed. `ss -tlnp` on the VPS shows no new public listeners.
- [ ] `sudo -iu cloudtest env | grep ANTHROPIC_API_KEY` prints nothing.
- [ ] The step 7 hello-world exits 0 with `is_error == false` in the JSON output, and does not prompt.
- [ ] Sizing numbers, the Claude Code, Node, pnpm and Python versions, `pip freeze` of the venv and the hello-world output are written in `docs/mvp/findings/01-vps.md`.

## Notes
If the VPS is under 4 vCPU / 8 GB, carry on, but flag it. Task 02 shows whether it actually matters.

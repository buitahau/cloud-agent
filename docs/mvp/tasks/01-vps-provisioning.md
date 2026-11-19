# 01 — VPS provisioning

**Estimate:** M (Tailscale, the Claude login and the Playwright system packages rarely fit in 2 h) · **Depends on:** 00

## Goal
Get a VPS that is ready to run headless Chromium and Claude Code, that the laptop can reach privately, and that has a dedicated `cloudtest` user. Test the core of A2 (headless `claude -p` from a service context) on day one.

## Scope
- In: OS packages, Node 22 LTS, git, Playwright system deps, the `cloudtest` user and SSH access to it, Tailscale, a pinned Claude Code, a sizing check, a hello-world headless run.
- Out: the app itself, systemd units (task 08), any repo checkout (task 02).

## Steps
1. Check the VPS size: `nproc`, `free -g`, `df -h`. Target ≥ 4 vCPU, ≥ 8 GB RAM, ≥ 20 GB free disk. Record the numbers.
2. Install git, curl, jq, `time` (for `/usr/bin/time`, task 02), `rsync` (deploy, task 05), and Node 22 LTS from NodeSource (`/usr/bin/node`; the only install path, see README §2).
3. Create the user: `useradd -m -s /bin/bash cloudtest`. Create `/var/lib/cloudtest` and `/var/lib/cloudtest/{runs,repo}`, all owned by `cloudtest` (the runner creates `run.lock` directly under `/var/lib/cloudtest`, task 05). Create `/etc/cloudtest/` owned `root:cloudtest`, mode `0750`. Create `/opt/cloudtest` owned by `cloudtest` (deploy target, used from task 05).
4. Install the Chromium system dependencies once, as root: `npx -y playwright@<repo's version> install-deps chromium`.
5. Install Tailscale and join the tailnet. Note the VPS tailnet IP/hostname (e.g. `cloudtest-vps`). Give the laptop SSH access as `cloudtest` (authorized key in `~cloudtest/.ssh/authorized_keys`, or Tailscale SSH). If Tailscale SSH is used and task 06 AC 3 (run survives an SSH drop) fails, switch to OpenSSH with an authorized key.
6. Install a **fixed** Claude Code version as root: `sudo npm i -g @anthropic-ai/claude-code@<x.y.z>` (lands in `/usr/bin/claude`, root-owned, so `cloudtest` cannot update it). Also disable auto-update (`DISABLE_AUTOUPDATER=1` in `~cloudtest/.profile` and later in the unit, task 08). Log in as `cloudtest` (`sudo -iu cloudtest claude`, then `/login`). Make sure `ANTHROPIC_API_KEY` is not set in any profile file.
7. Hello-world headless check (A2 core): `systemd-run --uid=cloudtest --pipe --wait -p Environment=HOME=/home/cloudtest claude -p "say ok" --output-format json </dev/null`. Record the output and exit code.

## Acceptance criteria
- [ ] `sudo -iu cloudtest node -v` prints v22.x, and `sudo -iu cloudtest claude --version` prints the pinned version.
- [ ] From the laptop, `ping cloudtest-vps` (Tailscale) and `ssh cloudtest@cloudtest-vps true` succeed. `ss -tlnp` on the VPS shows no new public listeners.
- [ ] `sudo -iu cloudtest env | grep ANTHROPIC_API_KEY` prints nothing.
- [ ] The step 7 hello-world exits 0 with `is_error == false` in the JSON output, and does not prompt.
- [ ] Sizing numbers, the Claude Code version and the hello-world output are written in `docs/mvp/findings/01-vps.md`.

## Notes
If the VPS is under 4 vCPU / 8 GB, carry on, but flag it. Task 02 shows whether it actually matters.

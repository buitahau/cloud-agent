# 08 — systemd service and network binding

**Estimate:** S · **Depends on:** 05, 07

## Goal
The server runs as a managed service under `cloudtest`, can be reached only over Tailscale, and is restarted on crash. Check again that Claude auth works in the real service context (A2).

## Scope
- In: `vps/cloudtest.service`, the env file layout, the API token, a reboot test, a kill test.
- Out: TLS, reverse proxy, Cloudflare.

## Steps
1. Unit `vps/cloudtest.service`:
   - `[Unit]`: `Wants=network-online.target`, `After=tailscaled.service network-online.target`, `StartLimitIntervalSec=0` (the tailnet IP may not be assigned yet at boot; the unit retries until the bind works).
   - `[Service]`: `User=cloudtest`, `WorkingDirectory=/opt/cloudtest`, `EnvironmentFile=/etc/cloudtest/config.env`, `Environment=HOME=/home/cloudtest DISABLE_AUTOUPDATER=1`, `ExecStart=/usr/bin/node vps/server.mjs`, `Restart=always`, `RestartSec=5`, `KillMode=control-group` (a stop or crash also kills the runner, claude and Chromium; this is the only process kill on restart, task 07 step 3).
   - `[Install]`: `WantedBy=multi-user.target`.
   There is no `ANTHROPIC_API_KEY` anywhere.
2. Generate the API token: `openssl rand -hex 32 > /etc/cloudtest/api-token` (`root:cloudtest 0640`). Copy it to the laptop at `~/.config/cloudtest/token` (mode `0600`).
3. Fill `/etc/cloudtest/config.env` with the keys from README §2.1 (`BIND` = the VPS tailnet IP; leave `RUNS_DIR` and `API_TOKEN_FILE` at their defaults). Enable and start the service.
4. Read the 26 h soak result from task 03 (`/var/lib/cloudtest/soak-26h.json`) **before** the reboot in step 5.
5. Reboot the VPS and check that the service comes back once Tailscale is up.

From here on, use `cloudtest-ssh` (task 06) only while the service has no work, and do not restart the service during an SSH run: startup recovery would mark that run `worker restarted` and delete its `wt/`, and an API run started meanwhile would end `error / runner exited 75`.

## Acceptance criteria
- [ ] From the laptop, `curl http://cloudtest-vps:8787/healthz` returns `{"ok":true}`. The same request to the VPS public IP fails (connection refused or timeout).
- [ ] One real green run through the API, started with curl from the laptop, completes under systemd. This shows Claude auth works in the service context.
- [ ] `systemctl kill -s KILL cloudtest` during a real run: the service restarts, the run becomes `error / worker restarted`, and the leak check from task 05 is clean.
- [ ] After `sudo reboot`, `/healthz` answers within 2 min with no manual steps (check `journalctl -u cloudtest` shows retries, not `start-limit-hit`).
- [ ] `systemctl show cloudtest -p Environment` plus the env file show no `ANTHROPIC_API_KEY` and no GitHub token.
- [ ] The soak result (`is_error == false`, or the failure) is recorded in `findings/03-claude-headless.md`.

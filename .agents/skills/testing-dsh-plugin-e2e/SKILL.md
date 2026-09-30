---
name: testing-dsh-plugin-e2e
description: End-to-end test a dsh plugin (this repo or similar) against a released dsh runtime without building the deepseek-harness monorepo — install the published @deepseek-ai/dsh CLI via npm, add the local plugin to a profile, boot `dsh web`, and drive the browser.
---

# E2E-testing a dsh plugin against a released runtime

Avoids the expensive monorepo `pnpm install`/`pnpm dsh` source launch. The published `@deepseek-ai/dsh` npm package carries every profile bundle (dsh-base, dsh-web-app, …) plus the prebuilt web frontend (`dsh-web-frontend/dist`), so it is a complete standalone launcher.

## Devin Secrets Needed
- `DEEPSEEK_API_KEY` (optional; only for real-model regression prompts. The ACP mock-server flow needs no key.)

## Environment
- Node `~/.local/node22/bin` (not on PATH by default — `export PATH=$HOME/.local/node22/bin:$PATH`). Node ≥22.18 runs `mock-acp-server.ts` directly via type-stripping (`node <file>.ts`, no tsx needed).
- pnpm **≥10** is required by `dsh plugin` — profiles write settings into `pnpm-workspace.yaml`, which pnpm 9 ignores. Install: `npm install -g pnpm@10`.
- Chrome at `/home/ubuntu/.local/bin/google-chrome`.

## Setup (verified on this machine)
```sh
export PATH=$HOME/.local/node22/bin:$PATH
export DSH_HOME=/home/ubuntu/.dsh        # keep dsh home explicit/predictable
mkdir -p /home/ubuntu/dsh-install && cd /home/ubuntu/dsh-install
npm install @deepseek-ai/dsh@<runtime-version>   # e.g. 0.1.7-rc.1
./node_modules/.bin/dsh plugin --profile web add /abs/path/to/dsh-llm-acp
# → runs pnpm in ~/.dsh/profiles/web; a package declaring dsh.bundle.patch is
#   auto-appended to dsh.profile.bundles. `link:` spec gives a live symlink —
#   edits to the plugin's lib/ are picked up on next boot.
./node_modules/.bin/dsh web --no-open    # serves http://127.0.0.1:3080/?token=…
```
- The token query param in the printed URL is required — a bare `127.0.0.1:3080` will not authenticate.
- `./node_modules/.bin/dsh --profile web --dump-config` prints the composed plugin list — grep for the plugin id (e.g. `llm-acp`) to prove the bundle patch applied before booting.
- Source `.env`-style key files before launching if you need real models: `set -a; source /home/ubuntu/.devin-testing-env; set +a`.

## UI landmarks (web profile)
- Settings: gear icon, bottom-left of sidebar → left nav "ACP Servers" (the plugin's `settings.section` slot). Also injects `sidebar.footer.action` (shows `ACP n/n`) and a per-session `ACP Protocol` tab showing raw JSON-RPC.
- Add server: "My Servers" tab → "+ Add custom agent" → fields Server ID / Display name / Launch command / Arguments / "+ Add variable" env rows.
- Model picker: click the model chip at the right of the composer → each `acp-<id>` server appears as its own provider group.
- Removing a server makes a stale session show "This model is unavailable — select one to continue" — expected, not a bug.

## Keyless ACP server for prompt round-trips
Use the vendored fixture: `command=/home/ubuntu/.local/node22/bin/node`, `args=/home/ubuntu/repos/dsh/packages/subagent/subagent-acp/tests/mock-acp-server.ts` (needs `@agentclientprotocol/sdk` resolvable — the dsh checkout's node_modules provides it; copy the file beside the plugin's own node_modules if the checkout is absent). Env knobs: `MOCK_TEXT=<reply>` (streamed assistant text), `MOCK_STOP`, `MOCK_HANG`, `MOCK_PERMISSION`, etc. A reply equal to the chosen MOCK_TEXT proves a real initialize→session/new→prompt round-trip.

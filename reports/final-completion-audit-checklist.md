# Final Completion Audit Checklist

Use this checklist before marking Codex App Model Gateway v3 complete.

Do not accept skipped verifier modes as completion evidence. A complete pass must run without `RUN_CLAUDE_SMOKE=0` and without `RUN_SAME_THREAD_SMOKE=0`.

## Objective Mapping

| Requirement | Required evidence | Pass condition |
| --- | --- | --- |
| Single provider, no factions | `codex debug models -c model_provider='"model_gateway"'` and app-server thread evidence | GPT and Claude slugs are under `model_gateway`; no per-model Codex provider is required. |
| GPT passthrough | App-server GPT smoke in `scripts/live-verify-codex-gateway.sh` | A `gpt-5.5` turn returns the requested sentinel through a `model_gateway` thread. |
| Claude four-model live connection | `scripts/live-verify-codex-gateway.sh` Claude smoke section | `opus-4-7`, `opus-4-8`, `sonnet-4-6`, and `haiku-4-6` each return their sentinel, `response.output_item.done`, and `response.completed`. |
| Same-thread free switching and context continuity | `scripts/app-server-same-thread-smoke.js` through live verifier | One app-server thread runs `gpt-5.5 -> opus-4-7 -> opus-4-8 -> sonnet-4-6 -> haiku-4-6 -> gpt-5.5`; every Claude slug reads the verification code from the GPT turn; GPT switches back successfully. |
| Sidebar thread visibility | `scripts/post-update-check.sh` sidebar provider coherence plus UI spot-check when available | No unarchived `openai` threads remain hidden while the app is running as `model_gateway`; project sidebar still shows existing chats after refresh. |
| Large context request stability | Gateway tests and oversized request smoke | Gateway default body cap is 64MB, `GATEWAY_MAX_BODY_BYTES` is honored, and oversized requests return clean HTTP 413 instead of resetting the socket and causing reconnect loops. |
| Backend limit/auth UX | Gateway tests and live limit observation when quota is exhausted | Claude/Grok quota, session-limit, login, and OAuth errors produce visible completed assistant messages rather than streaming `response.failed` retry loops. |
| API spend policy | `/healthz.api_spend_policy`, catalog capabilities, and skill docs | Metered API fan-out is denied by default; only local non-metered, Minimax near-unlimited, or human-approved API models are allowed. |
| Claude visible replies | Gateway tests and Claude live smoke | `Claude text responses emit completed assistant message items for Codex App persistence` passes, and live Claude smoke emits completed assistant item events. |
| Tool bridge boundary | Gateway tests and healthz | Claude emits Responses `function_call`; Codex remains executor; healthz reports Claude tools as `prompt_bridge_experimental`. |
| Model-native isolation | Source inspection and tests | Claude CLI invocation uses no session persistence, empty MCP config, disabled slash commands, and disallowed native tools. |
| Default Codex config | `config.toml` inspection | Default model is `gpt-5.5`, provider is `model_gateway`, and provider has `requires_openai_auth = true`. |
| Skill handoff reproducibility | GitHub repo contents | `SKILL.md`, README, verifier scripts, diagnostics, gateway runtime, and tests are present and current. |
| GitHub hygiene | Redaction scan | No auth, token, SQLite DB, full logs, rollout dumps, private thread IDs, local absolute paths, screenshots, or app bundle reverse-engineering details are committed. |

## Required Commands

From the skill or repository root:

```bash
MODEL_GATEWAY_DIR=<gateway-dir> bash scripts/live-verify-codex-gateway.sh
```

Additional source and repo checks:

```bash
node --check scripts/app-server-same-thread-smoke.js
bash -n scripts/live-verify-codex-gateway.sh scripts/readonly-diagnose-codex-gateway.sh scripts/post-update-check.sh scripts/install-codex-gateway.sh scripts/migrate-sidebar-threads-to-gateway.sh
bash scripts/post-update-check.sh
git status --short
```

Hygiene scan:

```bash
sh scripts/security-scan.sh
```

The scan must exit successfully before publishing.

## Completion Rule

Only mark the goal complete after:

- `scripts/live-verify-codex-gateway.sh` exits `0` in full mode.
- The same-thread smoke passes inside that full verifier.
- The final hygiene scan has no sensitive live-local data.
- GitHub `main` contains the same verifier and skill documents used locally.

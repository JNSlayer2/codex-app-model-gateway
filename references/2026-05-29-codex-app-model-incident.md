# 2026-05-29 Codex App Model Gateway Failure Modes

This reference keeps only sanitized engineering lessons from the v1/v2 incident. It intentionally omits local paths, auth state, thread dumps, renderer bundle details, signed app patch steps, repair bypasses, screenshots, and complete logs.

## What Failed

- Multiple providers were created for different model families, so GPT and Claude became separate thread factions.
- State repair watchers repeatedly modified config, model cache, thread metadata, and UI state while Codex App was also writing those files.
- Existing threads kept their original provider even when the default config changed.
- Claude text responses were treated as if they had full Codex agent tool compatibility.
- UI model visibility was debugged too close to signed app internals instead of being treated as an upstream UI/cache issue after gateway and CLI verification passed.

## Stable Rule

Codex App should see one provider: `model_gateway`.

The provider handles all model routing:

- GPT slugs proxy through the Codex ChatGPT subscription Responses endpoint.
- Claude slugs route through the Claude adapter.
- Future backends add catalog entries and adapters, not providers.

Thread creation fixes the provider. Same-thread model switching only works when the thread starts or resumes under `model_gateway`; later turns should change only `model`.

## Tool Boundary

External models do not receive permanent Codex tools. They only see request-scoped tool schemas supplied by Codex App for that request. The external model may request a tool, but Codex App executes it and sends the result back in the next turn.

This preserves model-native systems:

- No Claude global MCP edits.
- No external model app state edits.
- No tool execution inside the external model runtime.
- No hidden watcher that syncs Codex tools into another model.

## Recovery Pattern

1. Stop state repair watchers.
2. Restore config/state backups if UI or thread state is drifting.
3. Deploy one loopback gateway.
4. Verify gateway health, model catalog, GPT passthrough, Claude smoke tests, and tool bridge tests.
5. Set top-level `model_provider = "model_gateway"` only after passthrough is working.
6. Migrate only explicitly selected existing threads by updating both database thread provider and rollout session metadata after backup.
7. Do not patch signed app bundles. If UI dropdown still hides a verified gateway model, record it as a UI/cache/upstream blocker.

## Redaction Rule

Do not add raw machine evidence to this reference. If a new incident happens, record the abstract failure mode, the safe diagnostic command, and the verified fix. Keep local state, private identifiers, and reverse-engineering details out of GitHub.

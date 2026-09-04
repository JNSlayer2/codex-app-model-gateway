#!/usr/bin/env node
"use strict";

const http = require("http");
const https = require("https");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { StringDecoder } = require("string_decoder");
const {
  createTatwoGatewayContinuation,
} = require(path.join(__dirname, "tatwo-continuation"));

const GATEWAY_RUNTIME_STARTED_AT = new Date().toISOString();
const GATEWAY_RUNTIME_SOURCE_SHA256 = crypto
  .createHash("sha256")
  .update(fs.readFileSync(__filename))
  .digest("hex");

const HOST = process.env.MODEL_GATEWAY_HOST || "127.0.0.1";
const PORT = Number(process.env.MODEL_GATEWAY_PORT || 4177);
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 120000);
const CLAUDE_ABORT_GRACE_MS = Number(process.env.CLAUDE_ABORT_GRACE_MS || 2000);
const DEFAULT_ROUTE_HEALTH_MAX_AGE_MS = 15 * 60 * 1000;
const MAX_ROUTE_HEALTH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ROUTE_HEALTH_POLICY = parseRouteHealthPolicy(process.env.GATEWAY_ROUTE_HEALTH_MAX_AGE_MS);
const ROUTE_HEALTH_MAX_AGE_MS = ROUTE_HEALTH_POLICY.maxAgeMs;
const HEARTBEAT_MS = Number(process.env.GATEWAY_HEARTBEAT_MS || 15000);
// Default reasoning level advertised for models that expose a compatible
// control. GPT forwards reasoning.effort verbatim, Claude pins the selected
// tier through both --effort and CLAUDE_CODE_EFFORT_LEVEL, Grok uses its
// model-level --reasoning-effort flag, and MiniMax advertises no effort control.
const DEFAULT_REASONING_LEVEL = process.env.GATEWAY_DEFAULT_REASONING_LEVEL || "low";
const UPSTREAM_TIMEOUT_MS = Number(process.env.GATEWAY_UPSTREAM_TIMEOUT_MS || 600000);
const CLAUDE_COMMAND = process.env.CLAUDE_COMMAND || "claude";
// 2026-07-03 grok lane fix (Fable5 + sonnet-5 副審): 120s 預設讓考試級長生成
// 必超時（SIGTERM → 空輸出/"fetch failed" 症狀）；比照 opus lane 的 600s。
const GROK_TIMEOUT_MS = Number(process.env.GROK_TIMEOUT_MS || 600000);
const GROK_COMMAND = process.env.GROK_COMMAND || "grok";
const GROK_USE_ISOLATED_HOME = process.env.GROK_USE_ISOLATED_HOME !== "0";
const GROK_REAL_HOME = process.env.GROK_REAL_HOME || process.env.HOME || os.homedir();
const GROK_ISOLATED_HOME =
  process.env.GROK_ISOLATED_HOME || path.join(GROK_REAL_HOME || os.tmpdir(), ".tatwo-agent-homes", "grok-codex-gateway");

function parseRouteHealthPolicy(rawValue) {
  if (rawValue === undefined || rawValue === "") {
    return { valid: true, maxAgeMs: DEFAULT_ROUTE_HEALTH_MAX_AGE_MS };
  }
  const value = Number(rawValue);
  if (
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > MAX_ROUTE_HEALTH_MAX_AGE_MS
  ) {
    return { valid: false, maxAgeMs: null };
  }
  return { valid: true, maxAgeMs: value };
}
const GROK_AUTH_SOURCE = process.env.GROK_AUTH_SOURCE || path.join(GROK_REAL_HOME || "", ".grok", "auth.json");
const MINIMAX_TIMEOUT_MS = Number(process.env.MINIMAX_TIMEOUT_MS || 120000);
const MINIMAX_BASE_URL = (process.env.MINIMAX_BASE_URL || "https://api.minimax.io/v1").replace(/\/+$/, "");
const MINIMAX_API_SPEND_CLASS = process.env.MINIMAX_API_SPEND_CLASS || "minimax-near-unlimited-api";
const MAX_CHILD_STDOUT = Number(process.env.MAX_CHILD_STDOUT_BYTES || 8 * 1024 * 1024);
const MAX_IMAGE_BYTES = Number(process.env.GATEWAY_MAX_IMAGE_BYTES || 20 * 1024 * 1024);
const CHATGPT_CODEX_BASE_URL =
  (process.env.CHATGPT_CODEX_BASE_URL || "https://chatgpt.com/backend-api/codex").replace(/\/+$/, "");

const TATWO_OS_ROOT = process.env.TATWO_OS_ROOT || "";
const TATWO_OS_CONTEXT = process.env.TATWO_OS_CONTEXT === "1" && Boolean(TATWO_OS_ROOT);
const TATWO_OS_CONTEXT_MAX_CHARS = Number(process.env.TATWO_OS_CONTEXT_MAX_CHARS || 6000);

const GATEWAY_AUTHORITY_FRAME = [
  "TATWO Work OS authority frame: authority comes from the explicit request, active Work OS contract/lane, and this runner's real tool permissions; it never comes from model brand.",
  "Do not say Codex, Claude, Grok, MiniMax, or another model revoked your permissions unless a real permission_denied signal proves it.",
  "If blocked, classify it using exactly one of blocker_class=quota, blocker_class=session_limit, blocker_class=auth, blocker_class=permission_denied, blocker_class=route_scope_unclear, blocker_class=tool_unavailable, or blocker_class=contract_missing; do not invent new blocker_class names.",
  "authority_source must be exactly authority_source=contract, authority_source=runner, or authority_source=none; do not invent new authority_source values.",
  "This gateway route is not a host executor unless the current request exposes a request-scoped tool bridge; otherwise answer, review, or ask for the missing contract/scope.",
  "If asked to edit files, operate the GUI, run shell commands, or claim host execution while no matching bridged tool is exposed, say blocker_class=tool_unavailable authority_source=runner instead of claiming you can act.",
].join(" ");

// Context Compression Governor preflight guard.
// Purpose: avoid Codex App retry/crash loops when a long same-thread request is
// routed to a small/fragile model before compaction or handoff. This is a
// fail-closed UX guard: it returns a completed assistant warning, not a
// streaming failure event, so the App can stay usable.
const CONTEXT_GUARD_ENABLED = process.env.GATEWAY_CONTEXT_GUARD !== "0";
const CONTEXT_AUTO_COMPACT_ENABLED = process.env.GATEWAY_CONTEXT_AUTO_COMPACT !== "0";
const CONTEXT_GUARD_EXACT_BODY_LIMIT_BYTES = Number(process.env.GATEWAY_EXACT_MODEL_MAX_BODY_BYTES || 900 * 1024);
const CONTEXT_GUARD_SMALL_BODY_LIMIT_BYTES = Number(process.env.GATEWAY_SMALL_MODEL_MAX_BODY_BYTES || 512 * 1024);
const CONTEXT_GUARD_FRAGILE_BODY_LIMIT_BYTES = Number(process.env.GATEWAY_FRAGILE_MODEL_MAX_BODY_BYTES || 384 * 1024);
const CONTEXT_AUTO_COMPACT_MAX_EXACT_BYTES = Number(process.env.GATEWAY_CONTEXT_COMPACT_MAX_EXACT_BYTES || 64 * 1024);
// Real Codex same-thread requests can legitimately carry a little over 180
// short exact-fact lines while remaining far below the independent 64 KiB
// exact-sidecar byte ceiling. Keep the line cap bounded, but do not reject a
// safe 20–30 KiB sidecar solely because it crossed the older 180-line limit.
const CONTEXT_AUTO_COMPACT_MAX_EXACT_LINES = Number(process.env.GATEWAY_CONTEXT_COMPACT_MAX_EXACT_LINES || 256);

const gptRoutes = {
  "chatgpt-pro-consult": {
    display_name: "ChatGPT Pro Consult",
    priority: 101,
    upstream_model: "gpt-5.5",
    role: "codex_native_consultant",
    listed_in_catalog: false,
    deprecated: true,
    replaced_by: "gpt-5.5",
    description:
      "Codex-native ChatGPT Pro consultant lane. Uses the same Codex ChatGPT subscription passthrough as GPT-5.5, but is labeled for bounded research, planning, and review inside the current Codex thread.",
  },
  "gpt-5.6-sol": { display_name: "GPT-5.6 Sol", priority: 104 },
  "gpt-5.6-terra": { display_name: "GPT-5.6 Terra", priority: 103 },
  "gpt-5.6-luna": { display_name: "GPT-5.6 Luna", priority: 102 },
  "gpt-5.5": { display_name: "GPT-5.5", priority: 100 },
  "gpt-5.4": { display_name: "GPT-5.4", priority: 99 },
  "gpt-5.4-mini": { display_name: "GPT-5.4 Mini", priority: 98 },
  "gpt-5.3-codex": { display_name: "GPT-5.3 Codex", priority: 97 },
  "gpt-5.3-codex-spark": { display_name: "GPT-5.3 Codex Spark", priority: 96 },
  "gpt-5.2": { display_name: "GPT-5.2", priority: 95 },
  "codex-auto-review": { display_name: "Codex Auto Review", priority: 94 },
};

// Keep the Codex App GPT dropdown intentionally small. Older GPT passthrough
// routes can remain callable for existing threads, but they should not be
// advertised in /v1/models unless explicitly added here.
const visibleGptCatalogSlugs = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
]);

function isGptListedInCatalog(slug, route) {
  return route.listed_in_catalog !== false && visibleGptCatalogSlugs.has(slug);
}

const gptAliases = {
  "chatgpt-pro": "chatgpt-pro-consult",
};

const claudeRoutes = {
  "opus-5": {
    display_name: "opus5",
    candidates: ["claude-opus-5", "opus-5", "opus"],
    context_window: 1000000,
  },
  "opus-4-7": {
    display_name: "opus4.7",
    candidates: ["claude-opus-4-7", "opus-4-7", "opus"],
  },
  "opus-4-8": {
    display_name: "opus4.8",
    // 1M-context variant first: heavy ultrawork threads overflow the 200K default.
    candidates: ["claude-opus-4-8[1m]", "claude-opus-4-8", "opus-4-8", "opus"],
    context_window: 1000000,
  },
  "sonnet-5": {
    display_name: "sonnet5",
    candidates: ["claude-sonnet-5", "sonnet-5", "sonnet"],
  },
  "haiku-4-5": {
    display_name: "haiku4.5",
    candidates: ["claude-haiku-4-5", "haiku-4-5", "haiku"],
  },
  "fable-5": {
    display_name: "fable5.1",
    // Keep the stable Codex route slug for existing threads, but pin execution
    // to the exact Fable 5.1 vendor model and advertise its verified 1M window.
    candidates: ["claude-fable-5-1"],
    context_window: 1000000,
  },
};

const claudeAliases = {
  "opus": "opus-5",
  "opus5": "opus-5",
  "claude-opus-5": "opus-5",
  "opus4.7": "opus-4-7",
  "opus4.8": "opus-4-8",
  "sonnet5": "sonnet-5",
  // Hidden compatibility aliases: existing Codex App selections migrate to Sonnet 5.
  "sonnet4.6": "sonnet-5",
  "sonnet-4-6": "sonnet-5",
  "claude-sonnet-4-6": "sonnet-5",
  "haiku4.5": "haiku-4-5",
  "claude-haiku-4-5": "haiku-4-5",
  "haiku-4-5": "haiku-4-5",
  "fable5": "fable-5",
  "fable5.1": "fable-5",
  "fable51": "fable-5",
  "fable-5-1": "fable-5",
  "claude-fable-5-1": "fable-5",
};

const grokRoutes = {
  "grok-build": {
    display_name: "Grok 4.6",
    candidates: ["grok-4.6", "grok-build"],
  },
};

const minimaxRoutes = {
  "minimax-m3": {
    display_name: "MiniMax M3",
    candidates: ["MiniMax-M3"],
    context_window: 1000000,
    guaranteed_context_window: 512000,
  },
};

function csvEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

const apiSpendPolicy = {
  default: "deny_metered_api_fanout",
  human_confirmation_required: true,
  allowed_api_model_classes: [
    "local-openai-compatible",
    "minimax-near-unlimited-api",
    "user-approved-api:<provider>/<model>",
  ],
  active_api_model_allowlist: csvEnv("GATEWAY_API_MODEL_ALLOWLIST"),
  current_routes: {
    openai: "chatgpt_subscription_passthrough_not_api_key",
    claude: "cli_subscription_not_api_key",
    grok: "cli_oauth_not_api_key",
    minimax: `api_${MINIMAX_API_SPEND_CLASS}`,
  },
};

const reasoningLevels = [
  { effort: "low", description: "Fast responses with lighter reasoning" },
  { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
  { effort: "high", description: "Greater reasoning depth for complex problems" },
  { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
  { effort: "max", description: "Maximum provider-supported reasoning effort" },
];
const GPT_REASONING_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh"]);
const CLAUDE_REASONING_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
const GROK_REASONING_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh"]);
const NO_REASONING_EFFORTS = Object.freeze([]);

function supportedReasoningLevels(efforts) {
  const allowed = new Set(efforts);
  return reasoningLevels.filter((level) => allowed.has(level.effort));
}

function defaultReasoningLevel(efforts) {
  const configured = String(DEFAULT_REASONING_LEVEL || "").trim().toLowerCase();
  return efforts.includes(configured) ? configured : efforts[0] || null;
}

function reasoningProviderConfig(routeKind) {
  if (routeKind === "claude") {
    return {
      provider: "claude_cli",
      cliFlag: "--effort",
      supportedEfforts: CLAUDE_REASONING_EFFORTS,
    };
  }
  if (routeKind === "grok") {
    return {
      provider: "grok_cli",
      cliFlag: "--reasoning-effort",
      supportedEfforts: GROK_REASONING_EFFORTS,
    };
  }
  if (routeKind === "gpt") {
    return {
      provider: "chatgpt_subscription",
      cliFlag: null,
      supportedEfforts: GPT_REASONING_EFFORTS,
    };
  }
  return {
    provider: routeKind === "minimax" ? "minimax_api" : "unknown",
    cliFlag: null,
    supportedEfforts: NO_REASONING_EFFORTS,
  };
}

function requestedReasoningControl(body, routeKind) {
  const config = reasoningProviderConfig(routeKind);
  const reasoning = body?.reasoning;
  const hasRequestedEffort =
    reasoning !== null &&
    typeof reasoning === "object" &&
    !Array.isArray(reasoning) &&
    Object.prototype.hasOwnProperty.call(reasoning, "effort");
  if (!hasRequestedEffort) {
    return {
      requested: null,
      normalized: null,
      provider: config.provider,
      cli_flag: config.cliFlag,
      forwarded: false,
      effective_attested: false,
    };
  }
  const requested = reasoning.effort;
  if (typeof requested !== "string") {
    throw Object.assign(
      new Error("reasoning.effort must be a string"),
      { status: 400 },
    );
  }
  const normalized = requested.trim().toLowerCase();
  if (!config.supportedEfforts.includes(normalized)) {
    const supported = config.supportedEfforts.length > 0
      ? config.supportedEfforts.join(", ")
      : "none";
    throw Object.assign(
      new Error(
        `${config.provider} does not support reasoning.effort=${JSON.stringify(requested)}; supported values: ${supported}`,
      ),
      { status: 400 },
    );
  }
  return {
    requested,
    normalized,
    provider: config.provider,
    cli_flag: config.cliFlag,
    forwarded: false,
    effective_attested: false,
  };
}

function forwardedReasoningControl(control) {
  return {
    ...control,
    forwarded: Boolean(control?.normalized && control?.cli_flag),
    effective_attested: false,
  };
}

function reasoningCliArgs(control) {
  return control?.normalized && control?.cli_flag
    ? [control.cli_flag, control.normalized]
    : [];
}

function claudeChildEnv(control) {
  const env = { ...process.env };
  const selectedEffort =
    control?.normalized
    || defaultReasoningLevel(CLAUDE_REASONING_EFFORTS);
  if (selectedEffort) {
    // Claude Code documents CLAUDE_CODE_EFFORT_LEVEL as higher precedence
    // than --effort and persisted effortLevel/modelSettings. Pin the
    // request-selected value here so a user's native Claude default cannot
    // silently turn Codex low/medium/high into another effort tier.
    env.CLAUDE_CODE_EFFORT_LEVEL = selectedEffort;
  } else {
    delete env.CLAUDE_CODE_EFFORT_LEVEL;
  }
  return env;
}

function reasoningResponseOptions(result = {}) {
  return result.reasoning_control
    ? { reasoning_control: result.reasoning_control }
    : {};
}

function promptTransportResponseOptions(result = {}) {
  return result.prompt_transport
    ? { prompt_transport: result.prompt_transport }
    : {};
}

const gptBaseInstructions =
  "You are Codex, a coding agent based on GPT-5. You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.";

// Classify backend failures into a small, leak-free taxonomy for /healthz.
// Order matters: auth before quota (e.g. "usage limit" wording near login hints),
// spawn before network (ENOENT is a local exec problem, not connectivity).
function classifyErrorKind(text, signal) {
  const s = String(text || "");
  if (/client.*disconnect|request aborted|aborted by client/i.test(s)) return "client_disconnect";
  if (/model attestation|observed model|fallback detected|fallback_count/i.test(s)) return "model_attestation";
  if (signal === "SIGTERM" || signal === "SIGKILL" || /timed? ?out|timeout/i.test(s)) return "timeout";
  if (/failed to start|spawn .*ENOENT|ENOENT|EACCES/i.test(s)) return "spawn";
  if (/stdout exceeded|output.*exceeded.*bytes|stream.*exceeded.*bytes/i.test(s)) {
    return "output_cap";
  }
  if (/not authenticated|unauthorized|invalidated|forbidden|invalid api key|login|oauth|\b401\b|\b403\b/i.test(s)) return "auth";
  if (/rate limit|rate_limit|quota|usage limit|session limit|resets|billing|credit|payment|\b429\b/i.test(s)) return "quota";
  if (/cannot be used as an advisor|advisor model/i.test(s)) return "configuration";
  if (
    /invalid model|unknown model|model .*not|not available|currently unavailable|unavailable|unsupported model/i.test(
      s,
    )
  ) {
    return "model";
  }
  if (
    /overloaded_error/i.test(s) ||
    /(?:upstream|anthropic|http|status|code)\s*(?::|=)?\s*(?:500|502|503|520|529)\b/i.test(s) ||
    /\b(?:500|502|503|504|520|529)\s+(?:internal server error|bad gateway|service unavailable|gateway timeout|overloaded|unknown error)\b/i.test(
      s,
    )
  ) {
    return "upstream_5xx";
  }
  if (
    /ECONN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket|fetch failed|network|stream disconnected|closed before completion|response aborted/i.test(
      s,
    )
  ) {
    return "network";
  }
  if (/empty output|no result event|JSON|parse/i.test(s)) return "parse";
  return "unknown";
}

function recordRouteAttemptStarted(state) {
  state.attempts += 1;
  state.in_flight += 1;
  state.last_attempt_at = new Date().toISOString();
}

function recordRouteAttemptFinished(state) {
  if (!Number.isInteger(state.in_flight) || state.in_flight <= 0) {
    state.in_flight = 0;
    state.accounting_violation_count += 1;
    state.last_accounting_violation_at = new Date().toISOString();
    return false;
  }
  state.in_flight -= 1;
  return true;
}

function recordRouteAbortRequested(state) {
  state.abort_requested_at = new Date().toISOString();
  state.last_outcome = "aborting";
}

function recordRouteOk(state, model) {
  const now = new Date().toISOString();
  state.backend_model = model;
  state.last_ok_at = now;
  state.last_error = null;
  state.last_error_kind = null;
  state.last_error_at = null;
  state.last_terminal_at = now;
  state.last_outcome = "ok";
  state.abort_requested_at = null;
  state.candidate_hits[model] = (state.candidate_hits[model] || 0) + 1;
}

function recordRouteError(state, rawError, signal) {
  const now = new Date().toISOString();
  state.last_error = rawError;
  state.last_error_kind = classifyErrorKind(rawError, signal);
  state.last_error_at = now;
  state.last_terminal_at = now;
  state.last_outcome = state.last_error_kind === "client_disconnect" ? "cancelled" : "error";
  state.abort_requested_at = null;
}

function publicRouteState(s, observedAt) {
  // Sanitized view for /healthz: never expose last_error text, which can contain
  // CLI stderr or prompt fragments. Report only a boolean plus a coarse kind so
  // operators can tell auth/quota/timeout/network apart without reading logs.
  // candidate_hits resets on gateway restart (diagnostic, not a persistent stat).
  const observedMs = Date.parse(observedAt);
  const lastOkMs = Date.parse(s.last_ok_at || "");
  const lastOkAgeMs =
    Number.isFinite(observedMs) && Number.isFinite(lastOkMs)
      ? observedMs - lastOkMs
      : null;
  const lastOkFresh =
    ROUTE_HEALTH_POLICY.valid &&
    lastOkAgeMs !== null &&
    lastOkAgeMs >= 0 &&
    lastOkAgeMs <= ROUTE_HEALTH_MAX_AGE_MS;
  const accountingError = s.accounting_violation_count > 0;
  const hasError = Boolean(s.last_error) || accountingError;
  const status =
    s.in_flight > 0
      ? s.last_outcome === "aborting"
        ? "aborting"
        : "in_progress"
      : hasError
        ? "unhealthy"
        : s.last_ok_at && lastOkFresh
          ? "healthy"
          : s.last_ok_at
            ? "stale"
          : s.attempts > 0
            ? s.last_terminal_at
              ? "unknown_not_healthy"
              : "incomplete"
            : "untested";
  return {
    backend_model: s.backend_model,
    last_ok_at: s.last_ok_at,
    attempts: s.attempts,
    in_flight: s.in_flight,
    last_attempt_at: s.last_attempt_at,
    last_terminal_at: s.last_terminal_at,
    last_outcome: s.last_outcome,
    abort_requested_at: s.abort_requested_at,
    has_error: hasError,
    error_kind: accountingError ? "accounting" : hasError ? s.last_error_kind || "unknown" : null,
    last_error_at: accountingError ? s.last_accounting_violation_at : hasError ? s.last_error_at : null,
    accounting_violation_count: s.accounting_violation_count,
    last_accounting_violation_at: s.last_accounting_violation_at,
    observed_at: observedAt,
    health_max_age_ms: ROUTE_HEALTH_MAX_AGE_MS,
    health_max_age_config_valid: ROUTE_HEALTH_POLICY.valid,
    last_ok_age_ms: lastOkAgeMs,
    stale: Boolean(s.last_ok_at) && !lastOkFresh,
    status,
    healthy: status === "healthy",
    candidate_hits: s.candidate_hits,
    requested_model: s.requested_model,
    expected_model: s.expected_model,
    actual_model: s.actual_model,
    provider: s.provider,
    retry_count: s.retry_count,
    fallback_count: s.fallback_count,
    attestation_outcome: s.attestation_outcome,
    terminal_event_type: s.terminal_event_type,
  };
}

function makeRouteState(routes) {
  return Object.fromEntries(
    Object.entries(routes).map(([slug, route]) => [
      slug,
      {
        backend_model: route.candidates?.[0] || route.upstream_model || slug,
        last_ok_at: null,
        last_error: null,
        last_error_kind: null,
        last_error_at: null,
        candidate_hits: {},
        attempts: 0,
        in_flight: 0,
        last_attempt_at: null,
        last_terminal_at: null,
        last_outcome: null,
        abort_requested_at: null,
        accounting_violation_count: 0,
        last_accounting_violation_at: null,
        requested_model: null,
        expected_model: null,
        actual_model: null,
        provider: null,
        retry_count: 0,
        fallback_count: null,
        attestation_outcome: "UNTESTED",
        terminal_event_type: null,
      },
    ]),
  );
}

const gptRouteState = makeRouteState(gptRoutes);
const routeState = makeRouteState(claudeRoutes);
const grokRouteState = makeRouteState(grokRoutes);
const minimaxRouteState = makeRouteState(minimaxRoutes);
const tatwoGatewayContinuation = createTatwoGatewayContinuation();

function gptRouteForModel(model) {
  const slug = gptAliases[model] || model;
  const route = gptRoutes[slug];
  return route ? { slug, route } : null;
}

function gptPassthroughBodyText(
  bodyText,
  upstreamModel,
  forceStreaming = false,
) {
  const body = JSON.parse(bodyText || "{}");
  if (upstreamModel) body.model = upstreamModel;
  if (forceStreaming) body.stream = true;
  // The ChatGPT Codex subscription endpoint requires ephemeral Responses.
  // Never let a native caller omit or override this upstream contract.
  body.store = false;
  // TATWO metadata is local bookkeeping. The subscription endpoint rejects
  // this parameter, so keep it at the gateway boundary instead of forwarding.
  delete body.metadata;
  return JSON.stringify(body);
}

function normalizedExactModel(value) {
  return String(value || "").trim().toLowerCase();
}

function beginGptRouteAttempt(state, requestedModel, expectedModel) {
  if (!state) {
    return {
      get finished() {
        return true;
      },
      succeed() {},
      fail() {},
    };
  }
  recordRouteAttemptStarted(state);
  state.requested_model = requestedModel;
  state.expected_model = expectedModel;
  state.actual_model = null;
  state.provider = "chatgpt_subscription";
  state.retry_count = 0;
  state.fallback_count = 0;
  state.attestation_outcome = "IN_PROGRESS";
  state.terminal_event_type = null;
  let finished = false;
  const applyEvidence = (evidence = {}) => {
    if (evidence.actualModel !== undefined) {
      state.actual_model = evidence.actualModel || null;
    }
    if (evidence.fallbackCount !== undefined) {
      state.fallback_count = evidence.fallbackCount;
    }
    if (evidence.attestationOutcome) {
      state.attestation_outcome = evidence.attestationOutcome;
    }
    if (evidence.terminalEventType !== undefined) {
      state.terminal_event_type = evidence.terminalEventType || null;
    }
  };
  return {
    get finished() {
      return finished;
    },
    succeed(evidence) {
      if (finished) return;
      finished = true;
      applyEvidence(evidence);
      recordRouteOk(state, evidence.actualModel);
      recordRouteAttemptFinished(state);
    },
    fail(rawError, signal, evidence) {
      if (finished) return;
      finished = true;
      applyEvidence(evidence);
      recordRouteError(state, rawError, signal);
      recordRouteAttemptFinished(state);
    },
  };
}

function createGptResponsesTerminalObserver(contentType) {
  const isSse = /text\/event-stream/i.test(String(contentType || ""));
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let jsonBody = "";
  let jsonBodyExceeded = false;
  let finishedObservation = null;
  const completed = [];
  const failed = [];
  const outputItemsByIndex = new Map();
  const functionArgumentsByIndex = new Map();
  const functionArgumentsByItemID = new Map();
  let malformedTerminalCount = 0;
  let parsedPayloadCount = 0;

  const observePayload = (payload, eventName = "") => {
    parsedPayloadCount += 1;
    const type = String(payload?.type || eventName || "");
    if (type === "response.completed") {
      completed.push(payload);
    } else if (type === "response.failed") {
      failed.push(payload);
    } else if (type === "response.function_call_arguments.done") {
      const outputIndex = Number.isSafeInteger(payload?.output_index)
        ? payload.output_index
        : null;
      const itemID = String(payload?.item_id || "");
      const argumentsText = payload?.arguments;
      if (typeof argumentsText === "string") {
        if (outputIndex !== null) {
          functionArgumentsByIndex.set(outputIndex, argumentsText);
          const existing = outputItemsByIndex.get(outputIndex);
          if (existing?.type === "function_call") {
            outputItemsByIndex.set(outputIndex, {
              ...existing,
              arguments: argumentsText,
            });
          }
        }
        if (itemID) functionArgumentsByItemID.set(itemID, argumentsText);
      }
    } else if (
      type === "response.output_item.done"
      && payload?.item
      && typeof payload.item === "object"
    ) {
      const outputIndex = Number.isSafeInteger(payload?.output_index)
        ? payload.output_index
        : outputItemsByIndex.size;
      let item = { ...payload.item };
      if (item.type === "function_call") {
        const argumentsText =
          functionArgumentsByIndex.get(outputIndex)
          ?? functionArgumentsByItemID.get(String(item.id || ""));
        if (typeof argumentsText === "string") {
          item = { ...item, arguments: argumentsText };
        }
      }
      outputItemsByIndex.set(outputIndex, item);
    }
  };
  const observeSseBlock = (block) => {
    const lines = String(block || "").split(/\r?\n/);
    const eventName = String(
      lines.find((line) => line.startsWith("event:"))?.slice("event:".length) || "",
    ).trim();
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).replace(/^ /, ""))
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      observePayload(JSON.parse(data), eventName);
    } catch {
      if (eventName === "response.completed" || eventName === "response.failed") {
        malformedTerminalCount += 1;
      }
    }
  };
  const drainSse = (flush = false) => {
    while (true) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match || match.index === undefined) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      observeSseBlock(block);
    }
    if (flush && buffer.trim()) {
      observeSseBlock(buffer);
      buffer = "";
    }
  };
  const observeNonSseBody = (bodyText) => {
    try {
      observePayload(JSON.parse(bodyText || "{}"));
      return;
    } catch {}

    const beforeFramedPayloads = parsedPayloadCount;
    if (/(?:^|\r?\n)(?:event|data):/.test(bodyText)) {
      buffer += bodyText;
      drainSse(true);
      if (parsedPayloadCount > beforeFramedPayloads) return;
    }

    const beforeNdjsonPayloads = parsedPayloadCount;
    for (const line of String(bodyText || "").split(/\r?\n/)) {
      const candidate = line.trim();
      if (!candidate) continue;
      try {
        observePayload(JSON.parse(candidate));
      } catch {}
    }
    if (parsedPayloadCount === beforeNdjsonPayloads) {
      malformedTerminalCount += 1;
    }
  };

  return {
    push(chunk) {
      const text = decoder.write(Buffer.from(chunk));
      if (isSse) {
        buffer += text;
        drainSse();
        return;
      }
      if (!jsonBodyExceeded) {
        jsonBody += text;
        if (Buffer.byteLength(jsonBody, "utf8") > MAX_CHILD_STDOUT) {
          jsonBodyExceeded = true;
          jsonBody = "";
        }
      }
    },
    finish() {
      if (finishedObservation) return finishedObservation;
      const tail = decoder.end();
      if (isSse) {
        buffer += tail;
        drainSse(true);
      } else if (!jsonBodyExceeded) {
        jsonBody += tail;
        observeNonSseBody(jsonBody);
      }
      finishedObservation = {
        completed,
        failed,
        outputItemEntries: [...outputItemsByIndex.entries()]
          .sort(([left], [right]) => left - right)
          .map(([outputIndex, item]) => ({ outputIndex, item })),
        malformedTerminalCount,
        jsonBodyExceeded,
      };
      return finishedObservation;
    },
  };
}

function gptTerminalAttestation(observation, requestedModel, expectedModel) {
  if (observation.failed.length > 0) {
    const failure = observation.failed[observation.failed.length - 1];
    const upstreamKind =
      failure?.error?.error_kind
      || failure?.response?.error_kind
      || "unknown";
    return {
      ok: false,
      actualModel: null,
      fallbackCount: 0,
      terminalEventType: "response.failed",
      attestationOutcome: "FAIL_CLOSED_RESPONSE_FAILED",
      rawError: `GPT upstream emitted response.failed (${upstreamKind})`,
    };
  }
  if (
    observation.malformedTerminalCount > 0
    || observation.jsonBodyExceeded
  ) {
    return {
      ok: false,
      actualModel: null,
      fallbackCount: 0,
      terminalEventType: null,
      attestationOutcome: "FAIL_CLOSED_TERMINAL_MALFORMED",
      rawError: "GPT response terminal parse failed",
    };
  }
  if (observation.completed.length !== 1) {
    return {
      ok: false,
      actualModel: null,
      fallbackCount: 0,
      terminalEventType:
        observation.completed.length > 0 ? "response.completed" : null,
      attestationOutcome:
        observation.completed.length > 1
          ? "FAIL_CLOSED_TERMINAL_AMBIGUOUS"
          : "FAIL_CLOSED_TERMINAL_MISSING",
      rawError:
        observation.completed.length > 1
          ? "GPT response completed terminal was ambiguous"
          : "GPT response completed terminal missing",
    };
  }
  const terminal = observation.completed[0];
  const response = terminal?.response || terminal;
  const status = String(response?.status || "");
  const actualModel =
    response?.actual_model
    || response?.model_attestation?.actual_model
    || response?.model_attestation?.actual_canonical_model
    || response?.model
    || terminal?.actual_model
    || terminal?.model
    || "";
  const explicitFallbackCount =
    response?.fallback_count
    ?? response?.model_attestation?.fallback_count
    ?? terminal?.fallback_count;
  const fallbackModels =
    response?.fallback_models
    || response?.model_attestation?.fallback_models
    || terminal?.fallback_models;
  const fallbackCount = Number.isSafeInteger(explicitFallbackCount)
    ? explicitFallbackCount
    : Array.isArray(fallbackModels)
      ? fallbackModels.length
      : 0;
  if (status !== "completed") {
    return {
      ok: false,
      actualModel,
      fallbackCount,
      terminalEventType: "response.completed",
      attestationOutcome: "FAIL_CLOSED_COMPLETED_STATUS",
      rawError: `GPT response completed event had non-completed status ${JSON.stringify(status)}`,
    };
  }
  if (response?.degraded === true || response?.error_kind) {
    return {
      ok: false,
      actualModel,
      fallbackCount,
      terminalEventType: "response.completed",
      attestationOutcome: "FAIL_CLOSED_DEGRADED_COMPLETION",
      rawError: "GPT response completed event was degraded",
    };
  }
  if (fallbackCount !== 0) {
    return {
      ok: false,
      actualModel,
      fallbackCount,
      terminalEventType: "response.completed",
      attestationOutcome: "FAIL_CLOSED_FALLBACK",
      rawError: `GPT model attestation fallback detected fallback_count=${fallbackCount}`,
    };
  }
  if (
    !actualModel
    || normalizedExactModel(actualModel)
      !== normalizedExactModel(expectedModel)
  ) {
    return {
      ok: false,
      actualModel,
      fallbackCount,
      terminalEventType: "response.completed",
      attestationOutcome: actualModel
        ? "FAIL_CLOSED_MODEL_MISMATCH"
        : "ATTESTATION_MISSING",
      rawError:
        `GPT model attestation failed: requested=${requestedModel} expected=${expectedModel} observed=${actualModel || "missing"} fallback_count=${fallbackCount}`,
    };
  }
  return {
    ok: true,
    actualModel,
    fallbackCount,
    terminalEventType: "response.completed",
    attestationOutcome: "VERIFIED_EXACT",
    rawError: "",
  };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function routeCompressionProfile(model, routeModel = model) {
  const slug = routeModel || model || "";
  if (/haiku/i.test(slug)) {
    return { tier: "fragile-small", bodyLimitBytes: CONTEXT_GUARD_FRAGILE_BODY_LIMIT_BYTES, action: "S1_text_compact + S2_exact_sidecar + S4_same_thread_smoke_or_S5_new_thread" };
  }
  if (/mini|gpt-5\.4-mini|spark/i.test(slug)) {
    return { tier: "small", bodyLimitBytes: CONTEXT_GUARD_SMALL_BODY_LIMIT_BYTES, action: "S1_text_compact + S4_same_thread_smoke" };
  }
  if (/sonnet|gpt-5\.4(?!-mini)/i.test(slug)) {
    return { tier: "medium-exact", bodyLimitBytes: CONTEXT_GUARD_EXACT_BODY_LIMIT_BYTES, action: "S1_text_compact + S2_exact_sidecar if exact-risk" };
  }
  return null;
}

function contextGuardDecision(model, routeModel, bodyText) {
  if (!CONTEXT_GUARD_ENABLED) return { allow: true };
  const profile = routeCompressionProfile(model, routeModel);
  if (!profile) return { allow: true };
  const bytes = Buffer.byteLength(bodyText || "", "utf8");
  if (bytes <= profile.bodyLimitBytes) return { allow: true, profile, bytes };
  return {
    allow: false,
    model,
    routeModel,
    bytes,
    profile,
    reason: `context_guard_blocked: ${model} request ${bytes} bytes exceeds ${profile.tier} limit ${profile.bodyLimitBytes} bytes`,
  };
}

function contextGuardText(decision) {
  const kb = Math.round(decision.bytes / 1024);
  const limitKb = Math.round(decision.profile.bodyLimitBytes / 1024);
  const lines = [
    `[model_gateway context guard] ${decision.model} was not called because this same-thread context is too large for the route profile.`,
    `Request size: ${kb} KiB; guard limit: ${limitKb} KiB (${decision.profile.tier}).`,
    `Required next step: ${decision.profile.action}.`,
    "This completed warning intentionally replaces a streaming failure event to prevent Codex App retry/crash loops. Exact facts must come from the text sidecar / handoff pack, not an image-only gist.",
  ];
  if (decision.compactionFailure) {
    lines.splice(
      3,
      0,
      `Automatic S1/S2 compaction was not forwarded: ${decision.compactionFailure}.`,
    );
  }
  return lines.join("\n");
}

function byteLength(text) {
  return Buffer.byteLength(String(text || ""), "utf8");
}

function truncateChars(text, maxChars) {
  const value = String(text || "");
  if (value.length <= maxChars) return value;
  const head = Math.max(0, Math.floor(maxChars * 0.58));
  const tail = Math.max(0, maxChars - head - 160);
  return [
    value.slice(0, head),
    `\n...[truncated ${value.length - head - tail} chars by model_gateway deterministic compact]...\n`,
    tail > 0 ? value.slice(value.length - tail) : "",
  ].join("");
}

function shrinkToByteLimit(text, maxBytes) {
  let value = String(text || "");
  if (byteLength(value) <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = truncateChars(value, mid);
    if (byteLength(candidate) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return truncateChars(value, low);
}

function detectContextSecretRisk(bodyText) {
  const text = String(bodyText || "");
  const patterns = [
    { name: "private_key_block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/i },
    { name: "openai_style_key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
    { name: "anthropic_style_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
    { name: "github_token", re: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
    { name: "bearer_token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{32,}\b/i },
    {
      name: "credential_assignment",
      re: /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|auth(?:orization)?|cookie|secret)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{24,}/i,
    },
  ];
  const hits = patterns.filter((pattern) => pattern.re.test(text)).map((pattern) => pattern.name);
  return { hasSecretRisk: hits.length > 0, hits };
}

function textRecordsFromBody(body) {
  const records = [];
  if (body?.instructions) {
    records.push({
      index: "instructions",
      role: "system",
      kind: "instructions",
      text: String(body.instructions),
    });
  }
  const input = body?.input;
  if (typeof input === "string") {
    records.push({ index: 0, role: "user", kind: "input_string", text: input });
  } else if (Array.isArray(input)) {
    input.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      let text = "";
      let role = item.role || "unknown";
      let kind = item.type || "item";
      if (item.type === "message" || item.role) {
        role = item.role || "user";
        kind = "message";
        text = contentText(item.content);
      } else if (item.type === "function_call") {
        const label = [item.namespace, item.name].filter(Boolean).join(".");
        text = `ASSISTANT_TOOL_CALL ${item.call_id || ""} ${label}:\n${item.arguments || ""}`.trim();
      } else if (item.type === "function_call_output") {
        role = "tool";
        text = `TOOL_RESULT ${item.call_id || ""}:\n${outputText(item.output)}`.trim();
      } else if (item.type === "tool_search_call") {
        text = `TOOL_SEARCH_CALL ${item.call_id || ""}:\n${JSON.stringify(item.arguments || {})}`.trim();
      } else if (item.type === "tool_search_call_output") {
        role = "tool";
        text = `TOOL_SEARCH_RESULT ${item.call_id || ""}:\n${outputText(item.output)}`.trim();
      } else {
        text = contentText(item.content || item);
      }
      if (text) records.push({ index, role, kind, text });
    });
  }
  return records;
}

function findLatestUserRecord(records) {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    if (records[i].role === "user") return records[i];
  }
  return records[records.length - 1] || null;
}

function latestUserIntentText(body) {
  const record = findLatestUserRecord(textRecordsFromBody(body));
  return record?.role === "user" ? String(record.text || "") : "";
}

const TATWO_GATEWAY_METADATA_V2 = "TatwoGatewayMetadataV2";
const TATWO_APPLIED_ROUTE_RECEIPT_V1 =
  "TatwoGatewayAppliedComputerHostRouteReceiptV1";
const tatwoAuthorityNonceBindings = new Map();
const MAX_TATWO_AUTHORITY_NONCES = 10_000;

function normalizeTatwoAuthorityIdentifier(value, field) {
  const normalized =
    typeof value === "string" ? value.trim() : "";
  if (
    value !== normalized
    || !normalized
    || normalized.length > 160
    || !/^[a-z0-9][a-z0-9._:-]*$/i.test(normalized)
  ) {
    throw Object.assign(
      new Error(`invalid Tatwo current-turn ${field}`),
      { status: 400 },
    );
  }
  return normalized;
}

function validateTatwoCurrentTurnV2(currentTurn) {
  const runID = normalizeTatwoAuthorityIdentifier(
    currentTurn?.run_id,
    "run_id",
  );
  const turnID = normalizeTatwoAuthorityIdentifier(
    currentTurn?.turn_id,
    "turn_id",
  );
  const currentVisibleTurnSHA256 =
    currentTurn?.current_visible_turn_sha256;
  if (
    typeof currentVisibleTurnSHA256 !== "string"
    || currentVisibleTurnSHA256 !== currentVisibleTurnSHA256.trim()
    || !/^[a-f0-9]{64}$/.test(currentVisibleTurnSHA256)
  ) {
    throw Object.assign(
      new Error(
        "invalid Tatwo current-turn current_visible_turn_sha256; expected lowercase sha256",
      ),
      { status: 400 },
    );
  }
  const currentVisibleTurnUTF8Bytes =
    currentTurn?.current_visible_turn_utf8_bytes;
  let normalizedCurrentVisibleTurnUTF8Bytes = null;
  if (currentVisibleTurnUTF8Bytes !== undefined) {
    if (
      !Number.isSafeInteger(currentVisibleTurnUTF8Bytes)
      || currentVisibleTurnUTF8Bytes <= 0
      || currentVisibleTurnUTF8Bytes > MAX_BODY_BYTES
    ) {
      throw Object.assign(
        new Error(
          "invalid Tatwo current-turn current_visible_turn_utf8_bytes",
        ),
        { status: 400 },
      );
    }
    normalizedCurrentVisibleTurnUTF8Bytes =
      currentVisibleTurnUTF8Bytes;
  }
  const authorityNonce = currentTurn?.authority_nonce;
  if (
    typeof authorityNonce !== "string"
    || authorityNonce !== authorityNonce.trim()
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      authorityNonce,
    )
  ) {
    throw Object.assign(
      new Error(
        "invalid Tatwo current-turn authority_nonce; expected fresh lowercase UUIDv4",
      ),
      { status: 400 },
    );
  }
  const computerHostRoute = currentTurn?.computer_host_route;
  if (
    !["none", "embedded_intent", "request_scoped_tool"].includes(
      computerHostRoute,
    )
  ) {
    throw Object.assign(
      new Error(
        "invalid Tatwo current-turn computer host route; expected none, embedded_intent, or request_scoped_tool",
      ),
      { status: 400 },
    );
  }
  return {
    run_id: runID,
    turn_id: turnID,
    current_visible_turn_sha256: currentVisibleTurnSHA256,
    current_visible_turn_utf8_bytes:
      normalizedCurrentVisibleTurnUTF8Bytes,
    authority_nonce: authorityNonce,
    computer_host_route: computerHostRoute,
  };
}

function tatwoCurrentTurnCarrier(body) {
  if (typeof body?.input === "string") {
    return {
      text: body.input,
      source: "responses_input_string",
    };
  }
  const record = findLatestUserRecord(textRecordsFromBody(body));
  if (!record || record.role !== "user") return null;
  return {
    text: String(record.text || ""),
    source: "latest_user_message",
  };
}

function derivedTatwoCurrentVisibleTurn(body, binding) {
  const carrier = tatwoCurrentTurnCarrier(body);
  if (!carrier) return null;
  if (Number.isSafeInteger(binding.current_visible_turn_utf8_bytes)) {
    const carrierBytes = Buffer.from(carrier.text, "utf8");
    const visibleBytes = binding.current_visible_turn_utf8_bytes;
    if (visibleBytes > carrierBytes.length) {
      throw Object.assign(
        new Error(
          "Tatwo current-turn current_visible_turn_utf8_bytes exceeds input",
        ),
        { status: 400 },
      );
    }
    const suffixBytes = carrierBytes.subarray(
      carrierBytes.length - visibleBytes,
    );
    const suffix = suffixBytes.toString("utf8");
    if (Buffer.byteLength(suffix, "utf8") !== visibleBytes) {
      throw Object.assign(
        new Error(
          "Tatwo current-turn current_visible_turn_utf8_bytes splits UTF-8",
        ),
        { status: 400 },
      );
    }
    return {
      text: suffix,
      digestSource:
        `gateway_verified_tatwo_utf8_suffix_${carrier.source}`,
    };
  }

  if (typeof body?.input === "string") {
    const flattenedCloseMarker =
      "[/Hidden TATWO same-thread transcript bridge]";
    const markerIndex = body.input.lastIndexOf(flattenedCloseMarker);
    if (markerIndex >= 0) {
      const suffix = body.input
        .slice(markerIndex + flattenedCloseMarker.length)
        .replace(/^(?:\r?\n){2}/, "");
      if (!suffix) return null;
      return {
        text: suffix,
        digestSource:
          "gateway_verified_tatwo_flattened_current_turn",
      };
    }
    return {
      text: body.input,
      digestSource: "gateway_verified_responses_input_string",
    };
  }
  return {
    text: carrier.text,
    digestSource: "gateway_verified_latest_user_message",
  };
}

function verifyTatwoCurrentVisibleTurnDigest(body, binding) {
  const derived = derivedTatwoCurrentVisibleTurn(body, binding);
  if (!derived) {
    return {
      ...binding,
      digest_source: "caller_asserted_unverifiable",
      digest_verified: false,
    };
  }
  const computed = crypto
    .createHash("sha256")
    .update(derived.text, "utf8")
    .digest("hex");
  if (computed !== binding.current_visible_turn_sha256) {
    throw Object.assign(
      new Error(
        "Tatwo current-turn current_visible_turn_sha256 mismatch",
      ),
      { status: 400 },
    );
  }
  return {
    ...binding,
    digest_source: derived.digestSource,
    digest_verified: true,
  };
}

function reserveTatwoAuthorityNonce(binding) {
  if (!binding) return;
  const key = binding.authority_nonce;
  const bindingDigest = [
    binding.run_id,
    binding.turn_id,
    binding.current_visible_turn_sha256,
    binding.computer_host_route,
  ].join("\u0000");
  const previous = tatwoAuthorityNonceBindings.get(key);
  if (previous !== undefined) {
    const message =
      previous === bindingDigest
        ? "replayed Tatwo current-turn authority_nonce"
        : "Tatwo current-turn authority_nonce binding mismatch";
    throw Object.assign(new Error(message), { status: 409 });
  }
  tatwoAuthorityNonceBindings.set(key, bindingDigest);
  if (tatwoAuthorityNonceBindings.size > MAX_TATWO_AUTHORITY_NONCES) {
    const oldest = tatwoAuthorityNonceBindings.keys().next().value;
    tatwoAuthorityNonceBindings.delete(oldest);
  }
}

function currentTurnToolIntentDecision(body) {
  const tatwo = body?.metadata?.tatwo;
  if (tatwo === undefined) {
    const latestUserIntent = latestUserIntentText(body);
    const computerUseRequested = isComputerUseRequest(latestUserIntent);
    return {
      source: "latest_user_text_heuristic",
      computerHostRoute:
        computerUseRequested ? "request_scoped_tool" : "none",
      computerUseRequested,
      hostExecutionRequested: isHostExecutionRequest(latestUserIntent),
      requiresBufferedResponse: computerUseRequested,
      authorityBinding: null,
    };
  }
  const validEnvelopeBase =
    tatwo !== null
    && typeof tatwo === "object"
    && !Array.isArray(tatwo)
    && tatwo.source === "tatwo_ultrawork_chat"
    && tatwo.current_turn !== null
    && typeof tatwo.current_turn === "object"
    && !Array.isArray(tatwo.current_turn);
  if (!validEnvelopeBase) {
    throw Object.assign(
      new Error(
        "invalid Tatwo current-turn authority envelope",
      ),
      { status: 400 },
    );
  }

  if (tatwo.schema === "TatwoGatewayMetadataV1") {
    const toolIntent = tatwo.current_turn.tool_intent;
    if (!["none", "computer_use"].includes(toolIntent)) {
      throw Object.assign(
        new Error(
          "invalid Tatwo current-turn tool intent; expected none or computer_use",
        ),
        { status: 400 },
      );
    }
    const computerUseRequested = toolIntent === "computer_use";
    return {
      source: "tatwo_current_turn_snapshot_v1",
      computerHostRoute:
        computerUseRequested ? "request_scoped_tool" : "none",
      computerUseRequested,
      // V1 had only one positive state. Preserve its request-scoped tool
      // semantics for compatibility; embedded App intent requires V2.
      hostExecutionRequested: computerUseRequested,
      requiresBufferedResponse: computerUseRequested,
      authorityBinding: null,
    };
  }

  if (tatwo.schema !== TATWO_GATEWAY_METADATA_V2) {
    throw Object.assign(
      new Error(
        "invalid Tatwo current-turn authority schema; expected TatwoGatewayMetadataV1 or TatwoGatewayMetadataV2",
      ),
      { status: 400 },
    );
  }
  const authorityBinding = verifyTatwoCurrentVisibleTurnDigest(
    body,
    validateTatwoCurrentTurnV2(tatwo.current_turn),
  );
  const computerHostRoute = authorityBinding.computer_host_route;
  const computerUseRequested =
    computerHostRoute === "request_scoped_tool";
  return {
    source: "tatwo_current_turn_snapshot_v2",
    computerHostRoute,
    computerUseRequested,
    // `embedded_intent` is executed by the Tatwo App after it parses the
    // returned contract. It must not require a Responses tool schema and it
    // must not be replaced by the generic missing-host-tool blocker.
    hostExecutionRequested: computerUseRequested,
    // Both positive routes stay buffered: request-scoped calls must be parsed
    // as function calls, while embedded intent tags must never leak as deltas.
    requiresBufferedResponse: computerHostRoute !== "none",
    authorityBinding,
  };
}

function exactFactLines(records) {
  const exactPatterns = [
    /\/(?:Users|Volumes|tmp|var|opt|usr)\/[^\s"'`<>]+/,
    /\b[A-Fa-f0-9]{7,64}\b/,
    /\b(?:[A-Za-z0-9_-]+\.){1,}[A-Za-z0-9_-]+\b/,
    /\b(?:haiku-4-[56]|haiku4\.[56]|minimax-m3|gpt-5\.4-mini|gpt-5\.5|fable-5|fable5|sonnet-5|opus-4-8|grok-build)\b/i,
    /\b(?:commit|HEAD|sha256|contractID|goalID|threadId|runID|model|route|port|pid|LaunchAgent|rollback|receipt|backup)\b/i,
    /\b(?:curl|node|npm|git|launchctl|codex|claude|grok|python3?|bash|zsh)\s+[^\n]{1,240}/i,
    /\b\d{4}-\d{2}-\d{2}[T ][0-9:.+-]*/,
    /\b\d+(?:\.\d+)?\s*(?:KiB|MiB|KB|MB|GB|tokens?|bytes?|ms|s|%|USD|NTD|\$)\b/i,
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  ];
  const seen = new Set();
  const lines = [];
  for (const record of records) {
    const rawLines = String(record.text || "").split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
      const line = rawLines[lineIndex].trim();
      if (!line) continue;
      // Some exact-fact regexes intentionally look for paths/domains/hashes. Run
      // them on a bounded head/tail sample so a single huge long-context line
      // cannot trigger catastrophic backtracking before compaction has a chance
      // to protect the route.
      const matchSample = line.length > 2400 ? `${line.slice(0, 1200)}\n${line.slice(-1200)}` : line;
      if (!exactPatterns.some((pattern) => pattern.test(matchSample))) continue;
      const compactLine = line.length > 420 ? `${line.slice(0, 260)} ... ${line.slice(-120)}` : line;
      const tagged = `[${record.index}:${record.role}:${lineIndex + 1}] ${compactLine}`;
      if (seen.has(tagged)) continue;
      seen.add(tagged);
      lines.push(tagged);
    }
  }
  return lines;
}

function deterministicContextMap(records, latestUser) {
  return records
    .filter((record) => record !== latestUser && record.kind !== "instructions")
    .map((record) => {
      const text = String(record.text || "");
      const preview = truncateChars(text.replace(/\s+/g, " ").trim(), 320);
      return `- [${record.index}:${record.role}:${record.kind}] chars=${text.length} sha256=${sha256Hex(text).slice(0, 16)} preview=${JSON.stringify(preview)}`;
    });
}

function recentTail(records, latestUser, maxChars) {
  const tail = [];
  let used = 0;
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i];
    if (record === latestUser || record.kind === "instructions") continue;
    const text = String(record.text || "");
    const allowance = Math.max(600, Math.min(2400, maxChars - used));
    if (used >= maxChars) break;
    tail.push(
      [
        `### recent [${record.index}:${record.role}:${record.kind}] chars=${text.length} sha256=${sha256Hex(text).slice(0, 16)}`,
        truncateChars(text, allowance),
      ].join("\n"),
    );
    used += byteLength(tail[tail.length - 1]);
  }
  return tail.reverse();
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function buildAutoCompactPacket(body, decision, targetPromptBytes) {
  const records = textRecordsFromBody(body);
  const latestUser = findLatestUserRecord(records);
  const exactLines = exactFactLines(records);
  const exactText = exactLines.join("\n");
  const exactBytes = byteLength(exactText);
  if (exactLines.length > CONTEXT_AUTO_COMPACT_MAX_EXACT_LINES || exactBytes > CONTEXT_AUTO_COMPACT_MAX_EXACT_BYTES) {
    return {
      ok: false,
      reason:
        `S2_exact_sidecar coverage unsafe (${exactLines.length} lines / ${Math.round(exactBytes / 1024)} KiB); use handoff/new thread instead`,
    };
  }

  const latestText = latestUser ? String(latestUser.text || "") : "";
  const latestBudget = Math.max(3000, Math.floor(targetPromptBytes * 0.38));
  const tailBudget = Math.max(6000, Math.floor(targetPromptBytes * 0.24));
  const mapBudget = Math.max(6000, Math.floor(targetPromptBytes * 0.22));
  const exactHash = sha256Hex(exactText || "NO_EXACT_FACTS");
  const mapLines = deterministicContextMap(records, latestUser);
  const mapText = shrinkToByteLimit(mapLines.join("\n"), mapBudget);
  const tailText = recentTail(records, latestUser, tailBudget).join("\n\n");

  const packet = [
    "[model_gateway auto-compact S1/S2]",
    "This request was automatically compacted because the selected route has a smaller/fragile context profile. This packet is deterministic and lossy for old prose; it is not a lossless transcript.",
    "Authority rule: exact IDs / paths / hashes / commands / numeric facts are authoritative only when present in S2_exact_sidecar or in the latest/recent text below. If a needed exact fact is absent, say so instead of inventing.",
    `Target model: ${decision.model}; route profile: ${decision.profile.tier}; original_request_bytes=${decision.bytes}; guard_limit_bytes=${decision.profile.bodyLimitBytes}.`,
    `S2_exact_sidecar_sha256=${exactHash}; exact_line_count=${exactLines.length}; secret_scan=no_high_confidence_secret_detected.`,
    body?.instructions ? "Original Responses `instructions` field is preserved outside this compact packet." : "No separate Responses `instructions` field was present.",
    "",
    "## S2_exact_sidecar (authoritative exact facts extracted before lossy compaction)",
    exactText || "- NO_EXACT_FACTS_DETECTED",
    "",
    "## S1_context_map (deterministic old-context map, not a semantic summary)",
    mapText || "- NO_OLDER_TEXT_RECORDS",
    "",
    "## Recent tail kept as text",
    tailText || "- NO_RECENT_TAIL",
    "",
    "## Latest user turn kept with priority",
    latestUser
      ? `### latest [${latestUser.index}:${latestUser.role}:${latestUser.kind}] chars=${latestText.length} sha256=${sha256Hex(latestText).slice(0, 16)}\n${shrinkToByteLimit(latestText, latestBudget)}`
      : "- NO_LATEST_USER_TURN",
    "",
    "## Required behavior",
    "Continue the task using the compact packet. Be explicit if old omitted context is needed. Do not mention internal gateway mechanics unless the user asks.",
  ].join("\n");

  return {
    ok: true,
    packet: shrinkToByteLimit(packet, targetPromptBytes),
    exactHash,
    exactLineCount: exactLines.length,
    records: records.length,
  };
}

function compactedBodyForSmallRoute(body, decision, originalBodyText) {
  if (!CONTEXT_AUTO_COMPACT_ENABLED) {
    return { ok: false, reason: "GATEWAY_CONTEXT_AUTO_COMPACT=0" };
  }
  const secret = detectContextSecretRisk(originalBodyText);
  if (secret.hasSecretRisk) {
    return { ok: false, reason: `secret-risk (${secret.hits.join(",")}); refusing lossy compact/image route` };
  }
  const images = extractImageInputs(body);
  if (images.images.length > 0 || images.unsupported.length > 0) {
    return { ok: false, reason: "image input present; gateway S1 text compact will not drop or rewrite images" };
  }
  const profileLimit = decision.profile.bodyLimitBytes;
  const targetPromptBytes = Math.max(
    24 * 1024,
    Math.floor(Math.min(profileLimit * 0.62, profileLimit - 96 * 1024)),
  );
  const packet = buildAutoCompactPacket(body, decision, targetPromptBytes);
  if (!packet.ok) return packet;
  const compactedBody = {
    ...body,
    input: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: packet.packet }],
      },
    ],
  };
  const compactedBodyText = JSON.stringify(compactedBody);
  const compactedBytes = byteLength(compactedBodyText);
  if (compactedBytes > profileLimit) {
    if (body?.tools || body?.tool_choice || body?.parallel_tool_calls) {
      const textPart = compactedBody.input?.[0]?.content?.[0];
      if (textPart && typeof textPart.text === "string") {
        textPart.text +=
          "\n\n[model_gateway auto-compact note] Codex request-scoped tool schemas were withheld because they would exceed this route profile after S1/S2 compaction. Answer text-only; ask Codex host to switch back to a larger/tool route if a tool call is required.";
      }
      delete compactedBody.tools;
      delete compactedBody.tool_choice;
      delete compactedBody.parallel_tool_calls;
      const toolStrippedBodyText = JSON.stringify(compactedBody);
      const toolStrippedBytes = byteLength(toolStrippedBodyText);
      if (toolStrippedBytes <= profileLimit) {
        return {
          ok: true,
          body: compactedBody,
          bodyText: toolStrippedBodyText,
          compactedBytes: toolStrippedBytes,
          receipt: {
            stage: "S1_text_compact+S2_exact_sidecar",
            input_bytes: decision.bytes,
            output_bytes: toolStrippedBytes,
            route_profile: decision.profile.tier,
            exact_sidecar_sha256: packet.exactHash,
            exact_line_count: packet.exactLineCount,
            text_record_count: packet.records,
            secret_scan: "no_high_confidence_secret_detected",
            tool_schema_policy: "withheld_after_compact_to_fit_route_profile",
          },
        };
      }
    }
    return {
      ok: false,
      reason: `S1 compacted request still too large (${Math.round(compactedBytes / 1024)} KiB > ${Math.round(profileLimit / 1024)} KiB)`,
    };
  }
  return {
    ok: true,
    body: compactedBody,
    bodyText: compactedBodyText,
    compactedBytes,
    receipt: {
      stage: "S1_text_compact+S2_exact_sidecar",
      input_bytes: decision.bytes,
      output_bytes: compactedBytes,
      route_profile: decision.profile.tier,
      exact_sidecar_sha256: packet.exactHash,
      exact_line_count: packet.exactLineCount,
      text_record_count: packet.records,
      secret_scan: "no_high_confidence_secret_detected",
      tool_schema_policy: "preserved",
    },
  };
}

function sendCompletedAssistantText(res, model, text, stream, options = {}) {
  const { response, output } = responseObjects(text, model, options);
  if (!stream) return json(res, 200, response);
  if (!res.headersSent) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
  }
  sse(res, { type: "response.created", response: inProgressResponseObject(model, options) });
  sse(res, { type: "response.output_item.done", item: output[0] });
  sse(res, { type: "response.completed", response });
  res.end();
}

// Heavy agent tasks (e.g. ultrawork) accumulate large contexts; a 2 MB cap reset the
// socket mid-send, which Codex surfaced as "error sending request" + a retry storm.
// Default to 64 MB, overridable via env, and respond with a clean 413 instead of
// destroying the connection before the handler can reply.
const MAX_BODY_BYTES = (() => {
  const parsed = Number(process.env.GATEWAY_MAX_BODY_BYTES);
  // Guard: NaN, zero, or negative values would either fall through (ok) or make
  // `bytes > MAX_BODY_BYTES` always true, rejecting every request with 413.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 64 * 1024 * 1024;
})();

// Claude true streaming kill switch (text-only turns stream incremental deltas;
// tool-bridge turns always stay buffered). Set CLAUDE_STREAMING=0 to force the
// fully buffered legacy behavior.
const CLAUDE_STREAMING = process.env.CLAUDE_STREAMING !== "0";

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let bytes = 0;
    let aborted = false;
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      if (aborted) return;
      data += chunk;
      bytes += Buffer.byteLength(chunk, "utf8"); // true byte count; .length is chars, not bytes
      if (bytes > MAX_BODY_BYTES) {
        aborted = true;
        const err = new Error(`request body too large (> ${MAX_BODY_BYTES} bytes)`);
        err.statusCode = 413;
        reject(err);
        req.resume(); // drain remaining bytes without buffering so the handler can reply
      }
    });
    req.on("end", () => { if (!aborted) resolve(data); });
    req.on("error", reject);
  });
}

// Single source of truth for a /v1/models catalog entry. Per-backend blocks below only
// override what actually differs (description, priority, base_instructions, context window,
// reasoning/verbosity/parallel flags, modalities, search, capabilities). Add a catalog field
// once here instead of in three duplicated blocks.
function buildModelEntry(slug, displayName, priority, o) {
  const reasoningEfforts = o.reasoning_efforts || NO_REASONING_EFFORTS;
  return {
    slug,
    id: slug,
    model: slug,
    display_name: displayName,
    description: o.description,
    visibility: "list",
    supported_in_api: true,
    default_reasoning_level: defaultReasoningLevel(reasoningEfforts),
    supported_reasoning_levels: supportedReasoningLevels(reasoningEfforts),
    shell_type: "shell_command",
    priority,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: o.base_instructions,
    model_messages: { instructions_template: null, instructions_variables: null },
    supports_reasoning_summaries: o.supports_reasoning_summaries,
    default_reasoning_summary: o.default_reasoning_summary,
    support_verbosity: o.support_verbosity,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    truncation_policy: { mode: "tokens", limit: 10000 },
    supports_parallel_tool_calls: o.supports_parallel_tool_calls,
    supports_image_detail_original: o.supports_image_detail_original,
    context_window: o.context_window,
    max_context_window: o.context_window,
    effective_context_window_percent: 90,
    // Auto-compact before the effective window fills. Custom providers don't get the
    // App's native default, so advertise it explicitly (~60% of window) per model.
    // NOTE: the catalog value is advisory; the decisive setting is the user's config
    // model_auto_compact_token_limit + model_auto_compact_token_limit_scope="total"
    // (default scope ignores the cached prefix, so heavy caching never trips it).
    auto_compact_token_limit: Math.floor((o.context_window || 200000) * 0.6),
    experimental_supported_tools: [],
    input_modalities: o.input_modalities,
    supports_search_tool: o.supports_search_tool,
    capabilities: o.capabilities,
  };
}

function modelsPayload() {
  const gptModels = Object.entries(gptRoutes)
    .filter(([slug, route]) => isGptListedInCatalog(slug, route))
    .map(([slug, route]) =>
    buildModelEntry(slug, route.display_name, route.priority, {
      description:
        route.description ||
        "GPT model routed through local model_gateway to the Codex ChatGPT subscription endpoint.",
      base_instructions: gptBaseInstructions,
      supports_reasoning_summaries: true,
      default_reasoning_summary: "auto",
      support_verbosity: true,
      supports_parallel_tool_calls: true,
      supports_image_detail_original: true,
      context_window: 400000,
      input_modalities: ["text", "image"],
      supports_search_tool: true,
      reasoning_efforts: GPT_REASONING_EFFORTS,
      capabilities: {
        text: "passthrough",
        streaming: "passthrough",
        codex_tools: "passthrough",
        computer_use: "passthrough",
        backend: "chatgpt_subscription",
        api_spend: "subscription_passthrough_not_api_key",
        isolation: route.role ? "codex_first_party_same_thread" : "codex_first_party",
        role: route.role || "codex_primary",
        upstream_model: route.upstream_model || slug,
        reasoning_effort: {
          request_field: "reasoning.effort",
          supported: GPT_REASONING_EFFORTS,
          forwarding: "verbatim_responses_passthrough",
          effective_attestation: false,
        },
      },
    }),
  );
  const claudeModels = Object.entries(claudeRoutes).map(([slug, route], index) =>
    buildModelEntry(slug, route.display_name, 50 - index, {
      description:
        "Claude CLI backend via local Codex model_gateway. Tools use request-scoped prompt bridge; Claude never executes Codex tools directly.",
      base_instructions:
        "You are Codex, a coding agent running through a local Claude model gateway. Answer directly and do not claim tool execution unless Codex supplies tool results.",
      supports_reasoning_summaries: false,
      default_reasoning_summary: "none",
      support_verbosity: false,
      supports_parallel_tool_calls: false,
      supports_image_detail_original: true,
      context_window: route.context_window || 200000,
      input_modalities: ["text", "image"],
      supports_search_tool: false,
      reasoning_efforts: CLAUDE_REASONING_EFFORTS,
      capabilities: {
        text: CLAUDE_STREAMING ? "streaming" : "buffered",
        vision: "responses_to_claude_code_image_blocks",
        streaming: CLAUDE_STREAMING
          ? "incremental_deltas_for_text_turns_buffered_for_tool_bridge"
          : "sse_after_backend_completion",
        codex_tools: "structured_tool_intent_bridge_experimental",
        computer_use: "structured_tool_intent_bridge_when_codex_exposes_tool_schema",
        backend: "claude_cli",
        api_spend: "cli_subscription_not_api_key",
        isolation: "ephemeral_request_only",
        reasoning_effort: {
          request_field: "reasoning.effort",
          supported: CLAUDE_REASONING_EFFORTS,
          cli_flag: "--effort",
          effective_attestation: false,
        },
      },
    }),
  );
  const grokModels = Object.entries(grokRoutes).map(([slug, route], index) =>
    buildModelEntry(slug, route.display_name, 40 - index, {
      description:
        "Grok CLI backend via local Codex model_gateway. Tools use request-scoped prompt bridge; Grok never executes Codex tools directly.",
      base_instructions:
        "You are Codex, a coding agent running through a local Grok model gateway. Answer directly and do not claim tool execution unless Codex supplies tool results.",
      supports_reasoning_summaries: false,
      default_reasoning_summary: "none",
      support_verbosity: false,
      supports_parallel_tool_calls: false,
      supports_image_detail_original: true,
      context_window: 256000,
      input_modalities: ["text", "image"],
      supports_search_tool: false,
      reasoning_efforts: GROK_REASONING_EFFORTS,
      capabilities: {
        text: "buffered",
        vision: "responses_to_grok_prompt_json_image_blocks",
        streaming: "sse_after_backend_completion",
        codex_tools: "structured_tool_intent_bridge_experimental",
        computer_use: "structured_tool_intent_bridge_when_codex_exposes_tool_schema",
        backend: "grok_cli",
        api_spend: "cli_oauth_not_api_key",
        isolation: "ephemeral_request_only",
        reasoning_effort: {
          request_field: "reasoning.effort",
          supported: GROK_REASONING_EFFORTS,
          cli_flag: "--reasoning-effort",
          effective_attestation: false,
        },
      },
    }),
  );
  const minimaxModels = Object.entries(minimaxRoutes).map(([slug, route], index) =>
    buildModelEntry(slug, route.display_name, 35 - index, {
      description:
        "MiniMax M3 API backend via local Codex model_gateway. Tools use request-scoped prompt bridge; MiniMax never executes Codex tools directly.",
      base_instructions:
        "You are Codex, a coding agent running through a local MiniMax M3 model gateway. Answer directly and do not claim tool execution unless Codex supplies tool results.",
      supports_reasoning_summaries: false,
      default_reasoning_summary: "none",
      support_verbosity: false,
      supports_parallel_tool_calls: false,
      supports_image_detail_original: true,
      context_window: route.context_window,
      input_modalities: ["text", "image"],
      supports_search_tool: false,
      reasoning_efforts: NO_REASONING_EFFORTS,
      capabilities: {
        text: "buffered",
        vision: "responses_multimodal_passthrough",
        streaming: "sse_after_backend_completion",
        codex_tools: "structured_tool_intent_bridge_experimental",
        computer_use: "structured_tool_intent_bridge_when_codex_exposes_tool_schema",
        backend: "minimax_api",
        backend_model: route.candidates[0],
        api_spend: MINIMAX_API_SPEND_CLASS,
        min_context_window: route.guaranteed_context_window,
        isolation: "ephemeral_request_only",
        reasoning_effort: {
          request_field: "reasoning.effort",
          supported: NO_REASONING_EFFORTS,
          forwarding: "not_supported",
          effective_attestation: false,
        },
      },
    }),
  );
  const models = [...gptModels, ...claudeModels, ...grokModels, ...minimaxModels];
  return { object: "list", data: models, models };
}

function healthPayload() {
  const observedAt = new Date().toISOString();
  return {
    ok: true,
    ok_scope: "listener_liveness_only",
    route_readiness: "inspect_each_route_status",
    observed_at: observedAt,
    service: "codex-app-model-gateway",
    runtime_source: {
      started_at: GATEWAY_RUNTIME_STARTED_AT,
      sha256: GATEWAY_RUNTIME_SOURCE_SHA256,
    },
    bind: `${HOST}:${PORT}`,
    provider: "model_gateway",
    wire_api: "responses",
    requires_openai_auth: true,
    chatgpt_subscription_passthrough: "proxy",
    chatgpt_base_url: CHATGPT_CODEX_BASE_URL,
    api_spend_policy: apiSpendPolicy,
    capabilities: {
      openai: {
        text: "passthrough",
        streaming: "passthrough",
        codex_tools: "passthrough",
        computer_use: "passthrough",
        backend: "chatgpt_subscription",
      },
      claude: {
        text: CLAUDE_STREAMING ? "streaming" : "buffered",
        streaming: CLAUDE_STREAMING
          ? "incremental_deltas_for_text_turns_buffered_for_tool_bridge"
          : "sse_after_backend_completion",
        codex_tools: "structured_tool_intent_bridge_experimental",
        computer_use: "structured_tool_intent_bridge_when_codex_exposes_tool_schema",
        backend: "claude_cli",
        isolation: "ephemeral_request_only",
      },
      grok: {
        text: "buffered",
        streaming: "sse_after_backend_completion",
        codex_tools: "structured_tool_intent_bridge_experimental",
        computer_use: "structured_tool_intent_bridge_when_codex_exposes_tool_schema",
        backend: "grok_cli",
        isolation: "ephemeral_request_only",
      },
      minimax: {
        text: "buffered",
        streaming: "sse_after_backend_completion",
        codex_tools: "structured_tool_intent_bridge_experimental",
        computer_use: "structured_tool_intent_bridge_when_codex_exposes_tool_schema",
        backend: "minimax_api",
        backend_model: "MiniMax-M3",
        api_spend: MINIMAX_API_SPEND_CLASS,
        spend_allowed: minimaxSpendAllowed(),
        configured: Boolean(readMiniMaxApiKey()),
        isolation: "ephemeral_request_only",
      },
    },
    routes: {
      ...Object.fromEntries(
        Object.entries(gptRoutes).map(([slug, route]) => [
          slug,
          {
            display_name: route.display_name,
            backend: "chatgpt_subscription",
            passthrough: true,
            role: route.role || "codex_primary",
            upstream_model: route.upstream_model || slug,
            listed_in_catalog: isGptListedInCatalog(slug, route),
            deprecated: route.deprecated === true,
            replaced_by: route.replaced_by || null,
            ...publicRouteState(gptRouteState[slug], observedAt),
          },
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(claudeRoutes).map(([slug, route]) => [
          slug,
          {
            display_name: route.display_name,
            backend_candidates: route.candidates,
            ...publicRouteState(routeState[slug], observedAt),
          },
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(grokRoutes).map(([slug, route]) => [
          slug,
          {
            display_name: route.display_name,
            backend_candidates: route.candidates,
            ...publicRouteState(grokRouteState[slug], observedAt),
          },
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(minimaxRoutes).map(([slug, route]) => [
          slug,
          {
            display_name: route.display_name,
            backend_candidates: route.candidates,
            api_spend: MINIMAX_API_SPEND_CLASS,
            spend_allowed: minimaxSpendAllowed(),
            configured: Boolean(readMiniMaxApiKey()),
            ...publicRouteState(minimaxRouteState[slug], observedAt),
          },
        ]),
      ),
    },
  };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      return item.text || item.input_text || item.output_text || "";
    })
    .filter(Boolean)
    .join("\n");
}

const supportedImageMimeTypes = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function normalizeMimeType(mimeType, fallback = "image/png") {
  const value = String(mimeType || fallback).trim().toLowerCase();
  if (value === "image/jpg") return "image/jpeg";
  return supportedImageMimeTypes.has(value) ? value : fallback;
}

function mimeTypeFromPath(filePath) {
  const ext = String(filePath || "").toLowerCase().split(".").pop();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "webp") return "image/webp";
  return "image/png";
}

function imageFromBase64(base64, mimeType, label) {
  const cleaned = String(base64 || "").replace(/\s+/g, "");
  if (!cleaned) return { unsupported: `${label || "image"} has empty base64 data` };
  let bytes;
  try {
    bytes = Buffer.from(cleaned, "base64");
  } catch {
    return { unsupported: `${label || "image"} has invalid base64 data` };
  }
  if (bytes.length === 0) return { unsupported: `${label || "image"} decoded to an empty image` };
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { unsupported: `${label || "image"} is ${bytes.length} bytes, above GATEWAY_MAX_IMAGE_BYTES=${MAX_IMAGE_BYTES}` };
  }
  const mime = normalizeMimeType(mimeType);
  const normalizedBase64 = bytes.toString("base64");
  return { image: { mimeType: mime, base64: normalizedBase64, dataUrl: `data:${mime};base64,${normalizedBase64}` } };
}

function imageFromDataUrl(dataUrl, label) {
  const match = String(dataUrl || "").trim().match(/^data:([^;,]+);base64,(.+)$/is);
  if (!match) return null;
  return imageFromBase64(match[2], match[1], label);
}

function imageFromLocalPath(value, label) {
  let filePath = String(value || "").trim();
  if (filePath.startsWith("file://")) {
    try {
      filePath = decodeURIComponent(new URL(filePath).pathname);
    } catch {
      return { unsupported: `${label || "image"} has an invalid file:// URL` };
    }
  }
  if (!filePath.startsWith("/")) return null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return { unsupported: `${label || "image"} path is not a file: ${filePath}` };
    if (stat.size > MAX_IMAGE_BYTES) {
      return { unsupported: `${label || "image"} is ${stat.size} bytes, above GATEWAY_MAX_IMAGE_BYTES=${MAX_IMAGE_BYTES}` };
    }
    const mime = mimeTypeFromPath(filePath);
    if (!supportedImageMimeTypes.has(mime)) return { unsupported: `${label || "image"} has unsupported image extension: ${filePath}` };
    const base64 = fs.readFileSync(filePath).toString("base64");
    return { image: { mimeType: mime, base64, dataUrl: `data:${mime};base64,${base64}`, filePath } };
  } catch (error) {
    return { unsupported: `${label || "image"} local file could not be read: ${error.message}` };
  }
}

function stringImageSource(value, label) {
  const text = String(value || "").trim();
  if (!text) return null;
  return imageFromDataUrl(text, label) || imageFromLocalPath(text, label) || null;
}

function normalizeImagePart(part, label) {
  if (!part || typeof part !== "object") return null;
  const type = String(part.type || "").toLowerCase();
  const source = part.source || part.image || part.file || null;
  const imageUrl = part.image_url || part.imageUrl || part.url || null;
  const imageUrlValue =
    typeof imageUrl === "string"
      ? imageUrl
      : imageUrl && typeof imageUrl === "object"
        ? imageUrl.url || imageUrl.href || imageUrl.image_url || imageUrl.imageUrl
        : null;
  const sourceUrl =
    source && typeof source === "object"
      ? source.url || source.href || source.file_path || source.filePath || source.path
      : null;
  const directString = imageUrlValue || sourceUrl || part.file_path || part.filePath || part.path;
  if (directString) {
    const normalized = stringImageSource(directString, label);
    if (normalized) return normalized;
    if (/^https?:\/\//i.test(String(directString))) {
      return { unsupported: `${label || "image"} is a remote URL; this gateway only forwards data URLs or readable local image files to external CLI adapters` };
    }
  }
  const sourceBase64 =
    source && typeof source === "object"
      ? source.data || source.base64 || source.bytes
      : null;
  const base64 = part.data || part.base64 || part.bytes || sourceBase64;
  if (base64) {
    const mime =
      part.mimeType ||
      part.mime_type ||
      part.media_type ||
      part.mediaType ||
      (source && typeof source === "object" ? source.mimeType || source.mime_type || source.media_type || source.mediaType : null);
    return imageFromBase64(base64, mime, label);
  }
  if (part.file_id || part.fileId) {
    return { unsupported: `${label || "image"} uses file_id; external CLI adapters need inline data URL or local file bytes` };
  }
  if (type.includes("image")) {
    return { unsupported: `${label || "image"} did not include image bytes, data URL, or readable local path` };
  }
  return null;
}

function extractImageInputs(body) {
  const images = [];
  const unsupported = [];
  const addPart = (part, label) => {
    const normalized = normalizeImagePart(part, label);
    if (!normalized) return;
    if (normalized.image) images.push(normalized.image);
    if (normalized.unsupported) unsupported.push(normalized.unsupported);
  };
  const visitContent = (content, label) => {
    if (Array.isArray(content)) {
      content.forEach((part, index) => addPart(part, `${label}[${index}]`));
    } else if (content && typeof content === "object") {
      addPart(content, label);
    }
  };
  const input = body?.input;
  if (Array.isArray(input)) {
    input.forEach((item, index) => {
      if (!item || typeof item !== "object") return;
      if (item.type === "message" || item.role) visitContent(item.content, `input[${index}].content`);
      else addPart(item, `input[${index}]`);
    });
  } else if (body?.content) {
    visitContent(body.content, "content");
  }
  return { images, unsupported };
}

function outputText(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return contentText(output);
  if (!output || typeof output !== "object") return "";
  return output.text || output.output_text || JSON.stringify(output);
}

function compactToolSpec(tool, namespace = null) {
  if (!tool || typeof tool !== "object") return null;
  const name = tool.name || tool.function?.name;
  if (!name) return null;
  return {
    type: tool.type || "function",
    namespace,
    name,
    description: tool.description || tool.function?.description || "",
    parameters: tool.parameters || tool.function?.parameters || tool.input_schema || null,
  };
}

function extractToolSpecs(body) {
  const specs = [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type === "namespace" && Array.isArray(tool.tools) && tool.name) {
      for (const child of tool.tools) {
        const spec = compactToolSpec(child, tool.name);
        if (spec) specs.push(spec);
      }
      continue;
    }
    const spec = compactToolSpec(tool, tool.namespace || null);
    if (spec) specs.push(spec);
  }
  return specs;
}

function toolBridgeInstructions(toolSpecs) {
  if (toolSpecs.length === 0) return "";
  return [
    "Codex request-scoped tool bridge:",
    "The following tools exist only inside this Codex App request. Do not execute them in the external model CLI, do not use external-model native tools/MCP, and do not persist these tools.",
    "If a tool is needed, reply only with a JSON object of this shape:",
    '{"tool_calls":[{"type":"function_call","namespace":"optional_namespace","name":"tool_name","arguments":{}}]}',
    "If no tool is needed, reply normally in text. Arguments must match the chosen tool schema.",
    JSON.stringify(
      toolSpecs.map((spec) => ({
        namespace: spec.namespace,
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
      })),
      null,
      2,
    ),
  ].join("\n");
}

function extractPrompt(body) {
  const parts = [];
  if (body.instructions) {
    parts.push(`System instructions:\n${body.instructions}`);
  }
  const toolSpecs = extractToolSpecs(body);
  const input = body.input;
  if (typeof input === "string") {
    parts.push(input);
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "message" || item.role) {
        const role = item.role || "user";
        const text = contentText(item.content);
        if (text) parts.push(`${role.toUpperCase()}:\n${text}`);
      } else if (item.type === "function_call") {
        const label = [item.namespace, item.name].filter(Boolean).join(".");
        parts.push(`ASSISTANT_TOOL_CALL ${item.call_id || ""} ${label}:\n${item.arguments || ""}`.trim());
      } else if (item.type === "function_call_output") {
        parts.push(`TOOL_RESULT ${item.call_id || ""}:\n${outputText(item.output)}`.trim());
      } else if (item.type === "tool_search_call") {
        parts.push(`TOOL_SEARCH_CALL ${item.call_id || ""}:\n${JSON.stringify(item.arguments || {})}`.trim());
      } else if (item.type === "tool_search_call_output") {
        parts.push(`TOOL_SEARCH_RESULT ${item.call_id || ""}:\n${outputText(item.output)}`.trim());
      } else {
        const text = contentText(item.content || item);
        if (text) parts.push(text);
      }
    }
  }
  const bridge = toolBridgeInstructions(toolSpecs);
  if (bridge) parts.push(bridge);
  return parts.filter(Boolean).join("\n\n").trim() || "Reply OK.";
}


function readTatwoJSON(rel) {
  try {
    const file = path.join(TATWO_OS_ROOT, rel);
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function tatwoRegistrySummary(name, limit = 12) {
  const registry = readTatwoJSON(path.join("registry", `${name}.json`));
  const entries = Array.isArray(registry?.entries) ? registry.entries : [];
  return {
    count: entries.length,
    items: entries.slice(0, limit).map((entry) => ({
      id: entry.id || entry.name || entry.path,
      name: entry.name || entry.title || entry.displayName || null,
      path: entry.path || entry.displayPath || null,
    })),
  };
}

function tatwoCurrentContractSummary() {
  const contractID = process.env.TATWO_CONTRACT_ID || process.env.TATWO_OS_CONTRACT_ID || "";
  if (!contractID) return null;
  const safe = String(contractID).replace(/[\\/:\0]/g, "_");
  const contract = readTatwoJSON(path.join("state", `${safe}.json`));
  if (!contract) return { contractID, status: "not_found" };
  return {
    contractID: contract.contractID,
    goalID: contract.goalID,
    status: contract.status,
    mode: contract.mode,
    scenario: contract.scenario,
    objective: contract.objective,
    receiptRequirements: contract.receiptRequirements,
    receipts: contract.receipts,
  };
}

function tatwoOSContextBlock() {
  if (!TATWO_OS_CONTEXT) return "";
  const payload = {
    schema: "TatwoGatewayClaudeNativeFacadeContextV1",
    osRoot: TATWO_OS_ROOT,
    authority: {
      plainRule: "TATWO UltraworkOS is the truth layer. Codex App is executor_host. Claude/Fable/Opus/Sonnet are author_model/reviewer lanes and must not claim tool execution without Codex function_call_output or OS receipt evidence.",
      hostMutationAllowed: false,
      toolsAreRequestScoped: true,
      failClosedWithoutReceipts: true,
    },
    currentContract: tatwoCurrentContractSummary(),
    registries: {
      memory: tatwoRegistrySummary("memory", 8),
      skills: tatwoRegistrySummary("skills", 20),
      projects: tatwoRegistrySummary("projects", 12),
      mcp: tatwoRegistrySummary("mcp", 12),
    },
  };
  const text = JSON.stringify(payload, null, 2);
  return `\n\nTATWO UltraworkOS context (pointer-only; do not read secrets, do not mutate host):\n${text.slice(0, TATWO_OS_CONTEXT_MAX_CHARS)}`;
}

function claudeSystemPrompt() {
  return [
    "You are being called by a local Codex model gateway.",
    GATEWAY_AUTHORITY_FRAME,
    "Behave like a first-class Codex App model while remaining an external advisory brain.",
    "Answer directly unless the request includes a Codex request-scoped tool bridge and a tool is necessary.",
    "When using a bridged tool, return exactly one raw JSON object with tool_calls and no prose. Never execute Codex tools in Claude.",
    "Do not claim files, shell commands, MCP calls, screenshots, deployments, or host mutations happened unless Codex supplies function_call_output or a TATWO OS receipt.",
    tatwoOSContextBlock(),
  ].filter(Boolean).join(" ");
}

function isOfficialOpenAiSlug(model) {
  // Route any OpenAI-family slug to ChatGPT passthrough, not only gpt-*.
  // Covers o-series reasoning models (o1/o3/o4...), chatgpt-*, codex-*, and codex-auto-review,
  // so future Codex App models do not silently fall through to a 404. Claude/Grok routes are
  // matched before this, so widening here cannot capture their slugs.
  return /^(gpt-|o[1-9]\d?(-|$)|chatgpt-|codex(-|$))/.test(model || "");
}

function claudeArgs(
  model,
  _prompt,
  reasoningControl,
  continuationPlan = null,
) {
  return [
    "-p",
    "--safe-mode",
    "--input-format",
    "text",
    "--model",
    model,
    ...reasoningCliArgs(reasoningControl),
    "--output-format",
    "json",
    ...tatwoGatewayContinuation.providerSessionArguments(
      continuationPlan,
      "claude",
    ),
    "--mcp-config",
    '{"mcpServers":{}}',
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--disallowedTools",
    "*",
    "--system-prompt",
    claudeSystemPrompt(),
  ];
}

function writeClaudeTextPrompt(child, prompt, onError) {
  child.stdin.on("error", (error) => {
    // A child that exits before consuming stdin may close the pipe. The close
    // handler remains the single settlement path, but keep the diagnostic for
    // failures other than the expected early-close EPIPE.
    if (error?.code !== "EPIPE") onError(error);
  });
  child.stdin.end(String(prompt || ""));
}

function writeGrokTextPrompt(child, prompt, onError) {
  child.stdin.on("error", (error) => {
    // Grok reads --prompt-file /dev/stdin. Treat an early-close EPIPE as a
    // child lifecycle outcome; other write failures are retained for the
    // close handler so the route produces one deterministic terminal result.
    if (error?.code !== "EPIPE") onError(error);
  });
  child.stdin.end(String(prompt || ""));
}

function promptTransportReceipt(prompt, transport) {
  const bytes = Buffer.from(String(prompt || ""), "utf8");
  return {
    schema: "TatwoGatewayPromptTransportV1",
    transport,
    prompt_bytes: bytes.length,
    prompt_sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    prompt_in_argv: false,
  };
}

function isModelError(text) {
  return /invalid model|unknown model|model .*not|not available|unsupported model/i.test(text);
}

function normalizedClaudeModel(value) {
  return String(value || "").trim().toLowerCase().replace(/\[[^\]]+\]$/, "");
}

function canonicalClaudeSlug(value) {
  const normalized = normalizedClaudeModel(value);
  if (!normalized) return "";
  if (/^claude-haiku-4-5(?:-\d{8})?$/.test(normalized)) return "haiku-4-5";
  // Do not let an unavailable/newer provider identity attest as the currently
  // exposed 4.5 route. Exact model truth always wins over request aliases.
  if (/^claude-haiku-4-6(?:-\d{8})?$/.test(normalized)) return "haiku-4-6";
  if (normalized === "haiku-4-5" || normalized === "haiku4.5") return "haiku-4-5";
  if (claudeRoutes[normalized]) return normalized;
  if (claudeAliases[normalized]) return claudeAliases[normalized];
  for (const [slug, route] of Object.entries(claudeRoutes)) {
    if (route.candidates.some((candidate) => normalizedClaudeModel(candidate) === normalized)) return slug;
  }
  return normalized;
}

function createClaudeObservation() {
  return {
    assistantModels: new Set(),
    fallbackModels: new Set(),
    fallbackCount: 0,
    modelUsage: {},
  };
}

function observeClaudeEvent(obj, observation) {
  if (!obj || typeof obj !== "object") return;
  const assistantModel =
    obj.type === "assistant"
      ? obj.message?.model
      : obj.type === "stream_event" && obj.event?.type === "message_start"
        ? obj.event?.message?.model
        : null;
  if (assistantModel) observation.assistantModels.add(normalizedClaudeModel(assistantModel));

  const content = Array.isArray(obj.message?.content)
    ? obj.message.content
    : Array.isArray(obj.event?.message?.content)
      ? obj.event.message.content
      : [];
  for (const part of content) {
    if (part?.type !== "fallback") continue;
    observation.fallbackCount += 1;
    const fallbackModel = part?.to?.model || part?.model;
    if (fallbackModel) observation.fallbackModels.add(normalizedClaudeModel(fallbackModel));
  }
  if (obj.type === "system" && obj.subtype === "model_refusal_fallback") {
    observation.fallbackCount += 1;
    if (obj.fallbackModel) observation.fallbackModels.add(normalizedClaudeModel(obj.fallbackModel));
  }

  const modelUsage = obj.modelUsage || obj.model_usage;
  if (modelUsage && typeof modelUsage === "object") {
    Object.assign(observation.modelUsage, modelUsage);
  }
  const iterations = obj.usage?.iterations;
  if (Array.isArray(iterations)) {
    for (const iteration of iterations) {
      if (String(iteration?.type || "").toLowerCase() !== "fallback_message") continue;
      observation.fallbackCount += 1;
      if (iteration?.model) observation.fallbackModels.add(normalizedClaudeModel(iteration.model));
    }
  }
}

function claudeObservationPayload(observation) {
  return {
    assistant_models: [...observation.assistantModels].filter(Boolean),
    fallback_models: [...observation.fallbackModels].filter(Boolean),
    fallback_count: observation.fallbackCount,
    model_usage: observation.modelUsage,
  };
}

function claudeExecutionAttestation(requestedSlug, candidateModel, result = {}) {
  const requested = canonicalClaudeSlug(requestedSlug);
  const assistantModels = [...new Set((result.assistant_models || []).map(normalizedClaudeModel).filter(Boolean))];
  const fallbackModels = [...new Set((result.fallback_models || []).map(normalizedClaudeModel).filter(Boolean))];
  const fallbackCount = Math.max(0, Number(result.fallback_count) || 0);
  const fullModelUsage =
    result.model_usage && typeof result.model_usage === "object"
      ? result.model_usage
      : {};
  const usageKeys = Object.keys(fullModelUsage).map(normalizedClaudeModel).filter(Boolean);
  const requestedUsage = usageKeys.filter((model) => canonicalClaudeSlug(model) === requested);
  const fallbackUsage = usageKeys.filter((model) => fallbackModels.includes(model));
  let observedModel =
    fallbackModels.at(-1) ||
    assistantModels.at(-1) ||
    fallbackUsage.at(-1) ||
    requestedUsage.at(-1) ||
    (usageKeys.length === 1 ? usageKeys[0] : "") ||
    "";
  if (!observedModel && process.env.CLAUDE_MOCK_RESPONSE_JSON !== undefined) {
    observedModel = normalizedClaudeModel(candidateModel);
  }
  if (!observedModel && process.env.CLAUDE_MOCK_STREAM_JSONL !== undefined) {
    observedModel = normalizedClaudeModel(candidateModel);
  }
  const actualCanonical = canonicalClaudeSlug(observedModel);
  const exact = Boolean(observedModel) && actualCanonical === requested && fallbackCount === 0;
  const primaryModelUsage = {};
  const auxiliaryModelUsage = {};
  for (const [model, usage] of Object.entries(fullModelUsage)) {
    if (canonicalClaudeSlug(model) === actualCanonical) primaryModelUsage[model] = usage;
    else auxiliaryModelUsage[model] = usage;
  }
  return {
    schema: "TatwoGatewayModelAttestationV1",
    requested_model: requested,
    requested_vendor_model: normalizedClaudeModel(candidateModel),
    actual_canonical_model: actualCanonical,
    actual_vendor_model: observedModel,
    assistant_models: assistantModels,
    fallback_models: fallbackModels,
    fallback_count: fallbackCount,
    modelUsage: primaryModelUsage,
    auxiliary_model_usage: auxiliaryModelUsage,
    outcome: exact ? "VERIFIED_EXACT" : observedModel ? "FAIL_CLOSED_MISMATCH" : "ATTESTATION_MISSING",
    exact,
  };
}

function applyClaudeAttestation(requestedSlug, candidateModel, result) {
  const attestation = claudeExecutionAttestation(requestedSlug, candidateModel, result);
  result.attestation = attestation;
  if (!attestation.exact) {
    result.ok = false;
    result.raw_error = [
      result.raw_error,
      `model attestation ${attestation.outcome}: requested=${attestation.requested_model} observed=${attestation.actual_vendor_model || "missing"} fallback_count=${attestation.fallback_count}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return result;
}

function attestationResponseOptions(result = {}) {
  const attestation = result.attestation;
  if (!attestation) return {};
  return {
    requested_model: attestation.requested_model,
    actual_model: attestation.actual_vendor_model,
    assistant_models: attestation.assistant_models,
    modelUsage: attestation.modelUsage,
    auxiliary_model_usage: attestation.auxiliary_model_usage,
    fallback_count: attestation.fallback_count,
    fallback_models: attestation.fallback_models,
    model_attestation: attestation,
  };
}

function classifyUpstreamFailure(error, context = {}) {
  const text = String(error?.message || error || "");
  const status = Number(error?.status || 0);
  const partialOutput = Boolean(context.partialOutput);
  const kind = classifyErrorKind(text, error?.signal || context.signal);
  if (partialOutput) {
    const retryAllowed = ["upstream_5xx", "network", "timeout"].includes(kind);
    return {
      class: "partial_output",
      kind,
      fatal: false,
      completedNotice: !retryAllowed,
      retryAllowed,
      reason: retryAllowed
        ? "partial output ended on a retriable upstream transport failure"
        : "partial output already reached the client; complete with gateway notice to avoid retry storm",
    };
  }
  if (/not exposed in this Codex request|claimed GUI\/computer-use actions|computer-use tools/i.test(text)) {
    return { class: "fatal", kind: "tool_security", fatal: true, completedNotice: false, reason: "tool safety fail-closed" };
  }
  if (status === 401 || status === 403 || kind === "auth") {
    return { class: "operational", kind: "auth", fatal: false, completedNotice: true, reason: "authentication requires user/session repair without triggering a retry storm" };
  }
  if (/invalid model|unknown model|unsupported model/i.test(text)) {
    return { class: "fatal", kind: "model", fatal: true, completedNotice: false, reason: "requested model slug is invalid" };
  }
  if (/cannot be used as an advisor|advisor model/i.test(text)) {
    return {
      class: "configuration",
      kind: "configuration",
      fatal: false,
      completedNotice: true,
      reason: "Claude advisor configuration is incompatible with the requested model; return one visible notice instead of a retry storm",
    };
  }
  if (/content policy|safety policy|policy violation|blocked content/i.test(text)) {
    return { class: "operational", kind: "policy", fatal: false, completedNotice: true, reason: "policy refusal must remain visible without tearing down the chat stream" };
  }
  if (
    kind === "quota" ||
    /session limit|rate limit|rate_limit|resets|quota|usage limit|billing|credit|payment|429/i.test(text)
  ) {
    return { class: "transient", kind: "quota", fatal: false, completedNotice: true, reason: "quota/rate/session limit should not trigger Codex App retry storm" };
  }
  if (
    kind === "model" &&
    /not available|currently unavailable|temporarily unavailable|unavailable/i.test(text)
  ) {
    return { class: "transient", kind: "model", fatal: false, completedNotice: true, reason: "explicit model availability notices must remain visible without triggering a retry storm" };
  }
  if (
    /disabled by policy|api spend policy|spend (?:is )?(?:not allowed|denied|disabled)|GATEWAY_API_MODEL_ALLOWLIST/i.test(text)
  ) {
    return { class: "operational", kind: "policy", fatal: false, completedNotice: true, reason: "API spend policy denials are operational notices, not retriable transport failures" };
  }
  if (
    kind === "parse" &&
    /empty output|no result event|zero[- ]result/i.test(text)
  ) {
    return { class: "operational", kind: "parse", fatal: false, completedNotice: true, reason: "zero-result backend completion must stay visible while route health remains fail closed" };
  }
  if (kind === "model_attestation") {
    return { class: "configuration", kind, fatal: false, completedNotice: true, reason: "requested and observed models differ; fail closed with a visible completed notice" };
  }
  if ((status >= 500 && status < 600) || kind === "upstream_5xx") {
    return {
      class: "transient",
      kind: "upstream_5xx",
      fatal: false,
      completedNotice: false,
      retryAllowed: true,
      reason: "explicit upstream 5xx or overload must preserve retriable failure semantics",
    };
  }
  if (kind === "network" || kind === "timeout") {
    return {
      class: "transient",
      kind,
      fatal: false,
      completedNotice: false,
      retryAllowed: true,
      reason: "network/timeout failures must remain retriable instead of becoming assistant completions",
    };
  }
  if (/disabled by policy|subscription|currently unavailable|temporarily unavailable|unavailable/i.test(text)) {
    return { class: "transient", kind: kind === "unknown" ? "unavailable" : kind, fatal: false, completedNotice: true, reason: "external backend unavailable or disabled by policy" };
  }
  return { class: "operational", kind: kind === "unknown" ? "unavailable" : kind, fatal: false, completedNotice: true, reason: "zero-output or unknown backend failure should not tear down the chat stream" };
}

function isBackendNoticeError(error) {
  return classifyUpstreamFailure(error).completedNotice;
}

function backendNoticeText(model, error) {
  const failure = classifyUpstreamFailure(error);
  const message = String(error?.message || "backend unavailable")
    .replace(/\s+/g, " ")
    .slice(0, 500);
  return [
    `[gateway-notice] ${model} upstream degraded (${failure.kind}/${failure.class}): ${message}`,
    "Codex model_gateway returned this as a completed assistant message so Codex App will not enter a retry loop.",
  ].join("\n");
}

function stripShellQuotes(value) {
  const text = String(value || "").trim();
  if ((text.startsWith("'") && text.endsWith("'")) || (text.startsWith('"') && text.endsWith('"'))) {
    return text.slice(1, -1);
  }
  return text;
}

function readMiniMaxApiKey() {
  if (process.env.MINIMAX_API_KEY) return process.env.MINIMAX_API_KEY.trim();
  const file = process.env.MINIMAX_API_KEY_FILE;
  if (!file) return "";
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^(?:export\s+)?MINIMAX_API_KEY=(.*)$/);
      if (match) return stripShellQuotes(match[1]).trim();
    }
    const fallback = raw.trim();
    return fallback.startsWith("sk-") ? fallback : "";
  } catch {
    return "";
  }
}

function minimaxSpendAllowed() {
  const allowlist = new Set(apiSpendPolicy.active_api_model_allowlist);
  return allowlist.has(MINIMAX_API_SPEND_CLASS) || allowlist.has("user-approved-api:minimax/MiniMax-M3");
}

function normalizeMiniMaxResponse(payload) {
  if (typeof payload === "string") return payload.trim();
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.output_text === "string") return payload.output_text;
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.result === "string") return payload.result;
  if (typeof payload.message === "string") return payload.message;
  if (Array.isArray(payload.output)) {
    const parts = [];
    for (const item of payload.output) {
      if (!item || typeof item !== "object") continue;
      if (typeof item.text === "string") parts.push(item.text);
      if (typeof item.output_text === "string") parts.push(item.output_text);
      if (Array.isArray(item.content)) {
        parts.push(contentText(item.content));
      }
    }
    const joined = parts.filter(Boolean).join("\n").trim();
    if (joined) return joined;
  }
  if (Array.isArray(payload.choices)) {
    const choice = payload.choices[0];
    const text = choice?.message?.content || choice?.text || choice?.delta?.content;
    if (typeof text === "string") return text;
  }
  return JSON.stringify(payload);
}

async function runMiniMaxOnce(model, prompt, images = []) {
  if (process.env.MINIMAX_MOCK_RESPONSE_JSON !== undefined) {
    return {
      ok: true,
      model,
      code: 0,
      signal: null,
      text: process.env.MINIMAX_MOCK_RESPONSE_JSON,
      raw_error: "",
      usage: null,
    };
  }
  if (process.env.MINIMAX_MOCK_ERROR_TEXT !== undefined) {
    return {
      ok: false,
      model,
      code: 1,
      signal: null,
      text: "",
      raw_error: process.env.MINIMAX_MOCK_ERROR_TEXT,
      usage: null,
    };
  }
  if (!minimaxSpendAllowed()) {
    return {
      ok: false,
      model,
      code: 1,
      signal: null,
      text: "",
      raw_error: `MiniMax API route is disabled by policy: ${MINIMAX_API_SPEND_CLASS} is not in GATEWAY_API_MODEL_ALLOWLIST`,
      usage: null,
    };
  }
  const apiKey = readMiniMaxApiKey();
  if (!apiKey) {
    return {
      ok: false,
      model,
      code: 1,
      signal: null,
      text: "",
      raw_error: "MiniMax backend not authenticated: MINIMAX_API_KEY or MINIMAX_API_KEY_FILE is not configured",
      usage: null,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MINIMAX_TIMEOUT_MS);
  timer.unref();
  try {
    const system = [
      "You are being called by a local Codex model gateway.",
      GATEWAY_AUTHORITY_FRAME,
      "Answer directly unless the request includes a Codex request-scoped tool bridge and a tool is necessary.",
      "When using a bridged tool, return exactly one raw JSON object with tool_calls and no prose. Never execute Codex tools in MiniMax.",
    ].join(" ");
    const input = images.length > 0
      ? [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: prompt || "Describe the attached image." },
              ...images.map((image) => ({ type: "input_image", image_url: image.dataUrl })),
            ],
          },
        ]
      : `${system}\n\n${prompt}`;
    const response = await requestUpstreamText(`${MINIMAX_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        ...(images.length > 0 ? { instructions: system } : {}),
        input,
        stream: false,
      }),
      signal: controller.signal,
      maxBytes: MAX_CHILD_STDOUT,
    });
    const responseText = response.body;
    let payload = null;
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = null;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const message =
        payload?.error?.message || payload?.base_resp?.status_msg || payload?.message || responseText.slice(0, 500);
      return {
        ok: false,
        model,
        code: response.statusCode,
        signal: null,
        text: "",
        raw_error: `MiniMax API error ${response.statusCode}: ${message}`,
        usage: payload?.usage || null,
      };
    }
    return {
      ok: true,
      model,
      code: response.statusCode,
      signal: null,
      text: normalizeMiniMaxResponse(payload ?? responseText),
      raw_error: "",
      usage: payload?.usage || null,
    };
  } catch (error) {
    return {
      ok: false,
      model,
      code: null,
      signal: error.name === "AbortError" ? "timeout" : null,
      text: "",
      raw_error: error.name === "AbortError" ? `MiniMax API timed out after ${MINIMAX_TIMEOUT_MS}ms` : `MiniMax API request failed: ${error.message}`,
      usage: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runMiniMax(slug, prompt, images = []) {
  const route = minimaxRoutes[slug];
  if (!route) {
    throw Object.assign(new Error(`unknown model slug: ${slug}`), { status: 404 });
  }
  const preferred = minimaxRouteState[slug].backend_model;
  const candidates = [preferred, ...route.candidates].filter((model, index, arr) => model && arr.indexOf(model) === index);
  let last = null;
  for (const model of candidates) {
    const state = minimaxRouteState[slug];
    recordRouteAttemptStarted(state);
    let result;
    try {
      result = await runMiniMaxOnce(model, prompt, images);
    } catch (error) {
      recordRouteError(state, error?.message || String(error), error?.signal);
      recordRouteAttemptFinished(state);
      throw error;
    }
    last = result;
    if (result.ok) {
      recordRouteOk(state, model);
      recordRouteAttemptFinished(state);
      return result;
    }
    recordRouteError(state, result.raw_error || `minimax exited ${result.code}`, result.signal);
    recordRouteAttemptFinished(state);
    if (!isModelError(state.last_error)) break;
  }
  const err = new Error(last?.raw_error || "MiniMax backend failed");
  err.status = last?.code === 401 || last?.code === 403 ? last.code : 502;
  err.backend = last;
  throw err;
}

function signalChildTree(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
    }
  }
  try {
    return child.kill(signal);
  } catch {
    return false;
  }
}

function childProcessGroupAlive(child) {
  if (process.platform === "win32" || !child.pid) {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function installChildTermination(child, { abortSignal, timeoutMs, onAbort, onTimeout }) {
  let terminationReason = null;
  let escalationTimer = null;
  let lastForceKillAt = null;
  const forceKill = () => {
    escalationTimer = null;
    lastForceKillAt = Date.now();
    signalChildTree(child, "SIGKILL");
  };
  const scheduleEscalation = () => {
    if (escalationTimer) return;
    escalationTimer = setTimeout(forceKill, CLAUDE_ABORT_GRACE_MS);
    escalationTimer.unref?.();
  };
  const terminate = (reason, signal = "SIGTERM", escalate = signal !== "SIGKILL") => {
    if (terminationReason) return false;
    terminationReason = reason;
    if (reason === "client_disconnect") onAbort?.();
    if (reason === "timeout") onTimeout?.();
    signalChildTree(child, signal);
    if (signal === "SIGKILL") lastForceKillAt = Date.now();
    if (escalate) scheduleEscalation();
    return true;
  };
  const timeoutTimer = setTimeout(() => terminate("timeout"), timeoutMs);
  timeoutTimer.unref?.();
  const abortChild = () => terminate("client_disconnect");
  if (abortSignal?.aborted) {
    abortChild();
  } else {
    abortSignal?.addEventListener("abort", abortChild, { once: true });
  }
  return {
    terminate,
    get reason() {
      return terminationReason;
    },
    async waitForProcessGroupExit() {
      clearTimeout(timeoutTimer);
      abortSignal?.removeEventListener("abort", abortChild);
      if (!childProcessGroupAlive(child)) {
        if (escalationTimer) clearTimeout(escalationTimer);
        return;
      }
      if (!terminationReason) {
        terminationReason = "descendant_process_group_leak";
        signalChildTree(child, "SIGTERM");
        scheduleEscalation();
      }
      while (childProcessGroupAlive(child)) {
        if (
          lastForceKillAt !== null &&
          Date.now() - lastForceKillAt >= 1000
        ) {
          forceKill();
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (escalationTimer) clearTimeout(escalationTimer);
    },
  };
}

function runClaudeOnce(
  model,
  prompt,
  reasoningControl,
  abortSignal,
  continuationPlan = null,
) {
  return new Promise((resolve) => {
    const resolveMock = (payload) => {
      const delayMs = Number(process.env.CLAUDE_MOCK_DELAY_MS || 0);
      if (delayMs > 0) {
        setTimeout(() => resolve(payload), delayMs).unref?.();
        return;
      }
      resolve(payload);
    };
    if (process.env.CLAUDE_MOCK_PROMPT_FILE) {
      fs.writeFileSync(process.env.CLAUDE_MOCK_PROMPT_FILE, prompt);
    }
    if (process.env.CLAUDE_MOCK_ERROR_TEXT !== undefined) {
      resolveMock({
        ok: false,
        model,
        code: 1,
        signal: null,
        text: "",
        raw_error: process.env.CLAUDE_MOCK_ERROR_TEXT,
        usage: null,
        reasoning_control: reasoningControl,
      });
      return;
    }
    if (process.env.CLAUDE_MOCK_RESPONSE_JSON !== undefined) {
      let mockUsage = null;
      try { mockUsage = JSON.parse(process.env.CLAUDE_MOCK_USAGE_JSON || "null"); } catch {}
      resolveMock({
        ok: true,
        model,
        code: 0,
        signal: null,
        text: process.env.CLAUDE_MOCK_RESPONSE_JSON,
        raw_error: "",
        usage: mockUsage,
        provider_session_id:
          continuationPlan?.providerSessionID
          || String(process.env.CLAUDE_MOCK_PROVIDER_SESSION_ID || ""),
        reasoning_control: reasoningControl,
      });
      return;
    }
    const forwardedControl = forwardedReasoningControl(reasoningControl);
    const child = spawn(
      CLAUDE_COMMAND,
      claudeArgs(
        model,
        prompt,
        reasoningControl,
        continuationPlan,
      ),
      {
      cwd: "/tmp",
      env: claudeChildEnv(reasoningControl),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      },
    );
    let stdout = "";
    let stderr = "";
    const termination = installChildTermination(child, {
      abortSignal,
      timeoutMs: CLAUDE_TIMEOUT_MS,
      onAbort: () => {
        stderr += "\nclient disconnected; claude CLI abort requested";
      },
      onTimeout: () => {
        stderr += `\nclaude CLI timed out after ${CLAUDE_TIMEOUT_MS}ms`;
      },
    });
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_CHILD_STDOUT) {
        stderr += `\nclaude CLI stdout exceeded ${MAX_CHILD_STDOUT} bytes; aborted`;
        termination.terminate("output_cap", "SIGKILL", false);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_CHILD_STDOUT) stderr += chunk;
    });
    child.on("error", (error) => {
      if (stderr.length < MAX_CHILD_STDOUT) {
        stderr += `\nfailed to start claude CLI (${CLAUDE_COMMAND}): ${error.message}`;
      }
    });
    child.on("close", async (code, signal) => {
      await termination.waitForProcessGroupExit();
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = null;
      }
      const observation = createClaudeObservation();
      observeClaudeEvent(parsed, observation);
      const result = parsed?.result || "";
      const emptyOutput = !stdout.trim();
      const isError =
        Boolean(parsed?.is_error) ||
        code !== 0 ||
        Boolean(signal) ||
        Boolean(termination.reason) ||
        emptyOutput;
      finish({
        ok: !isError,
        model,
        code,
        signal,
        text: result,
        raw_error: [
          stderr,
          parsed?.result || "",
          termination.reason ? `claude termination reason: ${termination.reason}` : "",
          emptyOutput ? "claude returned empty output" : "",
        ]
          .filter(Boolean)
          .join("\n")
          .trim(),
        usage: parsed?.usage || null,
        total_cost_usd: parsed?.total_cost_usd,
        duration_ms: parsed?.duration_ms,
        provider_session_id: String(
          parsed?.session_id || parsed?.sessionId || "",
        ).trim(),
        reasoning_control: forwardedControl,
        ...claudeObservationPayload(observation),
      });
    });
    writeClaudeTextPrompt(child, prompt, (error) => {
      if (stderr.length < MAX_CHILD_STDOUT) {
        stderr += `\nfailed to write Claude prompt to stdin: ${error.message}`;
      }
    });
  });
}

function claudeStreamInputArgs(
  model,
  reasoningControl,
  continuationPlan = null,
) {
  return [
    "-p",
    "--safe-mode",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    "--model",
    model,
    ...reasoningCliArgs(reasoningControl),
    ...tatwoGatewayContinuation.providerSessionArguments(
      continuationPlan,
      "claude",
    ),
    "--mcp-config",
    '{"mcpServers":{}}',
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--disallowedTools",
    "*",
    "--system-prompt",
    claudeSystemPrompt(),
  ];
}

function claudeVisionMessage(prompt, images) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "text", text: prompt || "Describe the attached image." },
        ...images.map((image) => ({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mimeType,
            data: image.base64,
          },
        })),
      ],
    },
    parent_tool_use_id: null,
  };
}

function runClaudeVisionOnce(
  model,
  prompt,
  images,
  reasoningControl,
  abortSignal,
  continuationPlan = null,
) {
  const promptForMock = `${prompt}\n\nNATIVE_IMAGE_BLOCKS: ${images.length}`;
  const resolveMockLater = (resolve, payload) => {
    const delayMs = Number(process.env.CLAUDE_MOCK_DELAY_MS || 0);
    if (delayMs > 0) {
      setTimeout(() => resolve(payload), delayMs).unref?.();
      return;
    }
    resolve(payload);
  };
  return new Promise((resolve) => {
    if (process.env.CLAUDE_MOCK_PROMPT_FILE) {
      fs.writeFileSync(process.env.CLAUDE_MOCK_PROMPT_FILE, promptForMock);
    }
    if (process.env.CLAUDE_MOCK_ERROR_TEXT !== undefined) {
      resolveMockLater(resolve, {
        ok: false,
        model,
        code: 1,
        signal: null,
        text: "",
        raw_error: process.env.CLAUDE_MOCK_ERROR_TEXT,
        usage: null,
        reasoning_control: reasoningControl,
      });
      return;
    }
    if (process.env.CLAUDE_MOCK_RESPONSE_JSON !== undefined) {
      let mockUsage = null;
      try { mockUsage = JSON.parse(process.env.CLAUDE_MOCK_USAGE_JSON || "null"); } catch {}
      resolveMockLater(resolve, {
        ok: true,
        model,
        code: 0,
        signal: null,
        text: process.env.CLAUDE_MOCK_RESPONSE_JSON,
        raw_error: "",
        usage: mockUsage,
        provider_session_id:
          continuationPlan?.providerSessionID
          || String(process.env.CLAUDE_MOCK_PROVIDER_SESSION_ID || ""),
        reasoning_control: reasoningControl,
      });
      return;
    }
    const forwardedControl = forwardedReasoningControl(reasoningControl);
    const child = spawn(
      CLAUDE_COMMAND,
      claudeStreamInputArgs(
        model,
        reasoningControl,
        continuationPlan,
      ),
      {
      cwd: "/tmp",
      env: claudeChildEnv(reasoningControl),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      },
    );
    let stderr = "";
    let buffer = "";
    let bytes = 0;
    let finalEvent = null;
    const observation = createClaudeObservation();
    let settled = false;
    const termination = installChildTermination(child, {
      abortSignal,
      timeoutMs: CLAUDE_TIMEOUT_MS,
      onAbort: () => {
        stderr += "\nclient disconnected; claude vision CLI abort requested";
      },
      onTimeout: () => {
        stderr += `\nclaude vision CLI timed out after ${CLAUDE_TIMEOUT_MS}ms`;
      },
    });
    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj = null;
      try { obj = JSON.parse(trimmed); } catch { return; }
      observeClaudeEvent(obj, observation);
      if (obj.type === "result") finalEvent = obj;
    };
    const finish = async (code, signal) => {
      if (settled) return;
      settled = true;
      await termination.waitForProcessGroupExit();
      if (buffer) handleLine(buffer);
      const text = typeof finalEvent?.result === "string" ? finalEvent.result : "";
      const isError =
        Boolean(finalEvent?.is_error) ||
        code !== 0 ||
        Boolean(signal) ||
        Boolean(termination.reason) ||
        !finalEvent;
      resolve({
        ok: !isError,
        model,
        code,
        signal,
        text,
        raw_error: isError
          ? [
              stderr,
              finalEvent?.result || "",
              termination.reason ? `claude termination reason: ${termination.reason}` : "",
              !finalEvent ? "claude vision stream produced no result event" : "",
            ]
              .filter(Boolean)
              .join("\n")
              .trim()
          : "",
        usage: finalEvent?.usage || null,
        total_cost_usd: finalEvent?.total_cost_usd,
        duration_ms: finalEvent?.duration_ms,
        provider_session_id: String(
          finalEvent?.session_id || finalEvent?.sessionId || "",
        ).trim(),
        reasoning_control: forwardedControl,
        ...claudeObservationPayload(observation),
      });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_CHILD_STDOUT) {
        stderr += `\nclaude CLI stdout exceeded ${MAX_CHILD_STDOUT} bytes; aborted`;
        termination.terminate("output_cap", "SIGKILL", false);
        return;
      }
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_CHILD_STDOUT) stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += `\nfailed to start claude CLI (${CLAUDE_COMMAND}): ${error.message}`;
    });
    child.on("close", (code, signal) => {
      void finish(code, signal);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(`${JSON.stringify(claudeVisionMessage(prompt, images))}\n`);
  });
}

async function runClaude(
  slug,
  prompt,
  images = [],
  reasoningControl,
  abortSignal,
  continuationPlan = null,
) {
  const canonicalSlug = claudeAliases[slug] || slug;
  const route = claudeRoutes[canonicalSlug];
  if (!route) {
    throw Object.assign(new Error(`unknown model slug: ${slug}`), { status: 404 });
  }
  const preferred = routeState[canonicalSlug].backend_model;
  const candidates = [preferred, ...route.candidates].filter(
    (model, index, arr) => model && arr.indexOf(model) === index,
  );
  let last = null;
  for (const model of candidates) {
    const state = routeState[canonicalSlug];
    recordRouteAttemptStarted(state);
    const markAborting = () => recordRouteAbortRequested(state);
    if (abortSignal?.aborted) markAborting();
    else abortSignal?.addEventListener("abort", markAborting, { once: true });
    let result;
    try {
      result =
        images.length > 0
          ? await runClaudeVisionOnce(
              model,
              prompt,
              images,
              reasoningControl,
              abortSignal,
              continuationPlan,
            )
          : await runClaudeOnce(
              model,
              prompt,
              reasoningControl,
              abortSignal,
              continuationPlan,
            );
    } catch (error) {
      abortSignal?.removeEventListener("abort", markAborting);
      recordRouteError(state, error?.message || String(error), error?.signal);
      recordRouteAttemptFinished(state);
      throw error;
    }
    abortSignal?.removeEventListener("abort", markAborting);
    if (result.ok) applyClaudeAttestation(canonicalSlug, model, result);
    last = result;
    if (result.ok) {
      recordRouteOk(state, model);
      recordRouteAttemptFinished(state);
      return result;
    }
    recordRouteError(state, result.raw_error || `claude exited ${result.code}`, result.signal);
    recordRouteAttemptFinished(state);
    if (abortSignal?.aborted) break;
    if (!isModelError(state.last_error)) break;
  }
  const err = new Error(last?.raw_error || "Claude backend failed");
  err.status = 502;
  err.backend = last;
  throw err;
}

// ---- Claude true streaming (text-only turns) -------------------------------
// Tool-bridge turns stay buffered: a streamed tool-intent JSON would leak to the
// user as visible text before the gateway can convert it to a function_call.
// (CLAUDE_STREAMING is declared near the top with the other env constants.)

function claudeStreamArgs(
  model,
  prompt,
  reasoningControl,
  continuationPlan = null,
) {
  // Same hardened flags as claudeArgs, but stream-json with partial deltas.
  // --verbose is required by the claude CLI for stream-json in -p mode.
  const args = claudeArgs(
    model,
    prompt,
    reasoningControl,
    continuationPlan,
  );
  const i = args.indexOf("--output-format");
  args[i + 1] = "stream-json";
  args.splice(i + 2, 0, "--include-partial-messages", "--verbose");
  return args;
}

function runClaudeStreamingOnce(
  model,
  prompt,
  reasoningControl,
  onDelta,
  abortSignal,
  continuationPlan = null,
) {
  // Buffered-mock delegation keeps the existing test/mocking surface working:
  // the handler emits the full text as a single delta when none were streamed.
  if (
    process.env.CLAUDE_MOCK_STREAM_JSONL === undefined &&
    (process.env.CLAUDE_MOCK_RESPONSE_JSON !== undefined || process.env.CLAUDE_MOCK_ERROR_TEXT !== undefined)
  ) {
    return runClaudeOnce(
      model,
      prompt,
      reasoningControl,
      abortSignal,
      continuationPlan,
    ).then((result) => ({ ...result, accumulated: "" }));
  }
  return new Promise((resolve) => {
    let acc = "";
    let finalEvent = null;
    const observation = createClaudeObservation();
    let termination = null;
    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj = null;
      try { obj = JSON.parse(trimmed); } catch { return; }
      observeClaudeEvent(obj, observation);
      if (obj.type === "stream_event") {
        const ev = obj.event || {};
        // thinking_delta and other block types are internal — never streamed out.
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && typeof ev.delta.text === "string") {
          acc += ev.delta.text;
          onDelta(ev.delta.text);
        }
        return;
      }
      if (obj.type === "result") finalEvent = obj;
    };
    const finalize = (code, signal, rawTail) => {
      // The result event's full text is authoritative; accumulated deltas are the
      // fallback for older CLIs without --include-partial-messages support.
      const text = typeof finalEvent?.result === "string" && finalEvent.result ? finalEvent.result : acc;
      const isError =
        Boolean(finalEvent?.is_error) ||
        code !== 0 ||
        Boolean(signal) ||
        Boolean(termination?.reason) ||
        (!text && !finalEvent);
      resolve({
        ok: !isError,
        model,
        code,
        signal,
        text,
        accumulated: acc,
        raw_error: isError
          ? [
              rawTail,
              finalEvent?.result || "",
              termination?.reason ? `claude termination reason: ${termination.reason}` : "",
              !finalEvent ? "claude stream produced no result event" : "",
            ]
              .filter(Boolean)
              .join("\n")
              .trim()
          : "",
        usage: finalEvent?.usage || null,
        provider_session_id: String(
          finalEvent?.session_id || finalEvent?.sessionId || "",
        ).trim(),
        reasoning_control: termination === null ? reasoningControl : forwardedReasoningControl(reasoningControl),
        ...claudeObservationPayload(observation),
      });
    };
    if (process.env.CLAUDE_MOCK_STREAM_JSONL !== undefined) {
      if (process.env.CLAUDE_MOCK_PROMPT_FILE) fs.writeFileSync(process.env.CLAUDE_MOCK_PROMPT_FILE, prompt);
      for (const line of String(process.env.CLAUDE_MOCK_STREAM_JSONL).split("\n")) handleLine(line);
      finalize(0, null, "");
      return;
    }
    if (abortSignal?.aborted) {
      finalize(null, "SIGTERM", "client disconnected before claude CLI started");
      return;
    }
    const child = spawn(
      CLAUDE_COMMAND,
      claudeStreamArgs(
        model,
        prompt,
        reasoningControl,
        continuationPlan,
      ),
      {
      cwd: "/tmp",
      env: claudeChildEnv(reasoningControl),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      },
    );
    let stderr = "";
    let buffer = "";
    let bytes = 0;
    let settled = false;
    termination = installChildTermination(child, {
      abortSignal,
      timeoutMs: CLAUDE_TIMEOUT_MS,
      onAbort: () => {
        stderr += "\nclient disconnected; claude CLI abort requested";
      },
      onTimeout: () => {
        stderr += `\nclaude streaming CLI timed out after ${CLAUDE_TIMEOUT_MS}ms`;
      },
    });
    const finish = async (code, signal) => {
      if (settled) return;
      settled = true;
      await termination.waitForProcessGroupExit();
      if (buffer) handleLine(buffer);
      finalize(code, signal, stderr);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_CHILD_STDOUT) {
        stderr += `\nclaude CLI stdout exceeded ${MAX_CHILD_STDOUT} bytes; aborted`;
        termination.terminate("output_cap", "SIGKILL", false);
        return;
      }
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_CHILD_STDOUT) stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += `\nfailed to start claude CLI (${CLAUDE_COMMAND}): ${error.message}`;
    });
    child.on("close", (code, signal) => {
      void finish(code, signal);
    });
    writeClaudeTextPrompt(child, prompt, (error) => {
      if (stderr.length < MAX_CHILD_STDOUT) {
        stderr += `\nfailed to write Claude streaming prompt to stdin: ${error.message}`;
      }
    });
  });
}

async function runClaudeStreaming(
  slug,
  prompt,
  reasoningControl,
  onDelta,
  abortSignal,
  continuationPlan = null,
) {
  const canonicalSlug = claudeAliases[slug] || slug;
  const route = claudeRoutes[canonicalSlug];
  if (!route) {
    throw Object.assign(new Error(`unknown model slug: ${slug}`), { status: 404 });
  }
  const preferred = routeState[canonicalSlug].backend_model;
  const candidates = [preferred, ...route.candidates].filter(
    (model, index, arr) => model && arr.indexOf(model) === index,
  );
  let last = null;
  for (const model of candidates) {
    const state = routeState[canonicalSlug];
    recordRouteAttemptStarted(state);
    const markAborting = () => recordRouteAbortRequested(state);
    if (abortSignal?.aborted) markAborting();
    else abortSignal?.addEventListener("abort", markAborting, { once: true });
    let deltasSent = false;
    const wrapped = (delta) => {
      deltasSent = true;
      onDelta(delta);
    };
    let result;
    try {
      result = await runClaudeStreamingOnce(
        model,
        prompt,
        reasoningControl,
        wrapped,
        abortSignal,
        continuationPlan,
      );
    } catch (error) {
      abortSignal?.removeEventListener("abort", markAborting);
      recordRouteError(state, error?.message || String(error), error?.signal);
      recordRouteAttemptFinished(state);
      throw error;
    }
    abortSignal?.removeEventListener("abort", markAborting);
    result.deltasSent = deltasSent;
    if (result.ok) applyClaudeAttestation(canonicalSlug, model, result);
    last = result;
    if (result.ok) {
      recordRouteOk(state, model);
      recordRouteAttemptFinished(state);
      return result;
    }
    recordRouteError(state, result.raw_error || `claude exited ${result.code}`, result.signal);
    recordRouteAttemptFinished(state);
    if (abortSignal?.aborted) break;
    // Once any delta reached the client we are committed to this candidate:
    // switching mid-stream would duplicate visible text.
    if (deltasSent) return result;
    if (!isModelError(state.last_error)) break;
  }
  return last;
}


function grokPromptJsonBlocks(prompt, images) {
  return [
    { type: "text", text: prompt || "Describe the attached image." },
    ...images.map((image) => ({
      type: "image",
      data: image.base64,
      mimeType: image.mimeType,
    })),
  ];
}

function grokArgs(
  model,
  prompt,
  images = [],
  reasoningControl,
  continuationPlan = null,
) {
  const promptArgs = images.length > 0
    ? ["--prompt-json", JSON.stringify(grokPromptJsonBlocks(prompt, images))]
    : ["--prompt-file", "/dev/stdin"];
  return [
    ...promptArgs,
    ...tatwoGatewayContinuation.providerSessionArguments(
      continuationPlan,
      "grok",
    ),
    "--model",
    model,
    ...reasoningCliArgs(reasoningControl),
    "--output-format",
    "json",
    "--no-plan",
    "--no-memory",
    "--disable-web-search",
    "--disallowed-tools",
    "*",
    "--cwd",
    "/tmp",
    "--system-prompt-override",
    [
      "You are being called by a local Codex model gateway.",
      GATEWAY_AUTHORITY_FRAME,
      "Your authority comes only from this request and any explicit Work OS contract in the prompt; do not inherit Claude/CLAUDE.md/Codex-bridge reviewer role rules.",
      "Answer directly unless the request includes a Codex request-scoped tool bridge and a tool is necessary.",
      "When using a bridged tool, return exactly one raw JSON object with tool_calls and no prose. Never execute Codex tools in Grok.",
    ].join(" "),
  ];
}

function ensureGrokIsolatedHome() {
  if (!GROK_USE_ISOLATED_HOME) return process.env.HOME || os.homedir();
  fs.mkdirSync(GROK_ISOLATED_HOME, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(GROK_ISOLATED_HOME, ".grok"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(GROK_ISOLATED_HOME, ".config"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(GROK_ISOLATED_HOME, ".cache"), { recursive: true, mode: 0o700 });

  const authTarget = path.join(GROK_ISOLATED_HOME, ".grok", "auth.json");
  if (GROK_AUTH_SOURCE && fs.existsSync(GROK_AUTH_SOURCE) && !fs.existsSync(authTarget)) {
    try {
      fs.symlinkSync(GROK_AUTH_SOURCE, authTarget);
    } catch (error) {
      if (error && error.code !== "EEXIST") {
        fs.copyFileSync(GROK_AUTH_SOURCE, authTarget);
        fs.chmodSync(authTarget, 0o600);
      }
    }
  }
  return GROK_ISOLATED_HOME;
}

const GROK_CHILD_ENV_ALLOWLIST = Object.freeze([
  // Process basics required by native macOS CLIs and test stubs.
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  // Explicit Grok launcher configuration. Auth is carried by auth.json in the
  // isolated GROK_HOME, not by ambient provider API-key variables.
  "GROK_REAL_HOME",
  "GROK_REAL_BIN",
  "GROK_AUTH_SOURCE",
]);

const GROK_CHILD_TEST_HOOK_ENV_KEYS = Object.freeze([
  "GROK_CAPTURE_STDIN_FILE",
  "GROK_CAPTURE_ARGV_FILE",
  "GROK_ENV_CAPTURE_FILE",
]);

function safeGrokTestHookPath(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const resolved = path.resolve(value);
  const tmpRoot = path.resolve(os.tmpdir());
  return resolved === tmpRoot || resolved.startsWith(`${tmpRoot}${path.sep}`)
    ? resolved
    : null;
}

function applyGrokTestHookEnv(env) {
  if (process.env.GATEWAY_ENABLE_GROK_TEST_HOOKS !== "1") return;
  for (const key of GROK_CHILD_TEST_HOOK_ENV_KEYS) {
    const safePath = safeGrokTestHookPath(process.env[key]);
    if (safePath) env[key] = safePath;
  }
}

function grokChildEnv() {
  const home = ensureGrokIsolatedHome();
  const env = {};
  for (const key of GROK_CHILD_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME = home;
  env.GROK_HOME = path.join(home, ".grok");
  env.GROK_ISOLATED_HOME = home;
  env.XDG_CONFIG_HOME = path.join(home, ".config");
  env.XDG_CACHE_HOME = path.join(home, ".cache");
  env.GROK_ISOLATED_DEFAULT_NO_MEMORY = "1";
  env.GROK_ISOLATED_APPEND_TATWO_RULES = "1";
  applyGrokTestHookEnv(env);
  return env;
}

function normalizeGrokResult(stdout) {
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      text: String(stdout || "").trim(),
      sessionId: "",
      requestId: "",
    };
  }
  return {
    text: String(parsed.text || parsed.result || parsed.output_text || parsed.message || ""),
    sessionId: String(parsed.sessionId || parsed.session_id || "").trim(),
    requestId: String(parsed.requestId || parsed.request_id || "").trim(),
  };
}

function normalizedGrokModel(value) {
  return String(value || "").trim().toLowerCase();
}

function canonicalGrokSlug(value) {
  const normalized = normalizedGrokModel(value);
  if (normalized === "grok-4.6" || normalized === "grok-build") return "grok-build";
  return normalized;
}

function isSuccessfulGrokTurnOutcome(value) {
  // Grok CLI session state has emitted both `success` and `completed` for a
  // normally finished turn across versions. Keep this as a strict positive
  // allowlist: missing, cancelled, failed, error, or any future unknown value
  // still fails closed.
  return value === "success" || value === "completed";
}

function publicGrokSessionEvidence(value = {}) {
  return {
    source: "grok_cli_session_state",
    synthetic: value.synthetic === true,
    session_id_sha256: String(value.session_id_sha256 || ""),
    summary_session_id_matches: value.summary_session_id_matches === true,
    request_id_consistent: value.request_id_consistent === true,
    summary_current_model_id: normalizedGrokModel(value.summary_current_model_id),
    turn_started_model_id: normalizedGrokModel(value.turn_started_model_id),
    turn_ended_outcome: String(value.turn_ended_outcome || "").trim().toLowerCase(),
    turn_number: Number.isInteger(value.turn_number) ? value.turn_number : null,
  };
}

function readFileTailUTF8(filePath, maxBytes = 1024 * 1024) {
  const stat = fs.statSync(filePath);
  const length = Math.min(stat.size, maxBytes);
  const start = Math.max(0, stat.size - length);
  const descriptor = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(descriptor, buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline >= 0 ? text.slice(newline + 1) : "";
    }
    return text;
  } finally {
    fs.closeSync(descriptor);
  }
}

function grokSessionStateEvidence(sessionId, requestId, childEnv, cwd) {
  if (process.env.GROK_MOCK_SESSION_STATE_JSON !== undefined) {
    try {
      const mock = JSON.parse(process.env.GROK_MOCK_SESSION_STATE_JSON);
      return publicGrokSessionEvidence({
        ...mock,
        synthetic: true,
        session_id_sha256:
          mock.session_id_sha256
          || crypto.createHash("sha256").update(String(mock.session_id || sessionId || "")).digest("hex"),
      });
    } catch {
      return publicGrokSessionEvidence({ synthetic: true });
    }
  }
  if (!sessionId || !requestId) return publicGrokSessionEvidence();
  try {
    const resolvedCwd = fs.realpathSync(cwd);
    const sessionRoot = path.join(
      childEnv.GROK_HOME,
      "sessions",
      encodeURIComponent(resolvedCwd),
      sessionId,
    );
    const summary = JSON.parse(fs.readFileSync(path.join(sessionRoot, "summary.json"), "utf8"));
    const events = readFileTailUTF8(path.join(sessionRoot, "events.jsonl"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    let startedIndex = -1;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (events[index]?.type === "turn_started" && events[index]?.session_id === sessionId) {
        startedIndex = index;
        break;
      }
    }
    const started = startedIndex >= 0 ? events[startedIndex] : null;
    let ended = null;
    if (startedIndex >= 0) {
      for (let index = events.length - 1; index > startedIndex; index -= 1) {
        if (events[index]?.type === "turn_ended") {
          ended = events[index];
          break;
        }
      }
    }
    return publicGrokSessionEvidence({
      session_id_sha256: crypto.createHash("sha256").update(sessionId).digest("hex"),
      summary_session_id_matches: summary?.info?.id === sessionId,
      request_id_consistent:
        Boolean(summary?.request_id)
        && String(summary.request_id) === requestId,
      summary_current_model_id: summary?.current_model_id,
      turn_started_model_id: started?.model_id,
      turn_ended_outcome: ended?.outcome,
      turn_number: Number.isInteger(started?.turn_number) ? started.turn_number : null,
    });
  } catch {
    return publicGrokSessionEvidence();
  }
}

function grokExecutionAttestation(requestedSlug, candidateModel, result, fallbackCount = 0) {
  const requested = canonicalGrokSlug(requestedSlug);
  const evidence = publicGrokSessionEvidence(result.grok_session_evidence);
  const summaryModel = evidence.summary_current_model_id;
  const startedModel = evidence.turn_started_model_id;
  const observedModel =
    summaryModel
    && startedModel
    && summaryModel === startedModel
      ? summaryModel
      : summaryModel || startedModel || "";
  const actualCanonical = canonicalGrokSlug(observedModel);
  const evidenceComplete =
    Boolean(evidence.session_id_sha256)
    && evidence.summary_session_id_matches
    && evidence.request_id_consistent
    && Boolean(summaryModel)
    && summaryModel === startedModel
    && isSuccessfulGrokTurnOutcome(evidence.turn_ended_outcome);
  const exact =
    evidenceComplete
    && actualCanonical === requested
    && fallbackCount === 0;
  return {
    schema: "TatwoGatewayModelAttestationV1",
    evidence_source: "grok_cli_session_state",
    requested_model: requested,
    requested_vendor_model: normalizedGrokModel(candidateModel),
    actual_canonical_model: actualCanonical,
    actual_vendor_model: observedModel,
    assistant_models: observedModel ? [observedModel] : [],
    fallback_models: [],
    fallback_count: Math.max(0, Number(fallbackCount) || 0),
    modelUsage: {},
    auxiliary_model_usage: {},
    session_evidence: evidence,
    outcome: exact
      ? "VERIFIED_EXACT"
      : observedModel
        ? "FAIL_CLOSED_MISMATCH"
        : "ATTESTATION_MISSING",
    exact,
  };
}

function applyGrokAttestation(requestedSlug, candidateModel, result, fallbackCount = 0) {
  const attestation = grokExecutionAttestation(
    requestedSlug,
    candidateModel,
    result,
    fallbackCount,
  );
  result.attestation = attestation;
  result.fallback_count = attestation.fallback_count;
  if (!attestation.exact) {
    result.ok = false;
    result.raw_error = [
      result.raw_error,
      `model attestation ${attestation.outcome}: requested=${attestation.requested_model} observed=${attestation.actual_vendor_model || "missing"} fallback_count=${attestation.fallback_count} evidence=${attestation.evidence_source}`,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return result;
}

function runGrokOnce(
  model,
  prompt,
  images = [],
  reasoningControl,
  continuationPlan = null,
) {
  return new Promise((resolve) => {
    if (process.env.GROK_MOCK_PROMPT_FILE) {
      fs.writeFileSync(process.env.GROK_MOCK_PROMPT_FILE, `${prompt}\n\nNATIVE_IMAGE_BLOCKS: ${images.length}`);
    }
    if (process.env.GROK_MOCK_RESPONSE_JSON !== undefined) {
      const providerSessionID =
        continuationPlan?.providerSessionID
        || String(process.env.GROK_MOCK_PROVIDER_SESSION_ID || "")
        || "mock-grok-session";
      resolve({
        ok: true,
        model,
        code: 0,
        signal: null,
        text: process.env.GROK_MOCK_RESPONSE_JSON,
        raw_error: "",
        usage: null,
        grok_session_evidence: grokSessionStateEvidence(
          providerSessionID,
          "mock-grok-request",
          { GROK_HOME: path.join(GROK_ISOLATED_HOME, ".grok") },
          "/tmp",
        ),
        provider_session_id: providerSessionID,
        reasoning_control: reasoningControl,
      });
      return;
    }
    const forwardedControl = forwardedReasoningControl(reasoningControl);
    const childCwd = "/tmp";
    const childEnv = grokChildEnv();
    const textPromptReceipt =
      images.length === 0
        ? promptTransportReceipt(prompt, "stdin_via_prompt_file")
        : null;
    const child = spawn(
      GROK_COMMAND,
      grokArgs(
        model,
        prompt,
        images,
        reasoningControl,
        continuationPlan,
      ),
      {
      cwd: childCwd,
      env: childEnv,
      stdio: [images.length === 0 ? "pipe" : "ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, GROK_TIMEOUT_MS);
    timer.unref();
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_CHILD_STDOUT) {
        finish({
          ok: false,
          model,
          code: null,
          signal: null,
          text: "",
          raw_error: `grok CLI stdout exceeded ${MAX_CHILD_STDOUT} bytes; aborted`,
          usage: null,
          reasoning_control: forwardedControl,
          ...(textPromptReceipt ? { prompt_transport: textPromptReceipt } : {}),
        });
        child.kill("SIGKILL");
      }
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_CHILD_STDOUT) stderr += chunk;
    });
    child.on("error", (error) => {
      finish({
        ok: false,
        model,
        code: null,
        signal: null,
        text: "",
        raw_error: `failed to start grok CLI (${GROK_COMMAND}): ${error.message}`,
        usage: null,
        reasoning_control: forwardedControl,
      });
    });
    child.on("close", (code, signal) => {
      const normalized = normalizeGrokResult(stdout);
      const isError = code !== 0 || signal;
      finish({
        ok: !isError,
        model,
        code,
        signal,
        text: normalized.text,
        raw_error: [stderr, isError ? stdout : ""].filter(Boolean).join("\n").trim(),
        usage: null,
        grok_session_evidence: grokSessionStateEvidence(
          normalized.sessionId,
          normalized.requestId,
          childEnv,
          childCwd,
        ),
        provider_session_id: normalized.sessionId,
        reasoning_control: forwardedControl,
        ...(textPromptReceipt ? { prompt_transport: textPromptReceipt } : {}),
      });
    });
    if (images.length === 0) {
      writeGrokTextPrompt(child, prompt, (error) => {
        if (stderr.length < MAX_CHILD_STDOUT) {
          stderr += `\nfailed to write Grok prompt to stdin: ${error.message}`;
        }
      });
    }
  });
}

async function runGrok(
  slug,
  prompt,
  images = [],
  reasoningControl,
  continuationPlan = null,
) {
  const route = grokRoutes[slug];
  if (!route) {
    throw Object.assign(new Error(`unknown model slug: ${slug}`), { status: 404 });
  }
  const preferred = grokRouteState[slug].backend_model;
  const candidates = [preferred, ...route.candidates].filter((model, index, arr) => model && arr.indexOf(model) === index);
  let last = null;
  for (const [candidateIndex, model] of candidates.entries()) {
    const state = grokRouteState[slug];
    recordRouteAttemptStarted(state);
    let result;
    try {
      result = await runGrokOnce(
        model,
        prompt,
        images,
        reasoningControl,
        continuationPlan,
      );
    } catch (error) {
      recordRouteError(state, error?.message || String(error), error?.signal);
      recordRouteAttemptFinished(state);
      throw error;
    }
    last = result;
    if (result.ok) {
      applyGrokAttestation(slug, model, result, candidateIndex);
    }
    if (result.ok) {
      recordRouteOk(state, model);
      recordRouteAttemptFinished(state);
      return result;
    }
    recordRouteError(state, result.raw_error || `grok exited ${result.code}`, result.signal);
    recordRouteAttemptFinished(state);
    if (result.attestation) {
      const err = new Error(result.raw_error || "Grok model attestation failed");
      err.status = 502;
      err.backend = result;
      throw err;
    }
    if (!isModelError(state.last_error)) break;
  }
  const err = new Error(last?.raw_error || "Grok backend failed");
  err.status = 502;
  err.backend = last;
  throw err;
}



const guiActionNames = new Set([
  "click",
  "double_click",
  "right_click",
  "type_text",
  "press_key",
  "set_value",
  "scroll",
  "drag",
  "move_mouse",
]);

function verifiedPriorHostExecutions(body) {
  const calls = new Map();
  const verifiedCallIDs = new Set();
  const names = new Set();
  const input = Array.isArray(body.input) ? body.input : [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (
      item.type === "function_call"
      && item.call_id
      && item.name
    ) {
      calls.set(String(item.call_id), String(item.name));
      continue;
    }
    if (item.type !== "function_call_output" || !item.call_id) continue;
    const callID = String(item.call_id);
    const name = calls.get(callID);
    if (!name || verifiedCallIDs.has(callID)) continue;
    verifiedCallIDs.add(callID);
    names.add(name);
  }
  return { names, count: verifiedCallIDs.size };
}

function claimedGuiActions(text) {
  const claims = [];
  const clauses = String(text || "")
    .split(/(?<=[\n。！？；;.!?])/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    const lower = clause.toLowerCase();
    const negated =
      /(?:沒有|並未|未曾|不要|不是|不代表|\bwithout\b|\bdid not\b|\bdidn't\b|\bhave not\b|\bhaven't\b|\bnever\b)/i.test(
        clause,
      );
    if (negated) continue;
    const affirmativeClaim =
      /\b(?:i|we)\s+(?:have\s+)?(?:already\s+)?(?:clicked|typed|entered|submitted|opened|navigated|scrolled|dragged|pressed|hit|executed|ran|called|used|set)\b/i.test(
        clause,
      )
      || /(?:我|我們|本人)(?:已|已經|剛剛|成功)?(?:完成|執行|呼叫|點擊|輸入|打字|按下|按了|捲動|滾動|拖曳|設定|送出|提交|開啟|打開|導航|搜尋)/.test(
        clause,
      )
      || /(?:已|已經|剛剛|成功)(?:完成|執行|呼叫|點擊|輸入|打字|按下|按了|捲動|滾動|拖曳|設定|送出|提交|開啟|打開|導航|搜尋)/.test(
        clause,
      )
      || /(?:已發出|已執行|已完成)(?:的)?(?:動作|操作)/.test(
        clause,
      );
    if (!affirmativeClaim) continue;
    for (const name of guiActionNames) {
      if (lower.includes(name)) claims.push(name);
    }
    if (/滑鼠|點擊/.test(clause)) claims.push("click");
    if (/輸入|打字/.test(clause)) claims.push("type_text");
    if (
      /\b(?:press(?:ed|ing)?|hit)\s+(?:the\s+)?(?:return|enter)\b/i.test(
        clause,
      )
      || /(?:按下|按了|敲擊)\s*(?:return|enter|回車|換行)(?:鍵)?/i.test(
        clause,
      )
    ) {
      claims.push("press_key");
    }
  }
  return [...new Set(claims)];
}

function claimsGenericHostCompletion(text) {
  const clauses = String(text || "")
    .split(/(?<=[\n。！？；;.!?])/)
    .map((clause) => clause.trim())
    .filter(Boolean);
  return clauses.some((clause) => {
    const negated =
      /(?:沒有|並未|未曾|不要|不是|不代表|\bwithout\b|\bdid not\b|\bdidn't\b|\bhave not\b|\bhaven't\b|\bnever\b)/i.test(
        clause,
      );
    if (negated) return false;
    return [
      /\b(?:i|we)\s+(?:have\s+)?(?:already\s+)?(?:clicked|typed|entered|submitted|opened|navigated|scrolled|dragged|executed|ran|called|used)\b/i,
      /(?:我|我們|本人)(?:已|已經|剛剛|成功)?(?:執行|呼叫|點擊|輸入|提交|開啟|打開|導航|捲動|拖曳|修改|寫入|刪除)/,
      /(?:我|我們|本人)(?:已|已經|剛剛|成功)?完成(?:了)?(?:工具|電腦|瀏覽器|GUI|動作|操作|命令|檔案(?:修改|寫入|刪除))/i,
      /(?:已發出|已執行|已完成)(?:的)?(?:工具|電腦|瀏覽器|GUI|動作|操作)/i,
      /(?:工具|電腦|瀏覽器|GUI)(?:呼叫|動作|操作)?(?:已完成|成功|已執行)/i,
    ].some((pattern) => pattern.test(clause));
  });
}

function hallucinatedComputerActionError(model, claims) {
  return Object.assign(
    new Error(
      `${model} claimed GUI/computer-use actions without matching function_call evidence: ${claims.join(", ")}. Refusing to persist a fake progress report.`,
    ),
    {
      status: 424,
      tatwoVisibleFailClosed: true,
      errorKind: "unverified_tool_completion_claim",
    },
  );
}

function unverifiedHostCompletionError(
  model,
  text,
  body,
  mustVerifyHostCompletion,
) {
  if (!mustVerifyHostCompletion) return null;
  const claims = claimedGuiActions(text);
  const genericHostCompletionClaim =
    claimsGenericHostCompletion(text);
  if (claims.length === 0 && !genericHostCompletionClaim) return null;
  const verified = verifiedPriorHostExecutions(body);
  const unsupportedClaims = claims.filter(
    (name) => !verified.names.has(name),
  );
  if (
    unsupportedClaims.length === 0
    && (!genericHostCompletionClaim || verified.count > 0)
  ) {
    return null;
  }
  return hallucinatedComputerActionError(
    model,
    unsupportedClaims.length > 0
      ? unsupportedClaims
      : ["generic_host_completion"],
  );
}

function disallowedTatwoToolRequestError(model, route, count) {
  return Object.assign(
    new Error(
      `${model} emitted ${count} function/tool host request(s) while the bound Tatwo computer_host_route was ${route}. Refusing to emit an unauthorized host request.`,
    ),
    {
      status: 424,
      tatwoVisibleFailClosed: true,
      errorKind: "computer_host_route_violation",
    },
  );
}

function visibleTatwoFailClosedText(model, error) {
  return [
    `[model_gateway notice] ${model} response was blocked (${error.errorKind || "authority_violation"}).`,
    error.message,
    "No unverified host action or completion claim was persisted.",
  ].join(" ");
}

function isComputerUseRequest(prompt) {
  const currentIntent = hostExecutionIntentText(prompt);
  return /computer\s*use|plugin:\/\/computer-use|@電腦|使用computer|開啟arc|打開arc|開啟brave|打開brave|搜尋youtube/i.test(currentIntent);
}

function hostExecutionIntentText(prompt) {
  let text = String(prompt || "");
  // Classify requested actions, not actions that the user explicitly forbids.
  // Clause boundaries stay tight so "不要只說明，直接改檔" keeps the later
  // positive host-execution clause.
  const negatedClauses = [
    /(?:不要|不得|不可|不可以|不需|無需|不用|禁止|請勿)[^。！？；，,\n、]{0,120}/gi,
    /\b(?:do not|don't|must not|should not|without|no need to)\b[^.!?;,\n]{0,160}/gi,
  ];
  for (const pattern of negatedClauses) {
    text = text.replace(pattern, " ");
  }
  return text;
}

function isHostExecutionRequest(prompt) {
  const currentIntent = hostExecutionIntentText(prompt);
  return /(直接)?(改|修改|寫入|刪除|移動|執行|跑|開啟|打開|點擊|操作).{0,24}(主機|檔案|檔|文件|repo|workspace|shell|命令|終端|gui|app|視窗)|host.{0,16}(edit|write|mutat|shell|gui)|edit.{0,16}(file|repo|workspace)|modify.{0,16}(file|repo|workspace)|run.{0,16}(shell|command)|operate.{0,16}(gui|app|window)/i.test(currentIntent);
}

function missingHostToolText() {
  return "blocker_class=tool_unavailable authority_source=runner; no matching bridged host tool was exposed for file/GUI/shell execution.";
}

function hasComputerUseTool(toolSpecs) {
  return toolSpecs.some((spec) => {
    const name = [spec.namespace, spec.name].filter(Boolean).join(".").toLowerCase();
    const description = String(spec.description || "").toLowerCase();
    return (
      name.includes("computer") ||
      name.includes("screenshot") ||
      name.includes("click") ||
      name.includes("type_text") ||
      description.includes("computer") ||
      description.includes("screen") ||
      description.includes("browser")
    );
  });
}

function missingComputerUseToolError(model) {
  return Object.assign(
    new Error(
      [
        `${model} was asked to use computer use, but Codex App did not expose any computer-use tools in this request.`,
        "External models cannot access MCP/computer-use directly; they can only emit function_call intents for tools present in the current Responses request.",
        "Refusing to let the external model claim completion without an actual tool call.",
      ].join(" "),
    ),
    { status: 424 },
  );
}

function sse(res, event) {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// Normalize backend usage payloads (Claude CLI / OpenAI-style) into Responses
// `usage`. Token accounting is what lets Codex App track context growth for
// auto-compaction on non-passthrough routes; without it the App is blind.
// Claude reports cache tokens separately — they ARE part of the live context,
// so they count toward input_tokens (cache_read surfaced as cached_tokens).
function normalizeUsage(u) {
  if (!u || typeof u !== "object") return null;
  const cacheRead = Number(u.cache_read_input_tokens) || 0;
  const cacheCreate = Number(u.cache_creation_input_tokens) || 0;
  const input = (Number(u.input_tokens) || Number(u.prompt_tokens) || 0) + cacheRead + cacheCreate;
  const output = Number(u.output_tokens) || Number(u.completion_tokens) || 0;
  if (!input && !output) return null;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: cacheRead },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: input + output,
  };
}

const ALLOWED_BLOCKER_CLASSES = new Set([
  "quota",
  "session_limit",
  "auth",
  "permission_denied",
  "route_scope_unclear",
  "tool_unavailable",
  "contract_missing",
]);

const ALLOWED_AUTHORITY_SOURCES = new Set(["contract", "runner", "none"]);

function mapBlockerClass(value) {
  const normalized = String(value || "").toLowerCase();
  if (ALLOWED_BLOCKER_CLASSES.has(normalized)) return normalized;
  if (/quota|weekly|limit/.test(normalized)) return "quota";
  if (/session|context/.test(normalized)) return "session_limit";
  if (/auth|login|token|credential/.test(normalized)) return "auth";
  if (/permission|denied|tcc|sandbox/.test(normalized)) return "permission_denied";
  if (/contract/.test(normalized)) return "contract_missing";
  if (/tool|host|fs|file|gui|shell|exec|mutat|write|unavailable|constrain|restrict|bridge/.test(normalized)) {
    return "tool_unavailable";
  }
  if (/scope|route|unclear/.test(normalized)) return "route_scope_unclear";
  return "route_scope_unclear";
}

function mapAuthoritySource(value) {
  const normalized = String(value || "").toLowerCase();
  if (ALLOWED_AUTHORITY_SOURCES.has(normalized)) return normalized;
  if (/runner|tool|gateway|request|scoped|workspace/.test(normalized)) return "runner";
  if (/contract|work.?os|os/.test(normalized)) return "contract";
  if (/none|missing|unknown/.test(normalized)) return "none";
  return "runner";
}

function normalizeAuthorityMarkers(text) {
  let output = String(text || "");
  output = output.replace(/\bblocker_class=([A-Za-z0-9_-]+)/g, (_, value) => `blocker_class=${mapBlockerClass(value)}`);
  output = output.replace(/\bauthority_source=([A-Za-z0-9_-]+)/g, (_, value) => `authority_source=${mapAuthoritySource(value)}`);
  output = output.replace(
    /(?:Codex|Claude|Grok|MiniMax|another model|model|另一個模型|其他模型|任何模型|模型)[^\n。！？；;.!?]*(?:revoked|revoke|撤權|取消權限)[^\n。！？；;.!?]*/gi,
    "blocker_class=route_scope_unclear authority_source=runner",
  );
  output = output.replace(
    /[^。\n！？；;.!?]*(?:revoked|revoke|撤權|取消權限)[^。\n！？；;.!?]*/gi,
    "blocker_class=route_scope_unclear authority_source=runner",
  );
  return output;
}

function createAuthorityStreamingNormalizer(onText) {
  let carry = "";
  const emit = (value) => {
    const normalized = normalizeAuthorityMarkers(value);
    if (normalized) onText(normalized);
  };
  return {
    push(value) {
      carry += String(value || "");
      let boundary = -1;
      for (let index = 0; index < carry.length; index += 1) {
        if (/[\n。！？；;.!?]/.test(carry[index])) boundary = index;
      }
      if (boundary >= 0) {
        emit(carry.slice(0, boundary + 1));
        carry = carry.slice(boundary + 1);
      }
    },
    finish() {
      if (carry) emit(carry);
      carry = "";
    },
    discard() {
      carry = "";
    },
  };
}

function responseObjects(text, model, options = {}) {
  text = normalizeAuthorityMarkers(text);
  const id = options.id || `resp_${crypto.randomBytes(12).toString("hex")}`;
  const itemId = options.item_id || `msg_${crypto.randomBytes(12).toString("hex")}`;
  const created = options.created_at || Math.floor(Date.now() / 1000);
  const output = [
    {
      id: itemId,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  ];
  let response = {
    id,
    object: "response",
    created_at: created,
    status: "completed",
    model,
    output,
    output_text: text,
  };
  for (const key of [
    "requested_model",
    "actual_model",
    "assistant_models",
    "modelUsage",
    "auxiliary_model_usage",
    "fallback_count",
    "fallback_models",
    "model_attestation",
    "reasoning_control",
    "prompt_transport",
    "degraded",
    "error_kind",
    "retry_allowed",
    "reset_at",
  ]) {
    if (options[key] !== undefined && options[key] !== null) response[key] = options[key];
  }
  const usage = normalizeUsage(options.usage);
  if (usage) response.usage = usage;
  response = withTatwoAppliedRouteReceipt(
    response,
    options.tatwo_current_turn,
    options.tool_host_invocation_count,
  );
  return { id, itemId, response, output };
}

function inProgressResponseObject(model, options = {}) {
  return {
    id: options.id || `resp_${crypto.randomBytes(12).toString("hex")}`,
    object: "response",
    created_at: options.created_at || Math.floor(Date.now() / 1000),
    status: "in_progress",
    model,
    output: [],
  };
}

function stripJsonFence(text) {
  const trimmed = String(text || "").trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1].trim() : trimmed;
}

function balancedJsonCandidates(text) {
  const input = stripJsonFence(text);
  const candidates = [];
  for (let start = 0; start < input.length; start += 1) {
    const opener = input[start];
    if (opener !== "{" && opener !== "[") continue;
    const closer = opener === "{" ? "}" : "]";
    const stack = [closer];
    let inString = false;
    let escaped = false;
    for (let index = start + 1; index < input.length; index += 1) {
      const char = input[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{" || char === "[") {
        stack.push(char === "{" ? "}" : "]");
      } else if (char === "}" || char === "]") {
        if (stack.pop() !== char) break;
        if (stack.length === 0) {
          candidates.push(input.slice(start, index + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

function tryParseJsonObject(text) {
  const cleaned = stripJsonFence(text);
  const candidates = cleaned.startsWith("{") || cleaned.startsWith("[") ? [cleaned] : balancedJsonCandidates(cleaned);
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next balanced JSON-looking substring.
    }
  }
  return null;
}

function toolKey(namespace, name) {
  return namespace ? `${namespace}.${name}` : name;
}

function allowedToolMaps(toolSpecs) {
  const byKey = new Map();
  const byName = new Map();
  for (const spec of toolSpecs) {
    const key = toolKey(spec.namespace, spec.name);
    byKey.set(key, spec);
    if (!byName.has(spec.name)) byName.set(spec.name, []);
    byName.get(spec.name).push(spec);
  }
  return { byKey, byName };
}

function normalizeToolArguments(argumentsValue) {
  if (argumentsValue == null) return "{}";
  if (typeof argumentsValue === "string") {
    const trimmed = argumentsValue.trim();
    if (!trimmed) return "{}";
    try {
      JSON.parse(trimmed);
      return trimmed;
    } catch {
      return JSON.stringify({ input: argumentsValue });
    }
  }
  return JSON.stringify(argumentsValue);
}

function extractRequestedToolCalls(text, toolSpecs) {
  const parsed = tryParseJsonObject(text);
  if (!parsed) return null;
  const rawCalls = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.tool_calls)
      ? parsed.tool_calls
      : parsed.tool_call
        ? [parsed.tool_call]
        : parsed.type === "function_call"
          ? [parsed]
          : null;
  if (!rawCalls) return null;
  const { byKey, byName } = allowedToolMaps(toolSpecs);
  return rawCalls.map((raw) => {
    if (!raw || typeof raw !== "object") {
      throw Object.assign(new Error("Claude tool bridge returned a non-object tool call"), { status: 502 });
    }
    const name = raw.name || raw.function?.name;
    if (!name) {
      throw Object.assign(new Error("Claude tool bridge returned a tool call without a name"), { status: 502 });
    }
    let namespace = raw.namespace || null;
    let spec = byKey.get(toolKey(namespace, name));
    if (!spec && !namespace) {
      const nameMatches = byName.get(name) || [];
      if (nameMatches.length === 1) {
        spec = nameMatches[0];
        namespace = spec.namespace;
      }
    }
    if (!spec) {
      throw Object.assign(new Error(`Claude requested a tool that was not exposed in this Codex request: ${toolKey(namespace, name)}`), {
        status: 502,
      });
    }
    return {
      type: "function_call",
      call_id: raw.call_id || `call_${crypto.randomBytes(12).toString("hex")}`,
      namespace,
      name,
      arguments: normalizeToolArguments(raw.arguments ?? raw.input ?? raw.parameters ?? raw.function?.arguments),
    };
  });
}

function toolCallResponseObjects(toolCalls, model, options = {}) {
  const id = options.id || `resp_${crypto.randomBytes(12).toString("hex")}`;
  const created = options.created_at || Math.floor(Date.now() / 1000);
  const output = toolCalls.map((call) => {
    const item = {
      type: "function_call",
      call_id: call.call_id,
      name: call.name,
      arguments: call.arguments,
    };
    if (call.namespace) item.namespace = call.namespace;
    return item;
  });
  let response = {
    id,
    object: "response",
    created_at: created,
    status: "completed",
    model,
    output,
  };
  for (const key of [
    "requested_model",
    "actual_model",
    "assistant_models",
    "modelUsage",
    "auxiliary_model_usage",
    "fallback_count",
    "fallback_models",
    "model_attestation",
    "reasoning_control",
    "prompt_transport",
  ]) {
    if (options[key] !== undefined && options[key] !== null) response[key] = options[key];
  }
  const usage = normalizeUsage(options.usage);
  if (usage) response.usage = usage;
  response = withTatwoAppliedRouteReceipt(
    response,
    options.tatwo_current_turn,
    options.tool_host_invocation_count,
  );
  return { id, response, output };
}

function withTatwoAppliedRouteReceipt(
  response,
  currentTurn,
  toolHostInvocationCount = 0,
) {
  if (!currentTurn) return response;
  const verifiedCount = Number(toolHostInvocationCount ?? 0);
  if (!Number.isSafeInteger(verifiedCount) || verifiedCount < 0) {
    throw new Error("invalid verified Tatwo tool host invocation count");
  }
  if (
    currentTurn.computer_host_route === "none"
    && verifiedCount !== 0
  ) {
    throw new Error("Tatwo none route cannot report a tool host invocation");
  }
  const receipt = {
    schema: TATWO_APPLIED_ROUTE_RECEIPT_V1,
    source: "codex_app_model_gateway",
    run_id: currentTurn.run_id,
    turn_id: currentTurn.turn_id,
    current_visible_turn_sha256:
      currentTurn.current_visible_turn_sha256,
    ...(Number.isSafeInteger(
      currentTurn.current_visible_turn_utf8_bytes,
    )
      ? {
          current_visible_turn_utf8_bytes:
            currentTurn.current_visible_turn_utf8_bytes,
        }
      : {}),
    digest_source: currentTurn.digest_source,
    digest_verified: currentTurn.digest_verified === true,
    authority_nonce: currentTurn.authority_nonce,
    applied_computer_host_route: currentTurn.computer_host_route,
    tool_host_invocation_count: verifiedCount,
    response_id: String(response.id ?? response.response_id ?? ""),
    terminal_status: String(response.status ?? ""),
  };
  return {
    ...response,
    metadata: {
      ...(response.metadata || {}),
      tatwo: {
        ...(response.metadata?.tatwo || {}),
        applied_route_receipt: receipt,
      },
    },
  };
}

const hopByHopHeaders = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function passthroughHeaders(req) {
  const headers = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (hopByHopHeaders.has(name.toLowerCase())) continue;
    if (Array.isArray(value)) {
      headers[name] = value.join(", ");
    } else if (value != null) {
      headers[name] = value;
    }
  }
  headers["content-type"] = headers["content-type"] || "application/json";
  return headers;
}

function copyResponseHeaders(upstream, res) {
  const entries =
    typeof upstream.headers?.entries === "function"
      ? upstream.headers.entries()
      : Object.entries(upstream.headers || {});
  for (const [name, value] of entries) {
    if (hopByHopHeaders.has(name.toLowerCase())) continue;
    if (value !== undefined) res.setHeader(name, value);
  }
}

function writeBufferedGptStream(res, chunks) {
  const body = Buffer.concat(chunks).toString("utf8");
  if (/(?:^|\r?\n)(?:event|data):/.test(body)) {
    res.write(body);
    if (!/\r?\n\r?\n$/.test(body)) res.write("\n\n");
    return;
  }

  const payloads = [];
  try {
    payloads.push(JSON.parse(body || "{}"));
  } catch {
    for (const line of body.split(/\r?\n/)) {
      const candidate = line.trim();
      if (!candidate) continue;
      try {
        payloads.push(JSON.parse(candidate));
      } catch {}
    }
  }
  for (const payload of payloads) sse(res, payload);
}

function requestChatgptUpstream(url, { headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    const upstreamRequest = transport.request(
      parsed,
      {
        method: "POST",
        headers,
        signal,
      },
      resolve,
    );
    upstreamRequest.on("error", reject);
    upstreamRequest.end(body);
  });
}

// MiniMax used global fetch/Undici here before August 2, 2026. Under sustained
// office traffic, Node 26 could emit an unhandled ClientHttp2Stream
// `InformationalError: socket idle timeout`, which can take down the entire
// gateway even though the individual turn was already bounded. Use the same
// native http/https transport family as GPT passthrough so every response,
// abort, size cap, and socket error remains owned by this request promise.
function requestUpstreamText(
  url,
  { method = "POST", headers = {}, body = "", signal, maxBytes = MAX_CHILD_STDOUT },
) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === "https:" ? https : http;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    const upstreamRequest = transport.request(
      parsed,
      {
        method,
        headers,
        signal,
      },
      (upstream) => {
        const chunks = [];
        let bytes = 0;
        upstream.on("data", (chunk) => {
          if (settled) return;
          const buffer = Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > maxBytes) {
            upstream.destroy(
              new Error(`upstream response exceeded ${maxBytes} bytes`),
            );
            return;
          }
          chunks.push(buffer);
        });
        upstream.on("end", () => {
          finish(resolve, {
            statusCode: Number(upstream.statusCode || 502),
            headers: upstream.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        upstream.on("aborted", () => {
          finish(reject, new Error("upstream response aborted"));
        });
        upstream.on("error", (error) => finish(reject, error));
        upstream.on("close", () => {
          if (!upstream.complete) {
            finish(
              reject,
              new Error("upstream response closed before completion"),
            );
          }
        });
      },
    );
    upstreamRequest.on("error", (error) => finish(reject, error));
    upstreamRequest.end(body);
  });
}

function readIncomingMessage(upstream, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    upstream.on("data", (chunk) => {
      if (bytes >= maxBytes) return;
      const buffer = Buffer.from(chunk);
      const remaining = maxBytes - bytes;
      chunks.push(buffer.subarray(0, remaining));
      bytes += Math.min(buffer.length, remaining);
    });
    upstream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    upstream.on("error", reject);
  });
}

function sendOperationalGatewayNotice(res, requestedModel, error, stream) {
  const failure = classifyUpstreamFailure(error);
  if (failure.retryAllowed) {
    const status = Number(error?.status || 502);
    const payload = {
      type: "response.failed",
      error: {
        message: String(error?.message || "upstream request failed")
          .replace(/\s+/g, " ")
          .slice(0, 500),
        status,
        error_kind: failure.kind,
        retry_allowed: true,
      },
    };
    if (!stream) return json(res, status, { error: payload.error });
    if (!res.headersSent) {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
    }
    sse(res, payload);
    res.end();
    return;
  }
  return sendCompletedAssistantText(
    res,
    requestedModel,
    backendNoticeText(requestedModel, error),
    stream,
    {
      requested_model: requestedModel,
      degraded: true,
      error_kind: failure.kind,
      retry_allowed: false,
    },
  );
}

async function proxyChatgpt(
  req,
  res,
  bodyText,
  stream,
  upstreamModel = null,
  requestedModel = null,
  routeSlug = null,
  reasoningControl = null,
) {
  requestedModel ||= upstreamModel || "gpt";
  routeSlug ||= requestedModel;
  const expectedModel = upstreamModel || requestedModel;
  const attempt = beginGptRouteAttempt(
    gptRouteState[routeSlug],
    requestedModel,
    expectedModel,
  );
  if (!req.headers.authorization) {
    const error = Object.assign(
      new Error("GPT passthrough requires Codex ChatGPT Authorization headers from the active Codex session."),
      { status: 401 },
    );
    attempt.fail(error.message, null, {
      actualModel: null,
      fallbackCount: 0,
      terminalEventType: null,
      attestationOutcome: "FAIL_CLOSED_AUTH",
    });
    return sendOperationalGatewayNotice(res, requestedModel, error, stream);
  }

  // Abort the upstream ChatGPT request on timeout or if the client disconnects, so a
  // stuck/abandoned passthrough never holds a connection or keeps reading the stream.
  const controller = new AbortController();
  let timedOut = false;
  let clientGone = false;
  const upstreamTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, UPSTREAM_TIMEOUT_MS);
  const onClientGone = () => {
    clientGone = true;
    controller.abort();
  };
  res.on("close", onClientGone);
  const cleanup = () => {
    clearTimeout(upstreamTimer);
    res.off("close", onClientGone);
  };
  let upstream;
  try {
    upstream = await requestChatgptUpstream(`${CHATGPT_CODEX_BASE_URL}/responses`, {
      headers: passthroughHeaders(req),
      // The ChatGPT Codex subscription endpoint requires streaming even when
      // the downstream TATWO transport requested one buffered JSON response.
      // Buffer/adapt that SSE terminal below instead of forwarding stream:false.
      body: gptPassthroughBodyText(bodyText, upstreamModel, true),
      signal: controller.signal,
    });
  } catch (error) {
    cleanup();
    if (clientGone || res.writableEnded || error.name === "AbortError") {
      if (timedOut && !clientGone && !res.writableEnded) {
        const timeoutError = Object.assign(
          new Error(`GPT subscription passthrough timed out after ${UPSTREAM_TIMEOUT_MS}ms`),
          { status: 504, signal: "SIGTERM" },
        );
        attempt.fail(timeoutError.message, timeoutError.signal, {
          actualModel: null,
          fallbackCount: 0,
          terminalEventType: null,
          attestationOutcome: "FAIL_CLOSED_TIMEOUT",
        });
        return sendOperationalGatewayNotice(res, requestedModel, timeoutError, stream);
      }
      attempt.fail("GPT passthrough request aborted by client disconnect", null, {
        actualModel: null,
        fallbackCount: 0,
        terminalEventType: null,
        attestationOutcome: "FAIL_CLOSED_CLIENT_DISCONNECT",
      });
      return;
    }
    const upstreamError = Object.assign(
      new Error(`GPT subscription passthrough failed before upstream response: ${error.message}`),
      { status: 502 },
    );
    attempt.fail(upstreamError.message, null, {
      actualModel: null,
      fallbackCount: 0,
      terminalEventType: null,
      attestationOutcome: "FAIL_CLOSED_UPSTREAM_CONNECT",
    });
    return sendOperationalGatewayNotice(res, requestedModel, upstreamError, stream);
  }

  const upstreamStatus = Number(upstream.statusCode || 502);
  if (upstreamStatus < 200 || upstreamStatus >= 300) {
    let detail = "";
    try {
      detail = (await readIncomingMessage(upstream)).replace(/\s+/g, " ").slice(0, 500);
    } catch {}
    cleanup();
    const upstreamError = Object.assign(
      new Error(`GPT subscription passthrough upstream HTTP ${upstreamStatus}${detail ? `: ${detail}` : ""}`),
      { status: upstreamStatus },
    );
    attempt.fail(upstreamError.message, null, {
      actualModel: null,
      fallbackCount: 0,
      terminalEventType: null,
      attestationOutcome: "FAIL_CLOSED_UPSTREAM_HTTP",
    });
    return sendOperationalGatewayNotice(res, requestedModel, upstreamError, stream);
  }

  const observer = createGptResponsesTerminalObserver(
    upstream.headers?.["content-type"],
  );
  if (stream) {
    copyResponseHeaders(upstream, res);
    res.statusCode = upstreamStatus;
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache");
    res.setHeader("connection", "keep-alive");
    res.flushHeaders();
  }
  await new Promise((resolve) => {
    let settled = false;
    const bufferedStreamChunks = [];
    let bufferedStreamBytes = 0;
    let streamBufferExceeded = false;
    const terminalAttestation = () => {
      const observation = observer.finish();
      return {
        observation,
        attestation: gptTerminalAttestation(
          observation,
          requestedModel,
          expectedModel,
        ),
        hasTerminalEvidence:
          observation.completed.length > 0
          || observation.failed.length > 0
          || observation.malformedTerminalCount > 0,
      };
    };
    const sendVerifiedTerminal = (terminal) => {
      if (res.writableEnded) return;
      if (stream) {
        writeBufferedGptStream(res, bufferedStreamChunks);
        return;
      }
      if (res.headersSent) return;
      if (terminal.attestation.ok) {
        const terminalPayload =
          terminal.observation.completed[0]?.response
          || terminal.observation.completed[0];
        const payload = { ...terminalPayload };
        const terminalOutput = Array.isArray(terminalPayload?.output)
          ? terminalPayload.output
          : [];
        const assembledOutput = Array.isArray(
          terminal.observation.outputItemEntries,
        )
          ? terminal.observation.outputItemEntries
          : [];
        const output = [...terminalOutput];
        for (const { outputIndex, item } of assembledOutput) {
          output[outputIndex] = item;
        }
        payload.output = output;
        payload.requested_model = requestedModel;
        payload.actual_model = terminal.attestation.actualModel;
        payload.fallback_count = terminal.attestation.fallbackCount;
        payload.model_attestation = {
          schema: "TatwoGatewayModelAttestationV1",
          evidence_source: "chatgpt_subscription_response_completed",
          requested_model: requestedModel,
          requested_vendor_model: expectedModel,
          actual_model: terminal.attestation.actualModel,
          actual_canonical_model: terminal.attestation.actualModel,
          actual_vendor_model: terminal.attestation.actualModel,
          assistant_models: [terminal.attestation.actualModel],
          fallback_models: [],
          fallback_count: terminal.attestation.fallbackCount,
          outcome: terminal.attestation.attestationOutcome,
          exact: true,
        };
        if (reasoningControl?.normalized) {
          payload.reasoning_control = {
            ...reasoningControl,
            forwarded: true,
            effective_attested: false,
          };
        }
        json(res, 200, payload);
        return;
      }
    };
    const sendAttestationFailure = (terminal) => {
      if (res.writableEnded) return;
      sendOperationalGatewayNotice(
        res,
        requestedModel,
        Object.assign(
          new Error(terminal.attestation.rawError),
          { status: 502 },
        ),
        stream,
      );
    };
    const finish = (streamError = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      const terminal = terminalAttestation();
      if (terminal.attestation.ok) {
        attempt.succeed(terminal.attestation);
        sendVerifiedTerminal(terminal);
      } else if (terminal.hasTerminalEvidence) {
        attempt.fail(
          terminal.attestation.rawError,
          null,
          terminal.attestation,
        );
        sendAttestationFailure(terminal);
      } else if (clientGone || res.writableEnded) {
        attempt.fail(
          "GPT passthrough request aborted by client disconnect",
          null,
          {
            actualModel: null,
            fallbackCount: 0,
            terminalEventType: null,
            attestationOutcome: "FAIL_CLOSED_CLIENT_DISCONNECT",
          },
        );
      } else if (streamError) {
        const outputCapExceeded =
          /GPT passthrough stream exceeded \d+ bytes before exact attestation/.test(
            String(streamError.message || ""),
          );
        const upstreamError = Object.assign(
          new Error(`GPT subscription passthrough stream failed: ${streamError.message}`),
          {
            status: outputCapExceeded
              ? 413
              : Number(streamError.status || 502),
          },
        );
        attempt.fail(upstreamError.message, null, {
          actualModel: null,
          fallbackCount: 0,
          terminalEventType: null,
          attestationOutcome: "FAIL_CLOSED_STREAM",
        });
        console.error("GPT passthrough upstream stream error:", streamError);
        sendOperationalGatewayNotice(
          res,
          requestedModel,
          upstreamError,
          stream,
        );
      } else {
        attempt.fail(
          terminal.attestation.rawError,
          null,
          terminal.attestation,
        );
        sendAttestationFailure(terminal);
      }
      if (!res.writableEnded) res.end();
      resolve();
    };
    const handleStreamFailure = (error) => {
      if (streamBufferExceeded) {
        error = Object.assign(
          new Error(
            `GPT passthrough stream exceeded ${MAX_CHILD_STDOUT} bytes before exact attestation`,
          ),
          { status: 413 },
        );
      }
      finish(error);
    };
    upstream.on("data", (chunk) => {
      if (res.writableEnded) return;
      if (stream) {
        const buffer = Buffer.from(chunk);
        bufferedStreamBytes += buffer.length;
        if (bufferedStreamBytes > MAX_CHILD_STDOUT) {
          streamBufferExceeded = true;
          upstream.destroy(
            Object.assign(
              new Error(
                `GPT passthrough stream exceeded ${MAX_CHILD_STDOUT} bytes before exact attestation`,
              ),
              { status: 413 },
            ),
          );
          return;
        }
        bufferedStreamChunks.push(buffer);
      }
      observer.push(chunk);
    });
    upstream.on("end", () => finish());
    upstream.on("error", handleStreamFailure);
    upstream.on("aborted", () => handleStreamFailure(new Error("upstream response aborted")));
    upstream.on("close", () => {
      if (!upstream.complete) handleStreamFailure(new Error("upstream response closed before completion"));
    });
  });
}

async function handleResponses(req, res) {
  let bodyText;
  let body;
  try {
    bodyText = await readBody(req) || "{}";
    body = JSON.parse(bodyText);
  } catch (error) {
    return json(res, error.statusCode || 400, { error: { message: error.message } });
  }
  const model = body.model;
  const routeModel = claudeAliases[model] || model;
  const stream = body.stream === true;
  const routeKind = claudeRoutes[routeModel]
    ? "claude"
    : grokRoutes[model]
      ? "grok"
      : minimaxRoutes[model]
        ? "minimax"
        : null;
  const gptRoute = routeKind ? null : gptRouteForModel(model);
  const reasoningRouteKind =
    routeKind || (gptRoute || isOfficialOpenAiSlug(model) ? "gpt" : null);
  if (!reasoningRouteKind) {
    return json(res, 404, { error: { message: `unknown model slug: ${model}` } });
  }
  let continuationPlan = null;
  try {
    continuationPlan = tatwoGatewayContinuation.plan(body, {
      routeKind,
      canonicalModelID:
        routeKind === "claude" ? routeModel : model,
    });
  } catch (error) {
    return json(res, error.status || 400, {
      error: {
        message: error.message,
        status: error.status || 400,
        ...(error.code ? { code: error.code } : {}),
      },
    });
  }
  let reasoningControl;
  try {
    reasoningControl = requestedReasoningControl(body, reasoningRouteKind);
  } catch (error) {
    return json(res, error.status || 400, {
      error: { message: error.message, status: error.status || 400 },
    });
  }
  // Safety gates must classify the current turn, not the entire accumulated
  // transcript/instructions blob. Long same-thread Codex requests routinely
  // contain historical tool policy and host-execution wording; scanning that
  // old context turns benign follow-up questions into false tool_unavailable
  // blockers after small-route compaction strips oversized tool schemas.
  let currentTurnToolIntent;
  try {
    currentTurnToolIntent = currentTurnToolIntentDecision(body);
    reserveTatwoAuthorityNonce(currentTurnToolIntent.authorityBinding);
  } catch (error) {
    return json(res, error.status || 400, {
      error: { message: error.message, status: error.status || 400 },
    });
  }
  const computerUseRequested =
    currentTurnToolIntent.computerUseRequested;
  const hostExecutionRequested =
    currentTurnToolIntent.hostExecutionRequested;
  const requiresBufferedResponse =
    currentTurnToolIntent.requiresBufferedResponse;
  const tatwoResponseOptions = currentTurnToolIntent.authorityBinding
    ? {
        tatwo_current_turn: currentTurnToolIntent.authorityBinding,
        tool_host_invocation_count: 0,
      }
    : {};
  const mustVerifyHostCompletion =
    routeKind
    && (
      computerUseRequested
      || Boolean(currentTurnToolIntent.authorityBinding)
    );
  const guard = contextGuardDecision(model, routeModel, bodyText);
  if (!guard.allow) {
    const compacted = compactedBodyForSmallRoute(body, guard, bodyText);
    if (!compacted.ok) {
      return sendCompletedAssistantText(
        res,
        model,
        contextGuardText({ ...guard, compactionFailure: compacted.reason }),
        stream,
        {
          reasoning_control: reasoningControl,
          ...tatwoResponseOptions,
        },
      );
    }
    body = compacted.body;
    bodyText = compacted.bodyText;
    console.log(`[context-auto-compact] ${JSON.stringify({ model, ...compacted.receipt })}`);
  }
  const prompt = extractPrompt(body);
  const toolSpecs = extractToolSpecs(body);
  const imageInputs = extractImageInputs(body);
  if (!routeKind) {
    return proxyChatgpt(
      req,
      res,
      bodyText,
      stream,
      gptRoute?.route.upstream_model || null,
      model,
      gptRoute?.slug || model,
      reasoningControl,
    );
  }
  const responseModel = routeKind === "claude" ? routeModel : model;
  if (imageInputs.unsupported.length > 0) {
    const message = `${model} received image input that model_gateway could not decode for the external adapter: ${imageInputs.unsupported.slice(0, 3).join("; ")}`;
    if (!stream) return json(res, 415, { error: { message, status: 415 } });
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    sse(res, { type: "response.failed", error: { message, status: 415 } });
    res.end();
    return;
  }
  if (routeKind && computerUseRequested && !hasComputerUseTool(toolSpecs)) {
    const error = missingComputerUseToolError(model);
    if (!stream) return json(res, error.status, { error: { message: error.message, status: error.status } });
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    sse(res, { type: "response.failed", error: { message: error.message, status: error.status } });
    res.end();
    return;
  }
  try {
    tatwoGatewayContinuation.acquire(continuationPlan);
  } catch (error) {
    return json(res, error.status || 409, {
      error: {
        message: error.message,
        status: error.status || 409,
        ...(error.code ? { code: error.code } : {}),
      },
    });
  }
  if (stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
  }
  // Buffered backends (Claude/Grok CLI and MiniMax API) send nothing until the turn
  // completes; a long 1M-context turn would otherwise look idle and trip Codex App's
  // stream timeout. Emit a real Responses event immediately, then periodic semantic
  // in-progress events. Plain SSE comments were not enough for every Codex App path:
  // some reconnect layers count only data-bearing SSE events as activity.
  let heartbeat = null;
  const clientAbort = new AbortController();
  const abortForClientDisconnect = () => {
    if (!res.writableEnded) clientAbort.abort();
  };
  req.once("aborted", abortForClientDisconnect);
  res.once("close", abortForClientDisconnect);
  const streamMeta = stream ? { id: `resp_${crypto.randomBytes(12).toString("hex")}`, created_at: Math.floor(Date.now() / 1000) } : null;
  if (stream) {
    sse(res, { type: "response.created", response: inProgressResponseObject(responseModel, streamMeta) });
    heartbeat = setInterval(() => {
      try {
        if (!res.writableEnded) {
          sse(res, { type: "response.in_progress", response: inProgressResponseObject(responseModel, streamMeta) });
        }
      } catch {}
    }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
  }
  try {
    // True streaming path: text-only Claude turns stream deltas as they arrive.
    // Tool-bridge / computer-use turns stay buffered (intent JSON must not leak
    // as visible text); CLAUDE_STREAMING=0 is the kill switch back to buffered.
    if (
      routeKind === "claude" &&
      stream &&
      CLAUDE_STREAMING &&
      imageInputs.images.length === 0 &&
      toolSpecs.length === 0 &&
      !requiresBufferedResponse
    ) {
      const itemId = `msg_${crypto.randomBytes(12).toString("hex")}`;
      let started = false;
      let deliveredText = "";
      let streamAuthorityError = null;
      const writeNormalizedDelta = (delta) => {
        if (res.writableEnded) return;
        if (!delta) return;
        deliveredText += delta;
        if (!started) {
          started = true;
          sse(res, {
            type: "response.output_item.added",
            output_index: 0,
            item: { id: itemId, type: "message", status: "in_progress", role: "assistant", content: [] },
          });
          sse(res, {
            type: "response.content_part.added",
            item_id: itemId,
            output_index: 0,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
        }
        sse(res, {
          type: "response.output_text.delta",
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          delta,
          logprobs: [],
        });
      };
      const emitNormalizedDelta = (delta) => {
        if (streamAuthorityError) return;
        const authorityError = unverifiedHostCompletionError(
          model,
          delta,
          body,
          mustVerifyHostCompletion,
        );
        if (authorityError) {
          streamAuthorityError = authorityError;
          writeNormalizedDelta(
            visibleTatwoFailClosedText(model, authorityError),
          );
          return;
        }
        writeNormalizedDelta(delta);
      };
      const streamNormalizer = createAuthorityStreamingNormalizer(emitNormalizedDelta);
      const emitDelta = (delta) => streamNormalizer.push(delta);
      const result = await runClaudeStreaming(
        routeModel,
        prompt,
        reasoningControl,
        emitDelta,
        clientAbort.signal,
        continuationPlan,
      );
      if (clientAbort.signal.aborted || res.destroyed) return;
      if (!result?.ok && !result?.deltasSent) {
        // Nothing visible was sent yet — reuse the buffered error semantics
        // (backend-notice completed message or response.failed) via the catch.
        const err = new Error(result?.raw_error || "Claude backend failed");
        err.status = 502;
        err.backend = result;
        throw err;
      }
      const rawAccumulated = String(result.accumulated || "");
      const rawFinalText = String(result.text || rawAccumulated);
      let streamFailure = null;
      if (result.ok && result.deltasSent && rawFinalText !== rawAccumulated) {
        if (!rawFinalText.startsWith(rawAccumulated)) {
          const err = new Error("Claude stream final text did not match emitted deltas");
          err.status = 502;
          err.backend = {
            ...result,
            raw_error: "claude_stream_final_text_mismatch",
          };
          throw err;
        }
        streamNormalizer.push(rawFinalText.slice(rawAccumulated.length));
      } else if (result.ok && !result.deltasSent) {
        streamNormalizer.push(rawFinalText);
      }
      const accumulatedAuthorityError =
        unverifiedHostCompletionError(
          model,
          rawFinalText,
          body,
          mustVerifyHostCompletion,
        );
      if (accumulatedAuthorityError && !streamAuthorityError) {
        streamAuthorityError = accumulatedAuthorityError;
        streamNormalizer.discard();
        writeNormalizedDelta(
          visibleTatwoFailClosedText(
            model,
            accumulatedAuthorityError,
          ),
        );
      }
      if (!result.ok && result.deltasSent) {
        // Preserve a retriable terminal failure even after partial text. Turning
        // a disconnected upstream into response.completed makes Codex stop retrying
        // and incorrectly commits an infrastructure error as an assistant answer.
        // Only the coarse error kind is exposed — raw_error can carry CLI stderr
        // or prompt fragments and must never reach the client.
        const kind = classifyErrorKind(result.raw_error, result.signal);
        streamNormalizer.push(
          `\n\n[model_gateway notice] ${model} stream ended early (${kind}). ` +
          "Check the gateway /healthz route state and logs for details.",
        );
        streamFailure = classifyUpstreamFailure(new Error(result.raw_error || "Claude stream ended early"), {
          partialOutput: result.deltasSent,
          signal: result.signal,
        });
      }
      streamNormalizer.finish();
      const finalText = deliveredText;
      const { response } = responseObjects(finalText, responseModel, {
        ...(streamMeta || {}),
        item_id: itemId,
        usage: result.usage,
        ...attestationResponseOptions(result),
        ...reasoningResponseOptions(result),
        ...(streamAuthorityError
          ? {
              degraded: true,
              error_kind: streamAuthorityError.errorKind,
              retry_allowed: false,
            }
          : streamFailure
            ? {
                degraded: true,
                error_kind: streamFailure.kind,
                retry_allowed: Boolean(streamFailure.retryAllowed),
              }
            : {}),
        ...tatwoResponseOptions,
      });
      if (!streamAuthorityError && !streamFailure) {
        tatwoGatewayContinuation.attach(
          response,
          tatwoGatewayContinuation.complete(
            continuationPlan,
            result,
            response.id,
          ),
        );
      }
      sse(res, { type: "response.output_text.done", item_id: itemId, output_index: 0, content_index: 0, text: finalText });
      sse(res, {
        type: "response.content_part.done",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: finalText, annotations: [] },
      });
      sse(res, { type: "response.output_item.done", item: response.output[0] });
      if (streamFailure?.retryAllowed) {
        sse(res, {
          type: "response.failed",
          error: {
            message: `${model} stream disconnected before completion`,
            status: 502,
            error_kind: streamFailure.kind,
            retry_allowed: true,
          },
        });
        res.end();
        return;
      }
      sse(res, { type: "response.completed", response });
      res.end();
      return;
    }
    const result =
      routeKind === "claude"
        ? await runClaude(
            routeModel,
            prompt,
            imageInputs.images,
            reasoningControl,
            clientAbort.signal,
            continuationPlan,
          )
        : routeKind === "grok"
          ? await runGrok(
              model,
              prompt,
              imageInputs.images,
              reasoningControl,
              continuationPlan,
            )
          : await runMiniMax(model, prompt, imageInputs.images);
    if (clientAbort.signal.aborted || res.destroyed) return;
    const toolCalls = toolSpecs.length > 0 ? extractRequestedToolCalls(result.text || "", toolSpecs) : null;
    if (toolCalls) {
      if (
        currentTurnToolIntent.authorityBinding
        && currentTurnToolIntent.computerHostRoute
          !== "request_scoped_tool"
      ) {
        throw disallowedTatwoToolRequestError(
          model,
          currentTurnToolIntent.computerHostRoute,
          toolCalls.length,
        );
      }
      const { response, output } = toolCallResponseObjects(toolCalls, responseModel, {
        ...(streamMeta || {}),
        usage: result.usage,
        ...attestationResponseOptions(result),
        ...reasoningResponseOptions(result),
        ...promptTransportResponseOptions(result),
        ...(!result.reasoning_control ? { reasoning_control: reasoningControl } : {}),
        ...(currentTurnToolIntent.authorityBinding
          ? {
              tatwo_current_turn:
                currentTurnToolIntent.authorityBinding,
              tool_host_invocation_count: toolCalls.length,
            }
          : {}),
      });
      tatwoGatewayContinuation.attach(
        response,
        tatwoGatewayContinuation.complete(
          continuationPlan,
          result,
          response.id,
        ),
      );
      if (!stream) return json(res, 200, response);
      output.forEach((item) => sse(res, { type: "response.output_item.done", item }));
      sse(res, { type: "response.completed", response });
      res.end();
      return;
    }
    const completionClaimError = unverifiedHostCompletionError(
      model,
      result.text || "",
      body,
      mustVerifyHostCompletion,
    );
    if (completionClaimError) throw completionClaimError;
    if (routeKind && toolSpecs.length === 0 && hostExecutionRequested) {
      result.text = missingHostToolText();
    }
    const { response, output } = responseObjects(result.text || "", responseModel, {
      ...(streamMeta || {}),
      usage: result.usage,
      ...attestationResponseOptions(result),
      ...reasoningResponseOptions(result),
      ...promptTransportResponseOptions(result),
      ...(!result.reasoning_control ? { reasoning_control: reasoningControl } : {}),
      ...tatwoResponseOptions,
    });
    tatwoGatewayContinuation.attach(
      response,
      tatwoGatewayContinuation.complete(
        continuationPlan,
        result,
        response.id,
      ),
    );
    if (!stream) return json(res, 200, response);
    sse(res, { type: "response.output_item.done", item: output[0] });
    sse(res, { type: "response.completed", response });
    res.end();
  } catch (error) {
    if (clientAbort.signal.aborted || res.destroyed) return;
    if (
      routeKind
      && error.tatwoVisibleFailClosed
      && currentTurnToolIntent.authorityBinding
    ) {
      const { response, output } = responseObjects(
        visibleTatwoFailClosedText(model, error),
        responseModel,
        {
          ...(streamMeta || {}),
          degraded: true,
          error_kind: error.errorKind || "authority_violation",
          retry_allowed: false,
          ...tatwoResponseOptions,
        },
      );
      if (!stream) return json(res, 200, response);
      sse(res, { type: "response.output_item.done", item: output[0] });
      sse(res, { type: "response.completed", response });
      res.end();
      return;
    }
    if (routeKind && isBackendNoticeError(error)) {
      const failure = classifyUpstreamFailure(error);
      const { response, output } = responseObjects(backendNoticeText(model, error), responseModel, {
        ...(streamMeta || {}),
        ...attestationResponseOptions(error.backend || {}),
        ...reasoningResponseOptions(error.backend || {}),
        ...(!error.backend?.reasoning_control ? { reasoning_control: reasoningControl } : {}),
        degraded: true,
        error_kind: failure.kind,
        retry_allowed: false,
        ...tatwoResponseOptions,
      });
      if (!stream) return json(res, 200, response);
      sse(res, { type: "response.output_item.done", item: output[0] });
      sse(res, { type: "response.completed", response });
      res.end();
      return;
    }
    const failure = classifyUpstreamFailure(error);
    const payload = {
      type: "response.failed",
      error: {
        message: error.message,
        status: error.status || 500,
        error_kind: failure.kind,
        retry_allowed: Boolean(failure.retryAllowed),
      },
    };
    if (!stream) return json(res, error.status || 500, { error: payload.error });
    sse(res, payload);
    res.end();
  } finally {
    tatwoGatewayContinuation.settle(continuationPlan);
    if (heartbeat) clearInterval(heartbeat);
    req.removeListener("aborted", abortForClientDisconnect);
    res.removeListener("close", abortForClientDisconnect);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    console.log(`${new Date().toISOString()} ${req.method} ${url.pathname}`);
    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/health")) {
      return json(res, 200, healthPayload());
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return json(res, 200, modelsPayload());
    }
    if (req.method === "POST" && url.pathname === "/v1/responses") {
      await handleResponses(req, res);
      return;
    }
    return json(res, 404, { error: { message: "not found" } });
  } catch (error) {
    if (res.writableEnded) return;
    console.error("request handler failed:", error);
    return json(res, error.status || 500, { error: { message: error.message || "internal server error" } });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`codex-app-model-gateway listening on http://${HOST}:${PORT}`);
});

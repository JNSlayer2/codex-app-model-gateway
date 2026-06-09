#!/usr/bin/env node
"use strict";

const http = require("http");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");

const HOST = process.env.MODEL_GATEWAY_HOST || "127.0.0.1";
const PORT = Number(process.env.MODEL_GATEWAY_PORT || 4177);
const CLAUDE_TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 120000);
const HEARTBEAT_MS = Number(process.env.GATEWAY_HEARTBEAT_MS || 15000);
// Default reasoning level advertised for EVERY model in the picker. "low" = fast
// daily default across all models (GPT actually speeds up; Claude/MiniMax/Grok are
// already fast). Bump per-thread in the App when depth is needed, or set env to revert.
const DEFAULT_REASONING_LEVEL = process.env.GATEWAY_DEFAULT_REASONING_LEVEL || "low";
const UPSTREAM_TIMEOUT_MS = Number(process.env.GATEWAY_UPSTREAM_TIMEOUT_MS || 600000);
const CLAUDE_COMMAND = process.env.CLAUDE_COMMAND || "claude";
const GROK_TIMEOUT_MS = Number(process.env.GROK_TIMEOUT_MS || 120000);
const GROK_COMMAND = process.env.GROK_COMMAND || "grok";
const MINIMAX_TIMEOUT_MS = Number(process.env.MINIMAX_TIMEOUT_MS || 120000);
const MINIMAX_BASE_URL = (process.env.MINIMAX_BASE_URL || "https://api.minimax.io/v1").replace(/\/+$/, "");
const MINIMAX_API_SPEND_CLASS = process.env.MINIMAX_API_SPEND_CLASS || "minimax-near-unlimited-api";
const MAX_CHILD_STDOUT = Number(process.env.MAX_CHILD_STDOUT_BYTES || 8 * 1024 * 1024);
const CHATGPT_CODEX_BASE_URL =
  (process.env.CHATGPT_CODEX_BASE_URL || "https://chatgpt.com/backend-api/codex").replace(/\/+$/, "");

const gptRoutes = {
  "gpt-5.5": { display_name: "GPT-5.5", priority: 100 },
  "gpt-5.4": { display_name: "GPT-5.4", priority: 99 },
  "gpt-5.4-mini": { display_name: "GPT-5.4 Mini", priority: 98 },
  "gpt-5.3-codex": { display_name: "GPT-5.3 Codex", priority: 97 },
  "gpt-5.3-codex-spark": { display_name: "GPT-5.3 Codex Spark", priority: 96 },
  "gpt-5.2": { display_name: "GPT-5.2", priority: 95 },
  "codex-auto-review": { display_name: "Codex Auto Review", priority: 94 },
};

const claudeRoutes = {
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
  "sonnet-4-6": {
    display_name: "sonnet4.6",
    candidates: ["claude-sonnet-4-6", "sonnet-4-6", "sonnet"],
  },
  "haiku-4-6": {
    display_name: "haiku4.6",
    candidates: ["claude-haiku-4-6", "haiku-4-6", "haiku"],
  },
  "fable-5": {
    display_name: "fable5",
    candidates: ["claude-fable-5", "fable-5", "fable"],
    context_window: 200000,
  },
};

const claudeAliases = {
  "opus4.7": "opus-4-7",
  "opus4.8": "opus-4-8",
  "sonnet4.6": "sonnet-4-6",
  "haiku4.6": "haiku-4-6",
  "fable5": "fable-5",
};

const grokRoutes = {
  "grok-build": {
    display_name: "grok-build",
    candidates: ["grok-build"],
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
];

const gptBaseInstructions =
  "You are Codex, a coding agent based on GPT-5. You and the user share one workspace, and your job is to collaborate with them until their goal is genuinely handled.";

function publicRouteState(s) {
  // Sanitized view for /healthz: never expose last_error text, which can contain
  // CLI stderr or prompt fragments. Report only a boolean.
  return {
    backend_model: s.backend_model,
    last_ok_at: s.last_ok_at,
    attempts: s.attempts,
    has_error: Boolean(s.last_error),
  };
}

function makeRouteState(routes) {
  return Object.fromEntries(
    Object.entries(routes).map(([slug, route]) => [
      slug,
      {
        backend_model: route.candidates[0],
        last_ok_at: null,
        last_error: null,
        attempts: 0,
      },
    ]),
  );
}

const routeState = makeRouteState(claudeRoutes);
const grokRouteState = makeRouteState(grokRoutes);
const minimaxRouteState = makeRouteState(minimaxRoutes);

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

// Heavy agent tasks (e.g. ultrawork) accumulate large contexts; a 2 MB cap reset the
// socket mid-send, which Codex surfaced as "error sending request" + a retry storm.
// Default to 64 MB, overridable via env, and respond with a clean 413 instead of
// destroying the connection before the handler can reply.
const MAX_BODY_BYTES = Number(process.env.GATEWAY_MAX_BODY_BYTES) || 64 * 1024 * 1024;

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
  return {
    slug,
    id: slug,
    model: slug,
    display_name: displayName,
    description: o.description,
    visibility: "list",
    supported_in_api: true,
    default_reasoning_level: DEFAULT_REASONING_LEVEL,
    supported_reasoning_levels: reasoningLevels,
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
  const gptModels = Object.entries(gptRoutes).map(([slug, route]) =>
    buildModelEntry(slug, route.display_name, route.priority, {
      description: "GPT model routed through local model_gateway to the Codex ChatGPT subscription endpoint.",
      base_instructions: gptBaseInstructions,
      supports_reasoning_summaries: true,
      default_reasoning_summary: "auto",
      support_verbosity: true,
      supports_parallel_tool_calls: true,
      supports_image_detail_original: true,
      context_window: 400000,
      input_modalities: ["text", "image"],
      supports_search_tool: true,
      capabilities: {
        text: "passthrough",
        streaming: "passthrough",
        codex_tools: "passthrough",
        computer_use: "passthrough",
        backend: "chatgpt_subscription",
        api_spend: "subscription_passthrough_not_api_key",
        isolation: "codex_first_party",
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
      supports_image_detail_original: false,
      context_window: route.context_window || 200000,
      input_modalities: ["text"],
      supports_search_tool: false,
      capabilities: {
        text: "buffered",
        streaming: "sse_after_backend_completion",
        codex_tools: "prompt_bridge_experimental",
        computer_use: "prompt_bridge_experimental_when_codex_exposes_tool_schema",
        backend: "claude_cli",
        api_spend: "cli_subscription_not_api_key",
        isolation: "ephemeral_request_only",
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
      supports_image_detail_original: false,
      context_window: 256000,
      input_modalities: ["text"],
      supports_search_tool: false,
      capabilities: {
        text: "buffered",
        streaming: "sse_after_backend_completion",
        codex_tools: "prompt_bridge_experimental",
        computer_use: "prompt_bridge_experimental_when_codex_exposes_tool_schema",
        backend: "grok_cli",
        api_spend: "cli_oauth_not_api_key",
        isolation: "ephemeral_request_only",
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
      supports_image_detail_original: false,
      context_window: route.context_window,
      input_modalities: ["text"],
      supports_search_tool: false,
      capabilities: {
        text: "buffered",
        streaming: "sse_after_backend_completion",
        codex_tools: "prompt_bridge_experimental",
        computer_use: "prompt_bridge_experimental_when_codex_exposes_tool_schema",
        backend: "minimax_api",
        backend_model: route.candidates[0],
        api_spend: MINIMAX_API_SPEND_CLASS,
        min_context_window: route.guaranteed_context_window,
        isolation: "ephemeral_request_only",
      },
    }),
  );
  const models = [...gptModels, ...claudeModels, ...grokModels, ...minimaxModels];
  return { object: "list", data: models, models };
}

function healthPayload() {
  return {
    ok: true,
    service: "codex-app-model-gateway",
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
        text: "buffered",
        streaming: "sse_after_backend_completion",
        codex_tools: "prompt_bridge_experimental",
        computer_use: "prompt_bridge_experimental_when_codex_exposes_tool_schema",
        backend: "claude_cli",
        isolation: "ephemeral_request_only",
      },
      grok: {
        text: "buffered",
        streaming: "sse_after_backend_completion",
        codex_tools: "prompt_bridge_experimental",
        computer_use: "prompt_bridge_experimental_when_codex_exposes_tool_schema",
        backend: "grok_cli",
        isolation: "ephemeral_request_only",
      },
      minimax: {
        text: "buffered",
        streaming: "sse_after_backend_completion",
        codex_tools: "prompt_bridge_experimental",
        computer_use: "prompt_bridge_experimental_when_codex_exposes_tool_schema",
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
          },
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(claudeRoutes).map(([slug, route]) => [
          slug,
          {
            display_name: route.display_name,
            backend_candidates: route.candidates,
            ...publicRouteState(routeState[slug]),
          },
        ]),
      ),
      ...Object.fromEntries(
        Object.entries(grokRoutes).map(([slug, route]) => [
          slug,
          {
            display_name: route.display_name,
            backend_candidates: route.candidates,
            ...publicRouteState(grokRouteState[slug]),
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
            ...publicRouteState(minimaxRouteState[slug]),
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

function isOfficialOpenAiSlug(model) {
  // Route any OpenAI-family slug to ChatGPT passthrough, not only gpt-*.
  // Covers o-series reasoning models (o1/o3/o4...), chatgpt-*, codex-*, and codex-auto-review,
  // so future Codex App models do not silently fall through to a 404. Claude/Grok routes are
  // matched before this, so widening here cannot capture their slugs.
  return /^(gpt-|o[1-9]\d?(-|$)|chatgpt-|codex(-|$))/.test(model || "");
}

function claudeArgs(model, prompt) {
  return [
    "-p",
    "--model",
    model,
    "--output-format",
    "json",
    "--no-session-persistence",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--disallowedTools",
    "*",
    "--system-prompt",
    [
      "You are being called by a local Codex model gateway.",
      "Answer directly unless the request includes a Codex request-scoped tool bridge and a tool is necessary.",
      "When using a bridged tool, return exactly one raw JSON object with tool_calls and no prose. Never execute Codex tools in Claude.",
    ].join(" "),
    prompt,
  ];
}

function isModelError(text) {
  return /invalid model|unknown model|model .*not|not available|unsupported model/i.test(text);
}

function isBackendNoticeError(error) {
  const text = String(error?.message || "");
  return /session limit|rate limit|rate_limit|resets|quota|usage limit|disabled by policy|not authenticated|unauthorized|forbidden|invalid api key|api key|billing|credit|payment|login|oauth|subscription|401|403|429/i.test(text);
}

function backendNoticeText(model, error) {
  const message = String(error?.message || "backend unavailable")
    .replace(/\s+/g, " ")
    .slice(0, 500);
  return [
    `${model} backend is temporarily unavailable: ${message}`,
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

async function runMiniMaxOnce(model, prompt) {
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
      "Answer directly unless the request includes a Codex request-scoped tool bridge and a tool is necessary.",
      "When using a bridged tool, return exactly one raw JSON object with tool_calls and no prose. Never execute Codex tools in MiniMax.",
    ].join(" ");
    const response = await fetch(`${MINIMAX_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: `${system}\n\n${prompt}`,
        stream: false,
      }),
      signal: controller.signal,
    });
    const responseText = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message =
        payload?.error?.message || payload?.base_resp?.status_msg || payload?.message || responseText.slice(0, 500);
      return {
        ok: false,
        model,
        code: response.status,
        signal: null,
        text: "",
        raw_error: `MiniMax API error ${response.status}: ${message}`,
        usage: payload?.usage || null,
      };
    }
    return {
      ok: true,
      model,
      code: response.status,
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

async function runMiniMax(slug, prompt) {
  const route = minimaxRoutes[slug];
  if (!route) {
    throw Object.assign(new Error(`unknown model slug: ${slug}`), { status: 404 });
  }
  const preferred = minimaxRouteState[slug].backend_model;
  const candidates = [preferred, ...route.candidates].filter((model, index, arr) => model && arr.indexOf(model) === index);
  let last = null;
  for (const model of candidates) {
    minimaxRouteState[slug].attempts += 1;
    const result = await runMiniMaxOnce(model, prompt);
    last = result;
    if (result.ok) {
      minimaxRouteState[slug].backend_model = model;
      minimaxRouteState[slug].last_ok_at = new Date().toISOString();
      minimaxRouteState[slug].last_error = null;
      return result;
    }
    minimaxRouteState[slug].last_error = result.raw_error || `minimax exited ${result.code}`;
    if (!isModelError(minimaxRouteState[slug].last_error)) break;
  }
  const err = new Error(last?.raw_error || "MiniMax backend failed");
  err.status = last?.code === 401 || last?.code === 403 ? last.code : 502;
  err.backend = last;
  throw err;
}

function runClaudeOnce(model, prompt) {
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
      });
      return;
    }
    if (process.env.CLAUDE_MOCK_RESPONSE_JSON !== undefined) {
      resolveMock({
        ok: true,
        model,
        code: 0,
        signal: null,
        text: process.env.CLAUDE_MOCK_RESPONSE_JSON,
        raw_error: "",
        usage: null,
      });
      return;
    }
    const child = spawn(CLAUDE_COMMAND, claudeArgs(model, prompt), {
      cwd: "/tmp",
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, CLAUDE_TIMEOUT_MS);
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
          raw_error: `claude CLI stdout exceeded ${MAX_CHILD_STDOUT} bytes; aborted`,
          usage: null,
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
        raw_error: `failed to start claude CLI (${CLAUDE_COMMAND}): ${error.message}`,
        usage: null,
      });
    });
    child.on("close", (code, signal) => {
      let parsed = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        parsed = null;
      }
      const result = parsed?.result || "";
      const emptyOutput = !stdout.trim();
      const isError = Boolean(parsed?.is_error) || code !== 0 || Boolean(signal) || emptyOutput;
      finish({
        ok: !isError,
        model,
        code,
        signal,
        text: result,
        raw_error: [stderr, parsed?.result || "", emptyOutput ? "claude returned empty output" : ""]
          .filter(Boolean)
          .join("\n")
          .trim(),
        usage: parsed?.usage || null,
        total_cost_usd: parsed?.total_cost_usd,
        duration_ms: parsed?.duration_ms,
      });
    });
  });
}

async function runClaude(slug, prompt) {
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
    routeState[canonicalSlug].attempts += 1;
    const result = await runClaudeOnce(model, prompt);
    last = result;
    if (result.ok) {
      routeState[canonicalSlug].backend_model = model;
      routeState[canonicalSlug].last_ok_at = new Date().toISOString();
      routeState[canonicalSlug].last_error = null;
      return result;
    }
    routeState[canonicalSlug].last_error = result.raw_error || `claude exited ${result.code}`;
    if (!isModelError(routeState[canonicalSlug].last_error)) break;
  }
  const err = new Error(last?.raw_error || "Claude backend failed");
  err.status = 502;
  err.backend = last;
  throw err;
}


function grokArgs(model, prompt) {
  return [
    "-p",
    prompt,
    "--model",
    model,
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
      "Answer directly unless the request includes a Codex request-scoped tool bridge and a tool is necessary.",
      "When using a bridged tool, return exactly one raw JSON object with tool_calls and no prose. Never execute Codex tools in Grok.",
    ].join(" "),
  ];
}

function normalizeGrokResult(stdout) {
  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = null;
  }
  if (!parsed) return String(stdout || "").trim();
  return parsed.text || parsed.result || parsed.output_text || parsed.message || "";
}

function runGrokOnce(model, prompt) {
  return new Promise((resolve) => {
    if (process.env.GROK_MOCK_PROMPT_FILE) {
      fs.writeFileSync(process.env.GROK_MOCK_PROMPT_FILE, prompt);
    }
    if (process.env.GROK_MOCK_RESPONSE_JSON !== undefined) {
      resolve({
        ok: true,
        model,
        code: 0,
        signal: null,
        text: process.env.GROK_MOCK_RESPONSE_JSON,
        raw_error: "",
        usage: null,
      });
      return;
    }
    const child = spawn(GROK_COMMAND, grokArgs(model, prompt), {
      cwd: "/tmp",
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      });
    });
    child.on("close", (code, signal) => {
      const text = normalizeGrokResult(stdout);
      const isError = code !== 0 || signal;
      finish({
        ok: !isError,
        model,
        code,
        signal,
        text,
        raw_error: [stderr, isError ? stdout : ""].filter(Boolean).join("\n").trim(),
        usage: null,
      });
    });
  });
}

async function runGrok(slug, prompt) {
  const route = grokRoutes[slug];
  if (!route) {
    throw Object.assign(new Error(`unknown model slug: ${slug}`), { status: 404 });
  }
  const preferred = grokRouteState[slug].backend_model;
  const candidates = [preferred, ...route.candidates].filter((model, index, arr) => model && arr.indexOf(model) === index);
  let last = null;
  for (const model of candidates) {
    grokRouteState[slug].attempts += 1;
    const result = await runGrokOnce(model, prompt);
    last = result;
    if (result.ok) {
      grokRouteState[slug].backend_model = model;
      grokRouteState[slug].last_ok_at = new Date().toISOString();
      grokRouteState[slug].last_error = null;
      return result;
    }
    grokRouteState[slug].last_error = result.raw_error || `grok exited ${result.code}`;
    if (!isModelError(grokRouteState[slug].last_error)) break;
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

function priorToolNames(body) {
  const names = new Set();
  const input = Array.isArray(body.input) ? body.input : [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "function_call" && item.name) names.add(item.name);
  }
  return names;
}

function claimedGuiActions(text) {
  const lower = String(text || "").toLowerCase();
  const claims = [];
  const claimPattern = /(已|already|executed|performed|called|發出|執行|完成|點擊|輸入|提交|搜尋|導航|載入)/i;
  if (!claimPattern.test(text || "")) return claims;
  for (const name of guiActionNames) {
    if (lower.includes(name)) claims.push(name);
  }
  if (/滑鼠|點擊/.test(text || "")) claims.push("click");
  if (/輸入|打字/.test(text || "")) claims.push("type_text");
  if (/return|enter|提交/.test(lower)) claims.push("press_key");
  return [...new Set(claims)];
}

function hallucinatedComputerActionError(model, claims) {
  return Object.assign(
    new Error(
      `${model} claimed GUI/computer-use actions without matching function_call evidence: ${claims.join(", ")}. Refusing to persist a fake progress report.`,
    ),
    { status: 424 },
  );
}

function isComputerUseRequest(prompt) {
  return /computer\s*use|plugin:\/\/computer-use|@電腦|使用computer|開啟arc|打開arc|開啟brave|打開brave|搜尋youtube/i.test(prompt || "");
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

function responseObjects(text, model, options = {}) {
  const id = options.id || `resp_${crypto.randomBytes(12).toString("hex")}`;
  const itemId = `msg_${crypto.randomBytes(12).toString("hex")}`;
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
  const response = {
    id,
    object: "response",
    created_at: created,
    status: "completed",
    model,
    output,
    output_text: text,
  };
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
  const response = {
    id,
    object: "response",
    created_at: created,
    status: "completed",
    model,
    output,
  };
  return { id, response, output };
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
  for (const [name, value] of upstream.headers.entries()) {
    if (hopByHopHeaders.has(name.toLowerCase())) continue;
    res.setHeader(name, value);
  }
}

async function proxyChatgpt(req, res, bodyText, stream) {
  if (!req.headers.authorization) {
    const message = "GPT passthrough requires Codex ChatGPT Authorization headers from the active Codex session.";
    if (!stream) return json(res, 401, { error: { message } });
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    sse(res, { type: "response.failed", error: { message, status: 401 } });
    return res.end();
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
    upstream = await fetch(`${CHATGPT_CODEX_BASE_URL}/responses`, {
      method: "POST",
      headers: passthroughHeaders(req),
      body: bodyText,
      signal: controller.signal,
    });
  } catch (error) {
    cleanup();
    if (clientGone || res.writableEnded || error.name === "AbortError") {
      if (timedOut && !clientGone && !res.writableEnded) {
        const message = `GPT subscription passthrough timed out after ${UPSTREAM_TIMEOUT_MS}ms`;
        if (!stream) return json(res, 504, { error: { message } });
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        sse(res, { type: "response.failed", error: { message, status: 504 } });
        return res.end();
      }
      return;
    }
    const message = `GPT subscription passthrough failed before upstream response: ${error.message}`;
    if (!stream) return json(res, 502, { error: { message } });
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    sse(res, { type: "response.failed", error: { message, status: 502 } });
    return res.end();
  }

  copyResponseHeaders(upstream, res);
  res.statusCode = upstream.status;
  if (!upstream.body) {
    cleanup();
    const text = await upstream.text();
    return res.end(text);
  }
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.writableEnded) break; // client disconnected — stop draining upstream
      res.write(Buffer.from(value));
    }
  } catch (error) {
    if (!(clientGone || res.writableEnded || error.name === "AbortError")) {
      throw error;
    }
  } finally {
    cleanup();
    try { await reader.cancel(); } catch {}
    if (!res.writableEnded) res.end();
  }
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
  const prompt = extractPrompt(body);
  const toolSpecs = extractToolSpecs(body);
  const routeKind = claudeRoutes[routeModel] ? "claude" : grokRoutes[model] ? "grok" : minimaxRoutes[model] ? "minimax" : null;
  if (!routeKind) {
    if (isOfficialOpenAiSlug(model)) {
      return proxyChatgpt(req, res, bodyText, stream);
    }
    return json(res, 404, { error: { message: `unknown model slug: ${model}` } });
  }
  if (routeKind && isComputerUseRequest(prompt) && !hasComputerUseTool(toolSpecs)) {
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
  const streamMeta = stream ? { id: `resp_${crypto.randomBytes(12).toString("hex")}`, created_at: Math.floor(Date.now() / 1000) } : null;
  if (stream) {
    sse(res, { type: "response.created", response: inProgressResponseObject(model, streamMeta) });
    heartbeat = setInterval(() => {
      try {
        if (!res.writableEnded) {
          sse(res, { type: "response.in_progress", response: inProgressResponseObject(model, streamMeta) });
        }
      } catch {}
    }, HEARTBEAT_MS);
    if (typeof heartbeat.unref === "function") heartbeat.unref();
  }
  try {
    const result =
      routeKind === "claude"
        ? await runClaude(routeModel, prompt)
        : routeKind === "grok"
          ? await runGrok(model, prompt)
          : await runMiniMax(model, prompt);
    const toolCalls = toolSpecs.length > 0 ? extractRequestedToolCalls(result.text || "", toolSpecs) : null;
    if (toolCalls) {
      const { response, output } = toolCallResponseObjects(toolCalls, model, streamMeta || {});
      if (!stream) return json(res, 200, response);
      output.forEach((item) => sse(res, { type: "response.output_item.done", item }));
      sse(res, { type: "response.completed", response });
      res.end();
      return;
    }
    const claims = routeKind && isComputerUseRequest(prompt) ? claimedGuiActions(result.text || "") : [];
    if (claims.length > 0) {
      const previous = priorToolNames(body);
      const unsupportedClaims = claims.filter((name) => !previous.has(name));
      if (unsupportedClaims.length > 0) {
        throw hallucinatedComputerActionError(model, unsupportedClaims);
      }
    }
    const { response, output } = responseObjects(result.text || "", model, streamMeta || {});
    if (!stream) return json(res, 200, response);
    sse(res, { type: "response.output_item.done", item: output[0] });
    sse(res, { type: "response.completed", response });
    res.end();
  } catch (error) {
    if (routeKind && isBackendNoticeError(error)) {
      const { response, output } = responseObjects(backendNoticeText(model, error), model, streamMeta || {});
      if (!stream) return json(res, 200, response);
      sse(res, { type: "response.output_item.done", item: output[0] });
      sse(res, { type: "response.completed", response });
      res.end();
      return;
    }
    const payload = {
      type: "response.failed",
      error: {
        message: error.message,
        status: error.status || 500,
      },
    };
    if (!stream) return json(res, error.status || 500, { error: payload.error });
    sse(res, payload);
    res.end();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
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

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const test = require("node:test");

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

function tatwoV2CurrentTurn(input, computerHostRoute) {
  return {
    run_id: `run-${crypto.randomUUID()}`,
    turn_id: `turn-${crypto.randomUUID()}`,
    current_visible_turn_sha256:
      crypto.createHash("sha256").update(input, "utf8").digest("hex"),
    current_visible_turn_utf8_bytes: Buffer.byteLength(input, "utf8"),
    authority_nonce: crypto.randomUUID(),
    computer_host_route: computerHostRoute,
  };
}

async function requestJson(url) {
  const res = await fetch(url);
  assert.equal(res.status, 200);
  return res.json();
}

async function startMockChatgpt({
  requireStream = false,
  includeToolCall = false,
} = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const parsedBody = JSON.parse(body || "{}");
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: parsedBody,
      });
      if (requireStream && parsedBody.stream !== true) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Stream must be set to true" } }));
        return;
      }
      const model = parsedBody.model || "gpt-5.5";
      const functionCall = {
        id: "fc_native_runtime",
        type: "function_call",
        call_id: "call_native_runtime",
        name: "tatwo_project_read",
      };
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "x-models-etag": "test-etag",
      });
      res.end(
        [
          'event: response.created',
          `data: ${JSON.stringify({ type: "response.created", response: { id: "resp_test", status: "in_progress", model, output: [] } })}`,
          "",
          ...(includeToolCall
            ? [
                "event: response.function_call_arguments.done",
                `data: ${JSON.stringify({
                  type: "response.function_call_arguments.done",
                  item_id: functionCall.id,
                  output_index: 0,
                  arguments: "{\"path\":\"README.md\"}",
                })}`,
                "",
                "event: response.output_item.done",
                `data: ${JSON.stringify({
                  type: "response.output_item.done",
                  output_index: 0,
                  item: functionCall,
                })}`,
                "",
              ]
            : []),
          'event: response.completed',
          `data: ${JSON.stringify({ type: "response.completed", response: { id: "resp_test", status: "completed", model, output: [], output_text: "OK_GPT_PASSTHROUGH" } })}`,
          "",
        ].join("\n"),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, seen, baseUrl: `http://127.0.0.1:${server.address().port}/api/codex` };
}

async function startSlowMockChatgpt() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
      });
      res.write('data: {"type":"response.created"}\n\n');
      const interval = setInterval(() => {
        res.write(': upstream keepalive\n\n');
      }, 25);
      res.on("close", () => clearInterval(interval));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/api/codex` };
}

async function startBrokenStreamMockChatgpt() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8" });
      res.write('event: response.created\ndata: {"type":"response.created"}\n\n');
      setTimeout(() => res.destroy(new Error("simulated upstream stream reset")), 10);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/api/codex` };
}

function gptTerminalPayload(
  model = "gpt-5.6-sol",
  { fallbackCount = 0, outputText = "TERMINAL_OK" } = {},
) {
  const response = {
    id: "resp_terminal_fixture",
    status: "completed",
    output: [],
    output_text: outputText,
  };
  if (model) response.model = model;
  if (fallbackCount) response.fallback_count = fallbackCount;
  return {
    type: "response.completed",
    response,
  };
}

async function startFramingVariantMockChatgpt({
  contentType,
  framing,
  terminalModel = "gpt-5.6-sol",
  fallbackCount = 0,
  outputText = "TERMINAL_OK",
  abortAfterTerminal = false,
}) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const created = {
        type: "response.created",
        response: {
          id: "resp_terminal_fixture",
          status: "in_progress",
          model: terminalModel,
          output: [],
        },
      };
      const completed = gptTerminalPayload(terminalModel, {
        fallbackCount,
        outputText,
      });
      res.writeHead(200, { "content-type": contentType });
      if (framing === "ndjson") {
        res.write(`${JSON.stringify(created)}\n${JSON.stringify(completed)}\n`);
      } else {
        res.write(
          [
            "event: response.created",
            `data: ${JSON.stringify(created)}`,
            "",
            "event: response.completed",
            `data: ${JSON.stringify(completed)}`,
            "",
          ].join("\n"),
        );
      }
      if (abortAfterTerminal) {
        setTimeout(() => res.destroy(new Error("transport closed after terminal")), 20);
      } else {
        res.end();
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/api/codex` };
}

async function startFailingMockChatgpt(statusCode, body) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
      res.end(body);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/api/codex` };
}

async function startGateway(env = {}) {
  const port = await freePort();
  const effectiveEnv = { ...env };
  if (
    Object.prototype.hasOwnProperty.call(effectiveEnv, "GROK_MOCK_RESPONSE_JSON")
    && !Object.prototype.hasOwnProperty.call(effectiveEnv, "GROK_MOCK_SESSION_STATE_JSON")
  ) {
    effectiveEnv.GROK_MOCK_SESSION_STATE_JSON = JSON.stringify({
      session_id: "mock-grok-session",
      summary_session_id_matches: true,
      request_id_consistent: true,
      summary_current_model_id: "grok-4.6",
      turn_started_model_id: "grok-4.6",
      turn_ended_outcome: "success",
      turn_number: 0,
    });
  }
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      MODEL_GATEWAY_HOST: "127.0.0.1",
      MODEL_GATEWAY_PORT: String(port),
      ...effectiveEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(output || "gateway did not start")), 5000);
    child.stdout.on("data", (chunk) => {
      if (chunk.includes("listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.on("exit", () => reject(new Error(output || "gateway exited")));
  });
  return {
    port,
    child,
    close: async () => {
      child.kill("SIGTERM");
      await once(child, "exit").catch(() => {});
    },
  };
}

function parseSseEvents(text) {
  return text
    .split(/\n\n+/)
    .map((block) => block.split("\n").find((line) => line.startsWith("data: ")))
    .filter(Boolean)
    .map((line) => JSON.parse(line.slice("data: ".length)));
}

function hasSseEventType(text, type) {
  return parseSseEvents(text).some((event) => event.type === type);
}

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for file: ${filePath}`);
}

const redPngDataUrl =
  "data:image/png;base64," +
  "iVBORw0KGgoAAAANSUhEUgAAAFAAAABQCAIAAACreq1xAAAAeElEQVR4nO3QQQ3AIADAQMDM2H8l7kMG" +
  "vDQr2V3A3DkAAAB8D5kABMgEIEAmAAEyAQiQCUCATACCZAIQIBOAADIBCJAIQIBMAAJkAhAgE4AAmQAEyAQg" +
  "QCYAAfKf2w7g7wQAAIDfJgABMgEIEAmAAEyAQiQCUCATACCZAIQIBOAADIBCJAIQIBMAAJkAhAgE4AAeQP7" +
  "fQJXYWl3tQAAAABJRU5ErkJggg==";

async function startMockMiniMaxResponses() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: JSON.parse(body || "{}"),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output_text: "OK_MINIMAX_IMAGE", usage: { input_tokens: 10, output_tokens: 2 } }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, seen, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test("model catalog exposes first-class GPT, Claude, Grok, and MiniMax slugs while hiding deprecated ChatGPT Pro alias", async (t) => {
  const gateway = await startGateway();
  t.after(async () => gateway.close());

  const catalog = await requestJson(`http://127.0.0.1:${gateway.port}/v1/models`);
  const slugs = catalog.models.map((model) => model.slug);

  assert.deepEqual(
    [
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.4-mini",
      "opus-5",
      "opus-4-7",
      "opus-4-8",
      "sonnet-5",
      "haiku-4-5",
      "fable-5",
      "grok-build",
      "minimax-m3",
    ].every((slug) => slugs.includes(slug)),
    true,
  );
  assert.equal(slugs.includes("chatgpt-pro-consult"), false);
  const visibleGptSlugs = catalog.models
    .filter((model) => model.capabilities?.backend === "chatgpt_subscription")
    .map((model) => model.slug)
    .sort();
  assert.deepEqual(visibleGptSlugs, [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.5",
    "gpt-5.6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
  ]);
  assert.equal(slugs.includes("gpt-5.3-codex"), false);
  assert.equal(slugs.includes("gpt-5.3-codex-spark"), false);
  assert.equal(slugs.includes("gpt-5.2"), false);
  assert.equal(slugs.includes("codex-auto-review"), false);
  const sol = catalog.models.find((model) => model.slug === "gpt-5.6-sol");
  assert.equal(sol.display_name, "GPT-5.6 Sol");
  assert.equal(sol.capabilities.backend, "chatgpt_subscription");
  assert.deepEqual(sol.input_modalities, ["text", "image"]);
  const fable = catalog.models.find((model) => model.slug === "fable-5");
  assert.equal(fable.display_name, "fable5.1");
  assert.equal(fable.context_window, 1000000);
  assert.equal(fable.capabilities.backend, "claude_cli");
  assert.deepEqual(fable.input_modalities, ["text", "image"]);
  assert.equal(fable.supports_image_detail_original, true);
  const opus5 = catalog.models.find((model) => model.slug === "opus-5");
  assert.equal(opus5.display_name, "opus5");
  assert.equal(opus5.context_window, 1000000);
  assert.equal(slugs.includes("sonnet-4-6"), false);
  assert.equal(slugs.includes("haiku-4-6"), false);
  const haiku = catalog.models.find((model) => model.slug === "haiku-4-5");
  assert.equal(haiku.display_name, "haiku4.5");
  assert.equal(haiku.capabilities.backend, "claude_cli");
  const sonnet = catalog.models.find((model) => model.slug === "sonnet-5");
  assert.equal(sonnet.display_name, "sonnet5");
  assert.equal(sonnet.capabilities.backend, "claude_cli");
  assert.deepEqual(sonnet.input_modalities, ["text", "image"]);
  const grok = catalog.models.find((model) => model.slug === "grok-build");
  assert.deepEqual(grok.input_modalities, ["text", "image"]);
  assert.equal(grok.capabilities.vision, "responses_to_grok_prompt_json_image_blocks");
  const minimax = catalog.models.find((model) => model.slug === "minimax-m3");
  assert.equal(minimax.capabilities.backend, "minimax_api");
  assert.equal(minimax.capabilities.api_spend, "minimax-near-unlimited-api");
  assert.equal(minimax.capabilities.vision, "responses_multimodal_passthrough");
  assert.deepEqual(minimax.input_modalities, ["text", "image"]);
  assert.equal(minimax.context_window, 1000000);
});

test("healthz exposes deny-by-default API spend policy", async (t) => {
  const gateway = await startGateway({ GATEWAY_API_MODEL_ALLOWLIST: "local-openai-compatible,minimax-near-unlimited-api" });
  t.after(async () => gateway.close());

  const health = await requestJson(`http://127.0.0.1:${gateway.port}/healthz`);

  assert.equal(health.api_spend_policy.default, "deny_metered_api_fanout");
  assert.equal(health.api_spend_policy.human_confirmation_required, true);
  assert.deepEqual(health.api_spend_policy.active_api_model_allowlist, [
    "local-openai-compatible",
    "minimax-near-unlimited-api",
  ]);
  assert.equal(health.capabilities.claude.backend, "claude_cli");
  assert.equal(health.routes["chatgpt-pro-consult"].backend, "chatgpt_subscription");
  assert.equal(health.routes["chatgpt-pro-consult"].role, "codex_native_consultant");
  assert.equal(health.routes["chatgpt-pro-consult"].upstream_model, "gpt-5.5");
  assert.equal(health.capabilities.minimax.backend, "minimax_api");
  assert.equal(health.capabilities.minimax.spend_allowed, true);
  assert.ok(health.observed_at);
  assert.equal(health.ok, true);
  assert.equal(health.ok_scope, "listener_liveness_only");
  assert.equal(health.route_readiness, "inspect_each_route_status");
  assert.match(
    health.runtime_source.started_at,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
  );
  assert.match(health.runtime_source.sha256, /^[a-f0-9]{64}$/);
  assert.equal(health.routes["fable-5"].status, "untested");
  assert.equal(health.routes["fable-5"].healthy, false);
  assert.equal(health.routes["fable-5"].in_flight, 0);
  assert.equal(health.routes["fable-5"].last_attempt_at, null);
  assert.equal(health.routes["fable-5"].last_terminal_at, null);
  assert.equal(health.routes["fable-5"].last_outcome, null);
  assert.equal(health.routes["fable-5"].abort_requested_at, null);
  assert.equal(health.routes["fable-5"].accounting_violation_count, 0);
  assert.equal(health.routes["fable-5"].stale, false);
  assert.equal(health.routes["fable-5"].health_max_age_config_valid, true);
  assert.equal(health.routes["fable-5"].observed_at, health.observed_at);
});

test("Claude route health expires instead of treating an old success as permanently healthy", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: "OK_FRESH_ROUTE",
    GATEWAY_ROUTE_HEALTH_MAX_AGE_MS: "100",
  });
  t.after(async () => gateway.close());

  const input = "plain text";
  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fable-5",
      input: "reply exactly OK_FRESH_ROUTE",
      stream: false,
    }),
  });
  assert.equal(res.status, 200);

  const fresh = (await requestJson(`http://127.0.0.1:${gateway.port}/healthz`)).routes["fable-5"];
  assert.equal(fresh.status, "healthy");
  assert.equal(fresh.healthy, true);
  assert.equal(fresh.stale, false);

  await new Promise((resolve) => setTimeout(resolve, 150));
  const stale = (await requestJson(`http://127.0.0.1:${gateway.port}/healthz`)).routes["fable-5"];
  assert.equal(stale.status, "stale");
  assert.equal(stale.healthy, false);
  assert.equal(stale.stale, true);
  assert.ok(stale.last_ok_age_ms >= 100);
  assert.equal(stale.health_max_age_ms, 100);
  assert.equal(stale.health_max_age_config_valid, true);
});

test("invalid infinite route-health freshness fails closed", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: "OK_BUT_POLICY_INVALID",
    GATEWAY_ROUTE_HEALTH_MAX_AGE_MS: "Infinity",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fable-5",
      input: "reply exactly OK_BUT_POLICY_INVALID",
      stream: false,
    }),
  });
  assert.equal(res.status, 200);

  const route = (await requestJson(`http://127.0.0.1:${gateway.port}/healthz`)).routes["fable-5"];
  assert.equal(route.health_max_age_config_valid, false);
  assert.equal(route.health_max_age_ms, null);
  assert.equal(route.status, "stale");
  assert.equal(route.healthy, false);
  assert.equal(route.stale, true);
});

test("parallel Claude attempts balance in-flight accounting without clamping violations", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: "OK_PARALLEL",
    CLAUDE_MOCK_DELAY_MS: "150",
  });
  t.after(async () => gateway.close());

  const request = () =>
    fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fable-5",
        input: "reply exactly OK_PARALLEL",
        stream: false,
      }),
    });
  const pending = [request(), request()];

  let inProgress = null;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    inProgress = (await requestJson(`http://127.0.0.1:${gateway.port}/healthz`)).routes["fable-5"];
    if (inProgress.in_flight === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(inProgress.in_flight, 2);
  assert.equal(inProgress.status, "in_progress");

  const responses = await Promise.all(pending);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  const terminal = (await requestJson(`http://127.0.0.1:${gateway.port}/healthz`)).routes["fable-5"];
  assert.equal(terminal.attempts, 2);
  assert.equal(terminal.in_flight, 0);
  assert.equal(terminal.accounting_violation_count, 0);
  assert.equal(terminal.last_accounting_violation_at, null);
  assert.equal(terminal.status, "healthy");
});

test("GPT models are proxied to the ChatGPT Codex subscription endpoint", async (t) => {
  const upstream = await startMockChatgpt();
  t.after(() => upstream.server.close());
  const gateway = await startGateway({ CHATGPT_CODEX_BASE_URL: upstream.baseUrl });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
      "chatgpt-account-id": "account-123",
      "session-id": "session-123",
      "thread-id": "thread-123",
      originator: "codex_cli",
    },
    body: JSON.stringify({
      model: "gpt-5.5",
      input: "reply ok",
      stream: true,
    }),
  });

  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, /OK_GPT_PASSTHROUGH/);
  assert.doesNotMatch(text, /passthrough is not implemented/);
  assert.equal(upstream.seen.length, 1);
  assert.equal(upstream.seen[0].method, "POST");
  assert.equal(upstream.seen[0].url, "/api/codex/responses");
  assert.equal(upstream.seen[0].headers.authorization, "Bearer test-token");
  assert.equal(upstream.seen[0].headers["chatgpt-account-id"], "account-123");
  assert.equal(upstream.seen[0].headers["session-id"], "session-123");
  assert.equal(upstream.seen[0].headers["thread-id"], "thread-123");
  assert.equal(upstream.seen[0].body.model, "gpt-5.5");
});

test("GPT non-stream requests assemble tool calls and exact forwarding evidence", async (t) => {
  const upstream = await startMockChatgpt({
    requireStream: true,
    includeToolCall: true,
  });
  t.after(() => upstream.server.close());
  const gateway = await startGateway({ CHATGPT_CODEX_BASE_URL: upstream.baseUrl });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: "return one JSON response",
      stream: false,
      metadata: {
        tatwo_run_id: "native-runtime-regression",
      },
      reasoning: {
        effort: "high",
      },
    }),
  });
  const body = await res.json();
  const route = (await requestJson(
    `http://127.0.0.1:${gateway.port}/healthz`,
  )).routes["gpt-5.6-sol"];

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^application\/json/);
  assert.equal(upstream.seen.length, 1);
  assert.equal(upstream.seen[0].body.stream, true);
  assert.equal(upstream.seen[0].body.store, false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(upstream.seen[0].body, "metadata"),
    false,
  );
  assert.equal(body.status, "completed");
  assert.equal(body.model, "gpt-5.6-sol");
  assert.equal(body.output_text, "OK_GPT_PASSTHROUGH");
  assert.equal(body.output.length, 1);
  assert.equal(body.output[0].type, "function_call");
  assert.equal(body.output[0].call_id, "call_native_runtime");
  assert.equal(body.output[0].name, "tatwo_project_read");
  assert.equal(body.output[0].arguments, "{\"path\":\"README.md\"}");
  assert.equal(body.fallback_count, 0);
  assert.equal(body.model_attestation.actual_model, "gpt-5.6-sol");
  assert.equal(body.model_attestation.outcome, "VERIFIED_EXACT");
  assert.equal(body.model_attestation.exact, true);
  assert.equal(body.reasoning_control.requested, "high");
  assert.equal(body.reasoning_control.normalized, "high");
  assert.equal(body.reasoning_control.forwarded, true);
  assert.equal(body.reasoning_control.effective_attested, false);
  assert.equal(route.status, "healthy");
  assert.equal(route.actual_model, "gpt-5.6-sol");
  assert.equal(route.fallback_count, 0);
  assert.equal(route.attestation_outcome, "VERIFIED_EXACT");
});

test("ChatGPT Pro consultant route strips local metadata before GPT subscription passthrough", async (t) => {
  const upstream = await startMockChatgpt();
  t.after(() => upstream.server.close());
  const gateway = await startGateway({ CHATGPT_CODEX_BASE_URL: upstream.baseUrl });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
      "chatgpt-account-id": "account-123",
      "session-id": "session-123",
      originator: "codex_cli",
    },
    body: JSON.stringify({
      model: "chatgpt-pro-consult",
      input: "act as a bounded consultant",
      stream: true,
      metadata: { consult_id: "consult_test" },
    }),
  });

  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, /OK_GPT_PASSTHROUGH/);
  assert.equal(upstream.seen.length, 1);
  assert.equal(upstream.seen[0].body.model, "gpt-5.5");
  assert.equal(
    Object.prototype.hasOwnProperty.call(upstream.seen[0].body, "metadata"),
    false,
  );
  assert.equal(upstream.seen[0].headers.authorization, "Bearer test-token");
});

test("compact chatgpt-pro alias uses the same bounded consultant passthrough route", async (t) => {
  const upstream = await startMockChatgpt();
  t.after(() => upstream.server.close());
  const gateway = await startGateway({ CHATGPT_CODEX_BASE_URL: upstream.baseUrl });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({
      model: "chatgpt-pro",
      input: "reply ok",
      stream: true,
    }),
  });

  await res.text();
  assert.equal(res.status, 200);
  assert.equal(upstream.seen[0].body.model, "gpt-5.5");
});

test("GPT passthrough client disconnect aborts upstream without crashing gateway", async (t) => {
  const upstream = await startSlowMockChatgpt();
  t.after(() => upstream.server.close());
  const gateway = await startGateway({ CHATGPT_CODEX_BASE_URL: upstream.baseUrl });
  t.after(async () => gateway.close());

  const controller = new AbortController();
  const request = fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({
      model: "gpt-5.5",
      input: "stream slowly",
      stream: true,
    }),
    signal: controller.signal,
  });

  const res = await request;
  assert.equal(res.status, 200);
  controller.abort();
  await res.text().catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(gateway.child.exitCode, null);
  const health = await requestJson(`http://127.0.0.1:${gateway.port}/healthz`);
  assert.equal(health.ok, true);
});

test("GPT passthrough upstream stream resets do not crash the gateway process", async (t) => {
  const upstream = await startBrokenStreamMockChatgpt();
  t.after(() => upstream.server.close());
  const gateway = await startGateway({ CHATGPT_CODEX_BASE_URL: upstream.baseUrl });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({
      model: "gpt-5.5",
      input: "survive an upstream stream reset",
      stream: true,
    }),
  });
  const events = parseSseEvents(await res.text());
  await new Promise((resolve) => setTimeout(resolve, 100));

  const failed = events.find((event) => event.type === "response.failed");
  assert.equal(events.some((event) => event.type === "response.completed"), false);
  assert.equal(failed.error.error_kind, "upstream_5xx");
  assert.equal(failed.error.retry_allowed, true);
  assert.equal(gateway.child.exitCode, null);
  const health = await requestJson(`http://127.0.0.1:${gateway.port}/healthz`);
  assert.equal(health.ok, true);
});

test("GPT terminal observer accepts SSE framing under an unexpected content type", async (t) => {
  const upstream = await startFramingVariantMockChatgpt({
    contentType: "application/json",
    framing: "sse",
  });
  t.after(() => upstream.server.close());
  const gateway = await startGateway({ CHATGPT_CODEX_BASE_URL: upstream.baseUrl });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: "observe mismatched content type",
      stream: true,
    }),
  });
  const text = await res.text();
  const events = parseSseEvents(text);
  const route = (await requestJson(
    `http://127.0.0.1:${gateway.port}/healthz`,
  )).routes["gpt-5.6-sol"];

  assert.match(res.headers.get("content-type"), /^text\/event-stream\b/);
  assert.equal(events.some((event) => event.type === "response.completed"), true);
  assert.match(text, /TERMINAL_OK/);
  assert.equal(route.status, "healthy");
  assert.equal(route.actual_model, "gpt-5.6-sol");
  assert.equal(route.fallback_count, 0);
  assert.equal(route.terminal_event_type, "response.completed");
  assert.equal(route.attestation_outcome, "VERIFIED_EXACT");
});

test("GPT terminal observer accepts NDJSON framing without weakening exact-model checks", async (t) => {
  const upstream = await startFramingVariantMockChatgpt({
    contentType: "application/x-ndjson",
    framing: "ndjson",
    terminalModel: "gpt-5.6-terra",
  });
  t.after(() => upstream.server.close());
  const gateway = await startGateway({ CHATGPT_CODEX_BASE_URL: upstream.baseUrl });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: "reject the wrong exact model",
      stream: true,
    }),
  });
  const text = await res.text();
  const events = parseSseEvents(text);
  const route = (await requestJson(
    `http://127.0.0.1:${gateway.port}/healthz`,
  )).routes["gpt-5.6-sol"];

  assert.match(res.headers.get("content-type"), /^text\/event-stream\b/);
  assert.deepEqual(
    events.map((event) => event.type),
    ["response.created", "response.output_item.done", "response.completed"],
  );
  assert.match(events.at(-1).response.output_text, /^\[gateway-notice\]/);
  assert.doesNotMatch(text, /TERMINAL_OK|resp_terminal_fixture/);
  assert.equal(route.status, "unhealthy");
  assert.equal(route.error_kind, "model_attestation");
  assert.equal(route.actual_model, "gpt-5.6-terra");
  assert.equal(route.fallback_count, 0);
  assert.equal(route.terminal_event_type, "response.completed");
  assert.equal(route.attestation_outcome, "FAIL_CLOSED_MODEL_MISMATCH");
});

test("GPT streamed fallback and missing attestation expose only the fail-closed notice", async () => {
  const cases = [
    {
      name: "fallback",
      terminalModel: "gpt-5.6-sol",
      fallbackCount: 1,
      outputText: "SECRET_FALLBACK_PAYLOAD",
      outcome: "FAIL_CLOSED_FALLBACK",
    },
    {
      name: "missing",
      terminalModel: null,
      fallbackCount: 0,
      outputText: "SECRET_MISSING_ATTESTATION_PAYLOAD",
      outcome: "ATTESTATION_MISSING",
    },
  ];

  for (const fixture of cases) {
    const upstream = await startFramingVariantMockChatgpt({
      contentType: "application/json",
      framing: "sse",
      terminalModel: fixture.terminalModel,
      fallbackCount: fixture.fallbackCount,
      outputText: fixture.outputText,
    });
    const gateway = await startGateway({ CHATGPT_CODEX_BASE_URL: upstream.baseUrl });
    try {
      const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          model: "gpt-5.6-sol",
          input: `reject ${fixture.name} attestation`,
          stream: true,
        }),
      });
      const text = await res.text();
      const events = parseSseEvents(text);
      const route = (await requestJson(
        `http://127.0.0.1:${gateway.port}/healthz`,
      )).routes["gpt-5.6-sol"];

      assert.match(res.headers.get("content-type"), /^text\/event-stream\b/, fixture.name);
      assert.deepEqual(
        events.map((event) => event.type),
        ["response.created", "response.output_item.done", "response.completed"],
        fixture.name,
      );
      assert.match(events.at(-1).response.output_text, /^\[gateway-notice\]/, fixture.name);
      assert.doesNotMatch(
        text,
        /SECRET_(?:FALLBACK|MISSING_ATTESTATION)_PAYLOAD|resp_terminal_fixture/,
        fixture.name,
      );
      assert.equal(route.status, "unhealthy", fixture.name);
      assert.equal(route.attestation_outcome, fixture.outcome, fixture.name);
    } finally {
      await gateway.close();
      upstream.server.close();
    }
  }
});

test("GPT attestation buffer fails closed at its byte cap without leaking upstream content", async (t) => {
  const upstream = await startFramingVariantMockChatgpt({
    contentType: "application/json",
    framing: "sse",
    outputText: `SECRET_OVERSIZED_PAYLOAD_${"x".repeat(2048)}`,
  });
  t.after(() => upstream.server.close());
  const gateway = await startGateway({
    CHATGPT_CODEX_BASE_URL: upstream.baseUrl,
    MAX_CHILD_STDOUT_BYTES: "512",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: "reject an oversized pre-attestation stream",
      stream: true,
    }),
  });
  const text = await res.text();
  const events = parseSseEvents(text);
  const route = (await requestJson(
    `http://127.0.0.1:${gateway.port}/healthz`,
  )).routes["gpt-5.6-sol"];

  assert.match(res.headers.get("content-type"), /^text\/event-stream\b/);
  assert.deepEqual(
    events.map((event) => event.type),
    ["response.created", "response.output_item.done", "response.completed"],
  );
  assert.match(events.at(-1).response.output_text, /^\[gateway-notice\]/);
  assert.doesNotMatch(text, /SECRET_OVERSIZED_PAYLOAD|resp_terminal_fixture/);
  assert.equal(route.status, "unhealthy");
  assert.equal(route.error_kind, "output_cap");
  assert.equal(route.attestation_outcome, "FAIL_CLOSED_STREAM");
});

test("GPT valid terminal remains authoritative when the upstream transport aborts afterward", async (t) => {
  const upstream = await startFramingVariantMockChatgpt({
    contentType: "text/event-stream; charset=utf-8",
    framing: "sse",
    abortAfterTerminal: true,
  });
  t.after(() => upstream.server.close());
  const gateway = await startGateway({ CHATGPT_CODEX_BASE_URL: upstream.baseUrl });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: "accept the terminal before the trailing abort",
      stream: true,
    }),
  });
  const events = parseSseEvents(await res.text());
  const route = (await requestJson(
    `http://127.0.0.1:${gateway.port}/healthz`,
  )).routes["gpt-5.6-sol"];

  assert.equal(events.some((event) => event.type === "response.completed"), true);
  assert.equal(events.some((event) => event.type === "response.failed"), false);
  assert.equal(route.status, "healthy");
  assert.equal(route.actual_model, "gpt-5.6-sol");
  assert.equal(route.fallback_count, 0);
  assert.equal(route.terminal_event_type, "response.completed");
  assert.equal(route.attestation_outcome, "VERIFIED_EXACT");
});

test("GPT passthrough HTTP 520 stays retriable instead of completing an assistant message", async (t) => {
  const upstream = await startFailingMockChatgpt(520, "error code: 520");
  t.after(() => upstream.server.close());
  const gateway = await startGateway({ CHATGPT_CODEX_BASE_URL: upstream.baseUrl });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({
      model: "gpt-5.6-sol",
      input: "retry after an upstream edge failure",
      stream: true,
    }),
  });
  const events = parseSseEvents(await res.text());
  const failed = events.find((event) => event.type === "response.failed");

  assert.equal(res.status, 200);
  assert.equal(events.some((event) => event.type === "response.completed"), false);
  assert.equal(failed.error.status, 520);
  assert.equal(failed.error.error_kind, "upstream_5xx");
  assert.equal(failed.error.retry_allowed, true);
});

test("GPT authorization failures complete as degraded notices instead of response.failed", async (t) => {
  const gateway = await startGateway();
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.5",
      input: "reply visibly",
      stream: true,
    }),
  });
  const events = parseSseEvents(await res.text());
  const completed = events.find((event) => event.type === "response.completed");

  assert.equal(res.status, 200);
  assert.equal(events.some((event) => event.type === "response.failed"), false);
  assert.equal(completed.response.degraded, true);
  assert.equal(completed.response.error_kind, "auth");
  assert.equal(completed.response.retry_allowed, false);
});

test("oversized requests return a clean 413 instead of resetting the socket", async (t) => {
  const gateway = await startGateway({ GATEWAY_MAX_BODY_BYTES: "1024" });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "sonnet-5",
      input: "x".repeat(4096),
      stream: true,
    }),
  });

  const body = await res.json();
  assert.equal(res.status, 413);
  assert.match(body.error.message, /request body too large/);
});

test("Claude prompt bridge emits Codex function_call events without executing tools", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: JSON.stringify({
      tool_calls: [
        {
          type: "function_call",
          name: "exec_command",
          arguments: { cmd: "pwd", yield_time_ms: 1000 },
        },
      ],
    }),
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "sonnet-5",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "check cwd" }],
        },
      ],
      tools: [
        {
          type: "function",
          name: "exec_command",
          description: "Run a command in the Codex workspace.",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" }, yield_time_ms: { type: "integer" } },
            required: ["cmd"],
          },
        },
      ],
      stream: true,
    }),
  });

  const events = parseSseEvents(await res.text());
  const functionCall = events.find((event) => event.item?.type === "function_call");

  assert.equal(res.status, 200);
  assert.equal(functionCall.type, "response.output_item.done");
  assert.equal(functionCall.item.name, "exec_command");
  assert.equal(functionCall.item.namespace, undefined);
  assert.match(functionCall.item.call_id, /^call_/);
  assert.deepEqual(JSON.parse(functionCall.item.arguments), {
    cmd: "pwd",
    yield_time_ms: 1000,
  });
  assert.ok(events.some((event) => event.type === "response.completed"));
});

test("Claude text responses emit completed assistant message items for Codex App persistence", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: "OK_VISIBLE_ASSISTANT",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "haiku-4-5",
      input: "reply visibly",
      stream: true,
    }),
  });

  const events = parseSseEvents(await res.text());
  // Streaming may legitimately emit output_item.added first; persistence requires
  // a COMPLETED assistant message item, so select the done event specifically.
  const message = events.find((event) => event.type === "response.output_item.done" && event.item?.type === "message");

  assert.equal(res.status, 200);
  assert.equal(message.item.role, "assistant");
  assert.equal(message.item.status, "completed");
  assert.deepEqual(message.item.content, [{ type: "output_text", text: "OK_VISIBLE_ASSISTANT" }]);
  assert.ok(events.some((event) => event.type === "response.completed"));
});

test("oversized fragile-route requests auto-compact then forward to Claude instead of guard-only completing", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-compact-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const promptFile = path.join(tempDir, "haiku-prompt.txt");
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: "OK_AUTOCOMPACT_HAIKU",
    CLAUDE_MOCK_PROMPT_FILE: promptFile,
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "haiku-4-5",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "old receipt path /workspace/project/.tatwo-ultrawork/model-switch-guard/receipt.md sha256=0123456789abcdef\n" +
                "x".repeat(700 * 1024),
            },
          ],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Latest instruction: reply exactly OK_AUTOCOMPACT_HAIKU. FACT-ID=MSW-42." }],
        },
      ],
      stream: true,
    }),
  });

  const text = await res.text();
  const events = parseSseEvents(text);
  const prompt = fs.readFileSync(promptFile, "utf8");

  assert.equal(res.status, 200);
  assert.match(text, /OK_AUTOCOMPACT_HAIKU/);
  assert.equal(events.some((event) => event.type === "response.failed"), false);
  assert.doesNotMatch(text, /was not called because this same-thread context is too large/);
  assert.match(prompt, /\[model_gateway auto-compact S1\/S2\]/);
  assert.match(prompt, /S2_exact_sidecar_sha256=/);
  assert.match(prompt, /FACT-ID=MSW-42/);
  assert.match(prompt, /receipt\.md/);
  assert.ok(Buffer.byteLength(prompt, "utf8") < 260 * 1024, "forwarded prompt should be compacted");
});

test("oversized GPT mini requests auto-compact before ChatGPT passthrough", async (t) => {
  const upstream = await startMockChatgpt();
  t.after(() => upstream.server.close());
  const gateway = await startGateway({ CHATGPT_CODEX_BASE_URL: upstream.baseUrl });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-token",
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "old context " + "z".repeat(700 * 1024) }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Latest instruction: reply OK_GPT_PASSTHROUGH. /tmp/compact-gpt-mini" }] },
      ],
      stream: true,
    }),
  });

  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, /OK_GPT_PASSTHROUGH/);
  assert.equal(upstream.seen.length, 1);
  assert.equal(upstream.seen[0].body.model, "gpt-5.4-mini");
  assert.ok(Buffer.byteLength(JSON.stringify(upstream.seen[0].body), "utf8") < 512 * 1024);
  assert.match(upstream.seen[0].body.input[0].content[0].text, /\[model_gateway auto-compact S1\/S2\]/);
  assert.match(upstream.seen[0].body.input[0].content[0].text, /\/tmp\/compact-gpt-mini/);
});

test("auto-compact withholds oversized tool schemas only after compacted body still exceeds the route profile", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-compact-tools-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const promptFile = path.join(tempDir, "haiku-prompt.txt");
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: "OK_AUTOCOMPACT_WITHOUT_TOOLS",
    CLAUDE_MOCK_PROMPT_FILE: promptFile,
  });
  t.after(async () => gateway.close());

  const hugeToolDescription = "tool schema filler ".repeat(40 * 1024);
  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "haiku-4-5",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "old context " + "t".repeat(700 * 1024) }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Latest instruction: answer OK_AUTOCOMPACT_WITHOUT_TOOLS." }] },
      ],
      tools: [{ type: "function", name: "very_large_tool", description: hugeToolDescription, parameters: { type: "object" } }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      stream: true,
    }),
  });

  const text = await res.text();
  const prompt = fs.readFileSync(promptFile, "utf8");
  assert.equal(res.status, 200);
  assert.match(text, /OK_AUTOCOMPACT_WITHOUT_TOOLS/);
  assert.match(prompt, /tool schemas were withheld/);
  assert.doesNotMatch(prompt, /very_large_tool/);
});

test("oversized MiniMax M3 requests auto-compact before MiniMax API forwarding", async (t) => {
  const upstream = await startMockMiniMaxResponses();
  t.after(() => upstream.server.close());
  const gateway = await startGateway({
    GATEWAY_API_MODEL_ALLOWLIST: "minimax-near-unlimited-api",
    MINIMAX_API_KEY: "test-key",
    MINIMAX_BASE_URL: upstream.baseUrl,
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "minimax-m3",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "old context " + "m".repeat(700 * 1024) }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Latest instruction: mention /tmp/compact-minimax." }] },
      ],
      stream: true,
    }),
  });

  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, /OK_MINIMAX_IMAGE/);
  assert.equal(upstream.seen.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(upstream.seen[0].body), "utf8") < 512 * 1024);
  assert.match(upstream.seen[0].body.input, /\[model_gateway auto-compact S1\/S2\]/);
  assert.match(upstream.seen[0].body.input, /\/tmp\/compact-minimax/);
});

test("MiniMax same-thread compaction classifies host intent from the latest user turn only", async (t) => {
  const gateway = await startGateway({
    GATEWAY_API_MODEL_ALLOWLIST: "minimax-near-unlimited-api",
    MINIMAX_MOCK_RESPONSE_JSON: "CODEX_GATEWAY_CONTEXT_SAFE_READ",
  });
  t.after(async () => gateway.close());

  const hugeToolDescription = "historical tool schema for editing files and running shell commands ".repeat(24 * 1024);
  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "minimax-m3",
      instructions:
        "Historical Codex host policy discusses how tools may edit files, run shell commands, and operate GUI apps. " +
        "These policy examples are not the current user request.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "old same-thread context " + "m".repeat(600 * 1024) }],
        },
        {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "Find the earlier verification code and reply only CODEX_GATEWAY_CONTEXT_SAFE_READ.",
          }],
        },
      ],
      tools: [{
        type: "function",
        name: "historical_exec_command",
        description: hugeToolDescription,
        parameters: { type: "object" },
      }],
      tool_choice: "auto",
      parallel_tool_calls: true,
      stream: false,
    }),
  });

  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.output_text, "CODEX_GATEWAY_CONTEXT_SAFE_READ");
  assert.doesNotMatch(body.output_text, /blocker_class=tool_unavailable/);
});

test("Fable text-only review with explicit no-tool clauses is not rewritten as tool_unavailable", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: "FABLE_TEXT_ONLY_REVIEW_OK",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fable-5",
      input: [
        {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "Earlier turn: please edit files and run shell commands.",
          }],
        },
        {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text:
              "本輪只做純文字獨立副審。不得聲稱你執行了工具或測試，不得改檔。只回覆審查結論。",
          }],
        },
      ],
      stream: false,
    }),
  });

  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.output_text, "FABLE_TEXT_ONLY_REVIEW_OK");
  assert.doesNotMatch(body.output_text, /blocker_class=tool_unavailable/);
});

test("Fable text-only no-tool clauses remain text-only in streaming mode", async (t) => {
  const expectedText = "FABLE_STREAM_TEXT_ONLY_REVIEW_OK";
  const streamJsonl = [
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: expectedText },
      },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: expectedText,
      usage: { input_tokens: 12, output_tokens: 8 },
    }),
  ].join("\n");
  const gateway = await startGateway({
    CLAUDE_MOCK_STREAM_JSONL: streamJsonl,
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fable-5",
      input: [
        {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "Earlier turn: please edit files and run shell commands.",
          }],
        },
        {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text:
              "本輪只做純文字獨立副審。不得聲稱你執行了工具或測試，不得改檔。只回覆審查結論。",
          }],
        },
      ],
      stream: true,
    }),
  });

  const events = parseSseEvents(await res.text());
  const completed = events.find((event) => event.type === "response.completed");
  const streamedText = events
    .filter((event) => event.type === "response.output_text.delta")
    .map((event) => event.delta)
    .join("");

  assert.equal(res.status, 200);
  assert.equal(streamedText, expectedText);
  assert.equal(completed.response.output_text, expectedText);
  assert.doesNotMatch(streamedText, /blocker_class=tool_unavailable/);
  assert.doesNotMatch(completed.response.output_text, /blocker_class=tool_unavailable/);
});

test("negated preface does not hide a later explicit host execution request", async (t) => {
  const gateway = await startGateway({
    GROK_MOCK_RESPONSE_JSON: "I cannot execute without a bridged host tool.",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-build",
      input: "不要只說明，直接修改 repo 檔案。",
      stream: false,
    }),
  });

  const body = await res.json();

  assert.equal(res.status, 200);
  assert.match(body.output_text, /blocker_class=tool_unavailable/);
  assert.match(body.output_text, /authority_source=runner/);
});

test("Haiku same-thread compaction accepts a bounded exact sidecar above the old 180-line ceiling", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-haiku-exact-lines-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const promptFile = path.join(tempDir, "haiku-prompt.txt");
  const exactLines = Array.from(
    { length: 210 },
    (_, index) => `FACT-ID=CTX-${String(index).padStart(3, "0")} route=haiku-4-5 value=${index}`,
  ).join("\n");
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: "CODEX_GATEWAY_CONTEXT_HAIKU_SAFE",
    CLAUDE_MOCK_PROMPT_FILE: promptFile,
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "haiku-4-5",
      input: [
        {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: `${exactLines}\nold context filler ${"h".repeat(430 * 1024)}`,
          }],
        },
        {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "Reply only CODEX_GATEWAY_CONTEXT_HAIKU_SAFE.",
          }],
        },
      ],
      stream: true,
    }),
  });

  const text = await res.text();
  const prompt = fs.readFileSync(promptFile, "utf8");

  assert.equal(res.status, 200);
  assert.match(text, /CODEX_GATEWAY_CONTEXT_HAIKU_SAFE/);
  assert.doesNotMatch(text, /context guard/);
  assert.match(prompt, /exact_line_count=21[01]/);
  assert.ok(Buffer.byteLength(prompt, "utf8") < 384 * 1024);
});

test("secret-risk oversized requests fail closed with a completed guard warning and do not call Claude", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-secret-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const promptFile = path.join(tempDir, "should-not-exist.txt");
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: "SHOULD_NOT_CALL_BACKEND",
    CLAUDE_MOCK_PROMPT_FILE: promptFile,
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "haiku-4-5",
      input: `old context ${"s".repeat(700 * 1024)}\nOPENAI_API_KEY=${["sk", "proj", "abcdefghijklmnopqrstuvwxyz123456"].join("-")}`,
      stream: true,
    }),
  });

  const text = await res.text();
  const events = parseSseEvents(text);
  assert.equal(res.status, 200);
  assert.match(text, /context guard/);
  assert.match(text, /secret-risk/);
  assert.equal(events.some((event) => event.type === "response.completed"), true);
  assert.equal(events.some((event) => event.type === "response.failed"), false);
  assert.equal(fs.existsSync(promptFile), false);
});

test("Claude image requests use native image blocks instead of dropping attachments", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-vision-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const promptFile = path.join(tempDir, "claude-vision-prompt.txt");
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: "OK_CLAUDE_IMAGE",
    CLAUDE_MOCK_PROMPT_FILE: promptFile,
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fable-5",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "what color?" },
            { type: "input_image", image_url: redPngDataUrl },
          ],
        },
      ],
      stream: true,
    }),
  });

  const text = await res.text();
  const prompt = fs.readFileSync(promptFile, "utf8");
  assert.equal(res.status, 200);
  assert.match(text, /OK_CLAUDE_IMAGE/);
  assert.match(prompt, /NATIVE_IMAGE_BLOCKS: 1/);
});

test("Claude long buffered streams emit semantic in-progress heartbeats before completion", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: "OK_AFTER_HEARTBEAT",
    CLAUDE_MOCK_DELAY_MS: "90",
    GATEWAY_HEARTBEAT_MS: "20",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "opus-4-8",
      input: "reply after heartbeat",
      stream: true,
    }),
  });

  const events = parseSseEvents(await res.text());
  const createdIndex = events.findIndex((event) => event.type === "response.created");
  const heartbeatIndex = events.findIndex((event) => event.type === "response.in_progress");
  const completedIndex = events.findIndex((event) => event.type === "response.completed");

  assert.equal(res.status, 200);
  assert.equal(createdIndex, 0);
  assert.ok(heartbeatIndex > createdIndex);
  assert.ok(completedIndex > heartbeatIndex);
  assert.ok(events.some((event) => event.item?.type === "message" && event.item.content?.[0]?.text === "OK_AFTER_HEARTBEAT"));
});

test("Claude subscription limits complete visibly instead of triggering Codex retry loops", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_ERROR_TEXT: "You've hit your session limit · resets 4:30am",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "opus-4-7",
      input: "reply visibly",
      stream: true,
    }),
  });

  const events = parseSseEvents(await res.text());
  const message = events.find((event) => event.type === "response.output_item.done" && event.item?.type === "message");

  assert.equal(res.status, 200);
  assert.equal(message.type, "response.output_item.done");
  assert.match(message.item.content[0].text, /session limit/);
  assert.ok(events.some((event) => event.type === "response.completed"));
  assert.equal(events.some((event) => event.type === "response.failed"), false);
});

test("Claude model-unavailable backend notices complete visibly instead of retrying", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_ERROR_TEXT: "Claude Fable 5 is currently unavailable. Learn more: https://example.test/fable",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fable-5",
      input: "reply visibly",
      stream: true,
    }),
  });

  const events = parseSseEvents(await res.text());
  const message = events.find((event) => event.type === "response.output_item.done" && event.item?.type === "message");
  const health = await requestJson(`http://127.0.0.1:${gateway.port}/healthz`);

  assert.equal(res.status, 200);
  assert.equal(message.type, "response.output_item.done");
  assert.match(message.item.content[0].text, /currently unavailable/);
  assert.ok(events.some((event) => event.type === "response.completed"));
  assert.equal(events.some((event) => event.type === "response.failed"), false);
  assert.equal(health.routes["fable-5"].error_kind, "model");
});

test("Claude advisor incompatibility completes once as a model/config notice", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_ERROR_TEXT:
      "Fable 5 models cannot be used as an advisor model. Please disable the advisor configuration.",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fable-5",
      input: "return one bounded planning decision",
      stream: true,
    }),
  });

  const text = await res.text();
  const events = parseSseEvents(text);
  const message = events.find(
    (event) => event.type === "response.output_item.done" && event.item?.type === "message",
  );
  const route = (await requestJson(`http://127.0.0.1:${gateway.port}/healthz`))
    .routes["fable-5"];

  assert.equal(res.status, 200);
  assert.match(message.item.content[0].text, /advisor model/);
  assert.equal(events.filter((event) => event.type === "response.completed").length, 1);
  assert.equal(events.some((event) => event.type === "response.failed"), false);
  assert.equal(route.attempts, 1);
  assert.deepEqual(route.candidate_hits, {});
  assert.equal(route.error_kind, "configuration");
  assert.equal(route.status, "unhealthy");
});

test("Claude explicit upstream 5xx and overload failures stay retriable without candidate retries", async () => {
  const cases = [
    "Anthropic overloaded_error: service overloaded",
    "upstream HTTP 502 Bad Gateway",
    "upstream HTTP 520: error code: 520",
  ];

  for (const errorText of cases) {
    const gateway = await startGateway({
      CLAUDE_MOCK_ERROR_TEXT: errorText,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "fable-5",
          input: "return one bounded planning decision",
          stream: true,
        }),
      });

      const events = parseSseEvents(await res.text());
      const route = (await requestJson(`http://127.0.0.1:${gateway.port}/healthz`))
        .routes["fable-5"];
      const failed = events.find((event) => event.type === "response.failed");

      assert.equal(res.status, 200);
      assert.equal(events.some((event) => event.type === "response.completed"), false);
      assert.equal(failed.error.error_kind, "upstream_5xx");
      assert.equal(failed.error.retry_allowed, true);
      assert.equal(route.attempts, 1);
      assert.deepEqual(route.candidate_hits, {});
      assert.equal(route.error_kind, "upstream_5xx");
      assert.equal(route.status, "unhealthy");
    } finally {
      await gateway.close();
    }
  }
});

test("all Claude CLI paths use safe mode to ignore user settings plugins hooks and advisors", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const bufferedArgs = source.slice(
    source.indexOf("function claudeArgs"),
    source.indexOf("function isModelError"),
  );
  const visionArgs = source.slice(
    source.indexOf("function claudeStreamInputArgs"),
    source.indexOf("function claudeVisionMessage"),
  );

  assert.match(bufferedArgs, /"-p",\s*\n\s*"--safe-mode",/);
  assert.match(visionArgs, /"-p",\s*\n\s*"--safe-mode",/);
  assert.match(bufferedArgs, /"--strict-mcp-config"/);
  assert.match(visionArgs, /"--strict-mcp-config"/);
  assert.match(bufferedArgs, /"--disallowedTools",\s*\n\s*"\*"/);
  assert.match(visionArgs, /"--disallowedTools",\s*\n\s*"\*"/);
  assert.match(bufferedArgs, /"--input-format",\s*\n\s*"text"/);
  assert.doesNotMatch(bufferedArgs, /\n\s*prompt,\s*\n/);
});

test("Claude text prompts use stdin so long same-thread turns do not hit argv E2BIG", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-claude-stdin-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const stdinFile = path.join(tempDir, "stdin.txt");
  const argvFile = path.join(tempDir, "argv.json");
  const claudeStub = path.join(tempDir, "claude-stdin-stub.js");
  fs.writeFileSync(
    claudeStub,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { input += chunk; });',
      'process.stdin.on("end", () => {',
      "  fs.writeFileSync(process.env.CLAUDE_CAPTURE_STDIN_FILE, input);",
      "  fs.writeFileSync(process.env.CLAUDE_CAPTURE_ARGV_FILE, JSON.stringify(process.argv.slice(2)));",
      '  const args = process.argv.slice(2);',
      '  const streaming = args[args.indexOf("--output-format") + 1] === "stream-json";',
      "  if (streaming) {",
      '    process.stdout.write(JSON.stringify({ type: "assistant", message: { model: "claude-fable-5-1", content: [] } }) + "\\n");',
      '    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "FABLE_STDIN_OK", usage: { input_tokens: 10, output_tokens: 3 } }) + "\\n");',
      "  } else {",
      '    process.stdout.write(JSON.stringify({ type: "assistant", message: { model: "claude-fable-5-1", content: [] }, result: "FABLE_STDIN_OK", usage: { input_tokens: 10, output_tokens: 3 } }));',
      "  }",
      "});",
      "",
    ].join("\n"),
  );
  fs.chmodSync(claudeStub, 0o755);

  const gateway = await startGateway({
    CLAUDE_COMMAND: claudeStub,
    CLAUDE_CAPTURE_STDIN_FILE: stdinFile,
    CLAUDE_CAPTURE_ARGV_FILE: argvFile,
  });
  t.after(async () => gateway.close());

  const marker = "FABLE_LONG_SESSION_STDIN_MARKER";
  const longPrompt = `${marker}\n${"x".repeat(384 * 1024)}`;
  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fable-5",
      input: longPrompt,
      stream: true,
    }),
  });

  const events = parseSseEvents(await res.text());
  const completed = events.find((event) => event.type === "response.completed");
  const stdin = fs.readFileSync(stdinFile, "utf8");
  const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));

  assert.equal(res.status, 200);
  assert.equal(completed.response.output_text, "FABLE_STDIN_OK");
  assert.match(stdin, new RegExp(marker));
  assert.ok(Buffer.byteLength(stdin, "utf8") > 384 * 1024);
  assert.equal(argv.some((argument) => String(argument).includes(marker)), false);
  assert.ok(Buffer.byteLength(JSON.stringify(argv), "utf8") < 64 * 1024);
});

test("Claude auth failures complete as degraded notices without triggering response.failed", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_ERROR_TEXT: "Your authentication token has been invalidated. Please try signing in again.",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fable-5",
      input: "reply visibly",
      stream: true,
    }),
  });

  const text = await res.text();
  const events = parseSseEvents(text);
  const completed = events.find((event) => event.type === "response.completed");

  assert.equal(res.status, 200);
  assert.equal(events.some((event) => event.type === "response.failed"), false);
  assert.match(completed.response.output_text, /invalidated/);
  assert.equal(completed.response.degraded, true);
  assert.equal(completed.response.error_kind, "auth");
  assert.equal(completed.response.retry_allowed, false);
});

test("Claude zero-result streams complete visibly while keeping unhealthy fail-closed health metadata", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_STREAM_JSONL: "",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fable-5",
      input: "return a structured direction decision",
      stream: true,
    }),
  });

  const text = await res.text();
  const health = await requestJson(`http://127.0.0.1:${gateway.port}/healthz`);
  const route = health.routes["fable-5"];

  assert.equal(res.status, 200);
  assert.equal(hasSseEventType(text, "response.failed"), false);
  assert.equal(hasSseEventType(text, "response.completed"), true);
  assert.equal(route.attempts, 1);
  assert.equal(route.in_flight, 0);
  assert.equal(route.has_error, true);
  assert.equal(route.error_kind, "parse");
  assert.equal(route.status, "unhealthy");
  assert.equal(route.healthy, false);
  assert.ok(route.last_attempt_at);
  assert.ok(route.last_terminal_at);
  assert.equal(route.last_outcome, "error");
  assert.ok(route.last_error_at);
  assert.ok(route.observed_at);
});

test("Claude streaming client disconnect terminates the child and records a cancelled route", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-claude-abort-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const startedFile = path.join(tempDir, "started");
  const terminatedFile = path.join(tempDir, "terminated");
  const claudeStub = path.join(tempDir, "claude-stub.sh");
  fs.writeFileSync(
    claudeStub,
    [
      "#!/bin/sh",
      "wait_pid=",
      "trap 'if [ -n \"$wait_pid\" ]; then kill \"$wait_pid\" 2>/dev/null || true; fi; printf terminated > \"$CLAUDE_CHILD_TERMINATED_FILE\"; exit 143' TERM INT",
      "sleep 30 &",
      "wait_pid=$!",
      "printf started > \"$CLAUDE_CHILD_STARTED_FILE\"",
      "wait \"$wait_pid\"",
    ].join("\n"),
  );
  fs.chmodSync(claudeStub, 0o755);

  const gateway = await startGateway({
    CLAUDE_COMMAND: claudeStub,
    CLAUDE_CHILD_STARTED_FILE: startedFile,
    CLAUDE_CHILD_TERMINATED_FILE: terminatedFile,
    CLAUDE_TIMEOUT_MS: "30000",
  });
  t.after(async () => gateway.close());

  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: controller.signal,
    body: JSON.stringify({
      model: "fable-5",
      input: "wait until the client disconnects",
      stream: true,
    }),
  });
  await waitForFile(startedFile);
  const inProgressRoute = (await requestJson(`http://127.0.0.1:${gateway.port}/healthz`)).routes["fable-5"];
  assert.equal(inProgressRoute.attempts, 1);
  assert.equal(inProgressRoute.in_flight, 1);
  assert.equal(inProgressRoute.status, "in_progress");
  assert.equal(inProgressRoute.healthy, false);
  assert.equal(inProgressRoute.last_terminal_at, null);
  assert.equal(inProgressRoute.last_outcome, null);
  controller.abort();
  await response.text().catch(() => {});
  await waitForFile(terminatedFile);

  let route = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    route = (await requestJson(`http://127.0.0.1:${gateway.port}/healthz`)).routes["fable-5"];
    if (route.in_flight === 0 && route.error_kind === "client_disconnect") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(route.attempts, 1);
  assert.equal(route.in_flight, 0);
  assert.equal(route.has_error, true);
  assert.equal(route.error_kind, "client_disconnect");
  assert.equal(route.status, "unhealthy");
  assert.equal(route.healthy, false);
  assert.ok(route.last_attempt_at);
  assert.ok(route.last_terminal_at);
  assert.equal(route.last_outcome, "cancelled");
  assert.ok(route.last_error_at);
});

test("Claude buffered text image and tool-bridge disconnects all terminate their child", async (t) => {
  const scenarios = [
    {
      name: "buffered_text",
      body: {
        model: "fable-5",
        input: "wait until the buffered client disconnects",
        stream: false,
      },
    },
    {
      name: "image",
      body: {
        model: "fable-5",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "wait while inspecting this image" },
              { type: "input_image", image_url: redPngDataUrl },
            ],
          },
        ],
        stream: true,
      },
    },
    {
      name: "tool_bridge",
      body: {
        model: "fable-5",
        input: "wait before selecting a tool",
        tools: [
          {
            type: "function",
            name: "read_only_probe",
            description: "A test-only read-only probe.",
            parameters: { type: "object", properties: {} },
          },
        ],
        stream: true,
      },
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `codex-gateway-${scenario.name}-abort-`));
      t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
      const startedFile = path.join(tempDir, "started");
      const terminatedFile = path.join(tempDir, "terminated");
      const claudeStub = path.join(tempDir, "claude-stub.sh");
      fs.writeFileSync(
        claudeStub,
        [
          "#!/bin/sh",
          "wait_pid=",
          "trap 'if [ -n \"$wait_pid\" ]; then kill \"$wait_pid\" 2>/dev/null || true; fi; printf terminated > \"$CLAUDE_CHILD_TERMINATED_FILE\"; exit 143' TERM INT",
          "sleep 30 &",
          "wait_pid=$!",
          "printf started > \"$CLAUDE_CHILD_STARTED_FILE\"",
          "wait \"$wait_pid\"",
        ].join("\n"),
      );
      fs.chmodSync(claudeStub, 0o755);

      const gateway = await startGateway({
        CLAUDE_COMMAND: claudeStub,
        CLAUDE_CHILD_STARTED_FILE: startedFile,
        CLAUDE_CHILD_TERMINATED_FILE: terminatedFile,
        CLAUDE_TIMEOUT_MS: "30000",
      });
      t.after(async () => gateway.close());

      const controller = new AbortController();
      const response = fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(scenario.body),
      });
      await waitForFile(startedFile);
      controller.abort();
      await response.then((value) => value.text()).catch(() => {});
      await waitForFile(terminatedFile);

      let route = null;
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        route = (await requestJson(`http://127.0.0.1:${gateway.port}/healthz`)).routes["fable-5"];
        if (route.in_flight === 0 && route.error_kind === "client_disconnect") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      assert.equal(route.attempts, 1);
      assert.equal(route.in_flight, 0);
      assert.equal(route.error_kind, "client_disconnect");
      assert.equal(route.last_outcome, "cancelled");
      assert.equal(route.accounting_violation_count, 0);
      assert.deepEqual(route.candidate_hits, {});
    });
  }
});

test("Claude disconnect stays aborting until an ignored SIGTERM is escalated and the process group closes", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-claude-sigkill-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const startedFile = path.join(tempDir, "started");
  const pidFile = path.join(tempDir, "pid");
  const claudeStub = path.join(tempDir, "claude-stub.sh");
  fs.writeFileSync(
    claudeStub,
    [
      "#!/bin/sh",
      "trap '' TERM INT",
      "sh -c 'trap \"\" TERM INT; while :; do sleep 1; done' &",
      "printf '%s' \"$$\" > \"$CLAUDE_CHILD_PID_FILE\"",
      "printf started > \"$CLAUDE_CHILD_STARTED_FILE\"",
      "wait",
    ].join("\n"),
  );
  fs.chmodSync(claudeStub, 0o755);

  const gateway = await startGateway({
    CLAUDE_COMMAND: claudeStub,
    CLAUDE_CHILD_STARTED_FILE: startedFile,
    CLAUDE_CHILD_PID_FILE: pidFile,
    CLAUDE_ABORT_GRACE_MS: "300",
    CLAUDE_TIMEOUT_MS: "30000",
  });
  t.after(async () => gateway.close());

  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: controller.signal,
    body: JSON.stringify({
      model: "fable-5",
      input: "ignore SIGTERM until the gateway escalates",
      stream: true,
    }),
  });
  await waitForFile(startedFile);
  const childPid = Number(fs.readFileSync(pidFile, "utf8"));
  controller.abort();
  await response.text().catch(() => {});

  let aborting = null;
  const abortDeadline = Date.now() + 250;
  while (Date.now() < abortDeadline) {
    aborting = (await requestJson(`http://127.0.0.1:${gateway.port}/healthz`)).routes["fable-5"];
    if (aborting.status === "aborting") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(aborting.status, "aborting");
  assert.equal(aborting.in_flight, 1);
  assert.equal(aborting.last_terminal_at, null);
  assert.equal(aborting.last_outcome, "aborting");
  assert.ok(aborting.abort_requested_at);

  let terminal = null;
  const terminalDeadline = Date.now() + 5000;
  while (Date.now() < terminalDeadline) {
    terminal = (await requestJson(`http://127.0.0.1:${gateway.port}/healthz`)).routes["fable-5"];
    if (terminal.in_flight === 0 && terminal.error_kind === "client_disconnect") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(terminal.in_flight, 0);
  assert.equal(terminal.last_outcome, "cancelled");
  assert.equal(terminal.error_kind, "client_disconnect");
  assert.ok(terminal.last_terminal_at);
  assert.equal(terminal.accounting_violation_count, 0);
  assert.throws(() => process.kill(-childPid, 0), (error) => error?.code === "ESRCH");
});

test("Claude terminal accounting waits when the leader exits but a descendant survives", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-claude-descendant-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const startedFile = path.join(tempDir, "started");
  const descendantReadyFile = path.join(tempDir, "descendant-ready");
  const leaderPidFile = path.join(tempDir, "leader-pid");
  const descendantPidFile = path.join(tempDir, "descendant-pid");
  const claudeStub = path.join(tempDir, "claude-stub.sh");
  fs.writeFileSync(
    claudeStub,
    [
      "#!/bin/sh",
      "trap 'exit 0' TERM INT",
      "sh -c 'trap \"\" TERM INT; exec </dev/null >/dev/null 2>&1; printf ready > \"$CLAUDE_DESCENDANT_READY_FILE\"; while :; do sleep 1; done' &",
      "descendant_pid=$!",
      "while [ ! -f \"$CLAUDE_DESCENDANT_READY_FILE\" ]; do sleep 0.01; done",
      "printf '%s' \"$$\" > \"$CLAUDE_LEADER_PID_FILE\"",
      "printf '%s' \"$descendant_pid\" > \"$CLAUDE_DESCENDANT_PID_FILE\"",
      "printf started > \"$CLAUDE_CHILD_STARTED_FILE\"",
      "wait \"$descendant_pid\"",
    ].join("\n"),
  );
  fs.chmodSync(claudeStub, 0o755);

  const gateway = await startGateway({
    CLAUDE_COMMAND: claudeStub,
    CLAUDE_CHILD_STARTED_FILE: startedFile,
    CLAUDE_DESCENDANT_READY_FILE: descendantReadyFile,
    CLAUDE_LEADER_PID_FILE: leaderPidFile,
    CLAUDE_DESCENDANT_PID_FILE: descendantPidFile,
    CLAUDE_ABORT_GRACE_MS: "300",
    CLAUDE_TIMEOUT_MS: "30000",
  });
  t.after(async () => gateway.close());

  const controller = new AbortController();
  const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: controller.signal,
    body: JSON.stringify({
      model: "fable-5",
      input: "leave a descendant behind after the leader exits",
      stream: true,
    }),
  });
  await waitForFile(startedFile);
  const leaderPid = Number(fs.readFileSync(leaderPidFile, "utf8"));
  const descendantPid = Number(fs.readFileSync(descendantPidFile, "utf8"));
  controller.abort();
  await response.text().catch(() => {});

  await new Promise((resolve) => setTimeout(resolve, 50));
  const beforeEscalation = (await requestJson(`http://127.0.0.1:${gateway.port}/healthz`)).routes["fable-5"];
  assert.equal(beforeEscalation.status, "aborting");
  assert.equal(beforeEscalation.in_flight, 1);
  assert.equal(beforeEscalation.last_terminal_at, null);
  assert.doesNotThrow(() => process.kill(-leaderPid, 0));
  assert.doesNotThrow(() => process.kill(descendantPid, 0));

  let terminal = null;
  const terminalDeadline = Date.now() + 5000;
  while (Date.now() < terminalDeadline) {
    terminal = (await requestJson(`http://127.0.0.1:${gateway.port}/healthz`)).routes["fable-5"];
    if (terminal.in_flight === 0 && terminal.error_kind === "client_disconnect") break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(terminal.in_flight, 0);
  assert.equal(terminal.last_outcome, "cancelled");
  assert.equal(terminal.error_kind, "client_disconnect");
  assert.ok(terminal.last_terminal_at);
  assert.throws(() => process.kill(-leaderPid, 0), (error) => error?.code === "ESRCH");
  assert.throws(() => process.kill(descendantPid, 0), (error) => error?.code === "ESRCH");
});

test("Claude child error handlers record diagnostics and defer settlement to close", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const claudeChildSection = source.slice(
    source.indexOf("function signalChildTree"),
    source.indexOf("function grokPromptJsonBlocks"),
  );
  const handlers = [
    ...claudeChildSection.matchAll(
      /child\.on\("error", \(error\) => \{([\s\S]*?)\n    \}\);/g,
    ),
  ].map((match) => match[1]);

  assert.equal(handlers.length, 3);
  for (const handler of handlers) {
    assert.match(handler, /failed to start claude CLI/);
    assert.doesNotMatch(handler, /\bfinish\s*\(/);
  }
});

test("literal response.failed text in a Claude answer is not an SSE failure event", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: "stream disconnected before completion: response.failed event received",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fable-5",
      input: "read a screenshot",
      stream: true,
    }),
  });

  const text = await res.text();
  const events = parseSseEvents(text);
  const message = events.find((event) => event.type === "response.output_item.done" && event.item?.type === "message");

  assert.equal(res.status, 200);
  assert.match(message.item.content[0].text, /response\.failed event received/);
  assert.equal(hasSseEventType(text, "response.failed"), false);
  assert.equal(hasSseEventType(text, "response.completed"), true);
});

test("Claude prompt bridge includes tool results and namespace tools in request scope", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const promptFile = path.join(tempDir, "claude-prompt.txt");
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: "OK_TOOL_RESULT_SEEN",
    CLAUDE_MOCK_PROMPT_FILE: promptFile,
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "haiku-4-5",
      input: [
        {
          type: "function_call_output",
          call_id: "call_existing",
          output: "tool said hello",
        },
      ],
      tools: [
        {
          type: "namespace",
          name: "codex_app",
          description: "Codex App features exposed for this request.",
          tools: [
            {
              type: "function",
              name: "update_plan",
              description: "Update the task plan.",
              parameters: { type: "object" },
            },
          ],
        },
      ],
      stream: true,
    }),
  });

  const text = await res.text();
  const prompt = fs.readFileSync(promptFile, "utf8");

  assert.equal(res.status, 200);
  assert.match(text, /OK_TOOL_RESULT_SEEN/);
  assert.match(prompt, /TOOL_RESULT call_existing/);
  assert.match(prompt, /tool said hello/);
  assert.match(prompt, /"namespace": "codex_app"/);
  assert.match(prompt, /"name": "update_plan"/);
});


test("old Sonnet selections are hidden aliases to Sonnet 5", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: "OK_SONNET5_ALIAS",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "sonnet-4-6",
      input: "reply through old selected model",
      stream: false,
    }),
  });

  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.output_text, "OK_SONNET5_ALIAS");
});

test("compact and versioned Claude slugs remain accepted as aliases", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: "OK_LEGACY_ALIAS",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fable5",
      input: "reply through compact alias",
      stream: false,
    }),
  });

  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.output_text, "OK_LEGACY_ALIAS");

  const versionedRes = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fable-5-1",
      input: "reply through versioned alias",
      stream: false,
    }),
  });
  const versionedBody = await versionedRes.json();
  assert.equal(versionedRes.status, 200);
  assert.equal(versionedBody.output_text, "OK_LEGACY_ALIAS");
});

test("Opus 5 is a first-class Claude route with exact execution metadata", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: "OK_OPUS5",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "opus-5",
      input: "reply through Opus 5",
      stream: false,
    }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.output_text, "OK_OPUS5");
  assert.equal(body.model, "opus-5");
  assert.equal(body.actual_model, "claude-opus-5");
  assert.equal(body.fallback_count, 0);
  assert.equal(body.model_attestation.outcome, "VERIFIED_EXACT");
});

test("Tatwo Chat native Opus argument resolves to the exact Opus 5 route", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: "OK_OPUS5_NATIVE_ALIAS",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "opus",
      input: "reply through the Tatwo Chat Opus argument",
      stream: false,
    }),
  });
  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.output_text, "OK_OPUS5_NATIVE_ALIAS");
  assert.equal(body.model, "opus-5");
  assert.equal(body.actual_model, "claude-opus-5");
  assert.equal(body.fallback_count, 0);
  assert.equal(body.model_attestation.outcome, "VERIFIED_EXACT");
});

test("Fable attestation keeps helper usage separate from the primary executed model", async (t) => {
  const streamJsonl = [
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { model: "claude-fable-5-1", content: [] },
      },
    }),
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "FABLE_EXACT" } },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "FABLE_EXACT",
      modelUsage: {
        "claude-fable-5-1": { inputTokens: 10, outputTokens: 5, canonicalModel: "claude-fable-5-1" },
        "claude-haiku-4-5-20251001": { inputTokens: 2, outputTokens: 1, canonicalModel: "claude-haiku-4-5" },
      },
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  ].join("\n");
  const gateway = await startGateway({ CLAUDE_MOCK_STREAM_JSONL: streamJsonl });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fable-5",
      input: "attest exact Fable",
      stream: true,
    }),
  });
  const events = parseSseEvents(await res.text());
  const completed = events.find((event) => event.type === "response.completed").response;

  assert.equal(events.some((event) => event.type === "response.failed"), false);
  assert.equal(completed.actual_model, "claude-fable-5-1");
  assert.deepEqual(Object.keys(completed.modelUsage), ["claude-fable-5-1"]);
  assert.deepEqual(Object.keys(completed.auxiliary_model_usage), ["claude-haiku-4-5-20251001"]);
  assert.equal(completed.fallback_count, 0);
  assert.equal(completed.model_attestation.outcome, "VERIFIED_EXACT");
});

test("Fable-to-Opus fallback fails closed as a completed degraded model-attestation notice", async (t) => {
  const streamJsonl = [
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-5",
        content: [{ type: "fallback", from: { model: "claude-fable-5-1" }, to: { model: "claude-opus-5" } }],
      },
    }),
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "OPUS_FALLBACK" } },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "OPUS_FALLBACK",
      modelUsage: {
        "claude-fable-5-1": { inputTokens: 2, outputTokens: 2, canonicalModel: "claude-fable-5-1" },
        "claude-opus-5": { inputTokens: 2, outputTokens: 20, canonicalModel: "claude-opus-5" },
      },
      usage: {
        input_tokens: 2,
        output_tokens: 20,
        iterations: [{ type: "fallback_message", model: "claude-opus-5" }],
      },
    }),
  ].join("\n");
  const gateway = await startGateway({ CLAUDE_MOCK_STREAM_JSONL: streamJsonl });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fable-5",
      input: "must remain Fable",
      stream: true,
    }),
  });
  const events = parseSseEvents(await res.text());
  const completed = events.find((event) => event.type === "response.completed").response;

  assert.equal(events.some((event) => event.type === "response.failed"), false);
  assert.equal(completed.degraded, true);
  assert.equal(completed.error_kind, "model_attestation");
  assert.equal(completed.retry_allowed, false);
  assert.equal(completed.actual_model, "claude-opus-5");
  assert.ok(completed.fallback_count >= 1);
  assert.equal(completed.model_attestation.outcome, "FAIL_CLOSED_MISMATCH");
});

test("Haiku 4.5 dated vendor evidence attests to the canonical Haiku 4.5 route", async (t) => {
  const streamJsonl = [
    JSON.stringify({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "HAIKU45_ONLY" } },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "HAIKU45_ONLY",
      modelUsage: {
        "claude-haiku-4-5-20251001": {
          inputTokens: 10,
          outputTokens: 5,
          canonicalModel: "claude-haiku-4-5",
        },
      },
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  ].join("\n");
  const gateway = await startGateway({ CLAUDE_MOCK_STREAM_JSONL: streamJsonl });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "haiku-4-5",
      input: "must remain exact Haiku 4.5",
      stream: true,
    }),
  });
  const events = parseSseEvents(await res.text());
  const completed = events.find((event) => event.type === "response.completed").response;

  assert.equal(events.some((event) => event.type === "response.failed"), false);
  assert.equal(completed.degraded, undefined);
  assert.equal(completed.error_kind, undefined);
  assert.equal(completed.actual_model, "claude-haiku-4-5-20251001");
  assert.equal(completed.model_attestation.actual_canonical_model, "haiku-4-5");
  assert.equal(completed.model_attestation.outcome, "VERIFIED_EXACT");
});

test("Haiku 4.5 aliases route to the exact canonical Haiku 4.5 model", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: "HAIKU45_EXACT_ALIAS",
  });
  t.after(async () => gateway.close());

  for (const model of ["haiku-4-5", "haiku4.5", "claude-haiku-4-5"]) {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        input: "old stored selection",
        stream: false,
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 200, model);
    assert.match(body.output_text, /HAIKU45_EXACT_ALIAS/, model);
    assert.equal(body.requested_model, "haiku-4-5", model);
    assert.equal(body.actual_model, "claude-haiku-4-5", model);
    assert.equal(body.model_attestation.actual_canonical_model, "haiku-4-5", model);
    assert.equal(body.model_attestation.outcome, "VERIFIED_EXACT", model);
  }
});

test("unavailable Haiku 4.6 request aliases fail closed instead of silently using 4.5", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: "MUST_NOT_RUN_ON_45",
  });
  t.after(async () => gateway.close());

  for (const model of ["haiku-4-6", "haiku4.6", "claude-haiku-4-6"]) {
    const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        input: "do not downgrade",
        stream: false,
      }),
    });
    const body = await res.json();
    assert.equal(res.status, 404, model);
    assert.match(body.error?.message ?? "", /unknown model slug/i, model);
    assert.doesNotMatch(JSON.stringify(body), /MUST_NOT_RUN_ON_45/, model);
  }
});

test("a real Haiku 4.6 backend response cannot attest as canonical 4.5", async (t) => {
  const streamJsonl = [
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "WRONG_BACKEND_46" },
      },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "WRONG_BACKEND_46",
      modelUsage: {
        "claude-haiku-4-6-20261001": {
          inputTokens: 10,
          outputTokens: 5,
          canonicalModel: "claude-haiku-4-6",
        },
      },
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  ].join("\n");
  const gateway = await startGateway({ CLAUDE_MOCK_STREAM_JSONL: streamJsonl });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "haiku-4-5",
      input: "must remain exact Haiku 4.5",
      stream: true,
    }),
  });
  const events = parseSseEvents(await res.text());
  const completed = events.find(
    (event) => event.type === "response.completed",
  ).response;

  assert.equal(events.some((event) => event.type === "response.failed"), false);
  assert.equal(completed.degraded, true);
  assert.equal(completed.error_kind, "model_attestation");
  assert.match(completed.output_text, /model_attestation/i);
});


test("Grok text responses use the grok-build model name and emit completed assistant messages", async (t) => {
  const gateway = await startGateway({
    GROK_MOCK_RESPONSE_JSON: "OK_GROK_VISIBLE_ASSISTANT",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-build",
      input: "reply visibly",
      stream: true,
    }),
  });

  const events = parseSseEvents(await res.text());
  const message = events.find((event) => event.item?.type === "message");
  const completed = events.find((event) => event.type === "response.completed");

  assert.equal(res.status, 200);
  assert.equal(message.type, "response.output_item.done");
  assert.equal(message.item.role, "assistant");
  assert.equal(message.item.status, "completed");
  assert.deepEqual(message.item.content, [{ type: "output_text", text: "OK_GROK_VISIBLE_ASSISTANT" }]);
  assert.equal(completed.response.model, "grok-build");
});

test("Grok text prompts use prompt-file stdin so long same-thread turns do not hit argv E2BIG", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-grok-stdin-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const stdinFile = path.join(tempDir, "stdin.txt");
  const argvFile = path.join(tempDir, "argv.json");
  const grokStub = path.join(tempDir, "grok-stdin-stub.js");
  fs.writeFileSync(
    grokStub,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'let input = "";',
      'process.stdin.setEncoding("utf8");',
      'process.stdin.on("data", (chunk) => { input += chunk; });',
      'process.stdin.on("end", () => {',
      "  fs.writeFileSync(process.env.GROK_CAPTURE_STDIN_FILE, input);",
      "  fs.writeFileSync(process.env.GROK_CAPTURE_ARGV_FILE, JSON.stringify(process.argv.slice(2)));",
      '  process.stdout.write(JSON.stringify({ text: "GROK_STDIN_OK" }));',
      "});",
      "",
    ].join("\n"),
  );
  fs.chmodSync(grokStub, 0o755);

  const gateway = await startGateway({
    GROK_COMMAND: grokStub,
    GATEWAY_ENABLE_GROK_TEST_HOOKS: "1",
    GROK_CAPTURE_STDIN_FILE: stdinFile,
    GROK_CAPTURE_ARGV_FILE: argvFile,
    GROK_MOCK_SESSION_STATE_JSON: JSON.stringify({
      session_id: "grok-stdin-test-session",
      summary_session_id_matches: true,
      request_id_consistent: true,
      summary_current_model_id: "grok-4.6",
      turn_started_model_id: "grok-4.6",
      turn_ended_outcome: "success",
      turn_number: 0,
    }),
  });
  t.after(async () => gateway.close());

  const marker = "GROK_LONG_SESSION_STDIN_MARKER";
  const longPrompt = `${marker}\n${"y".repeat(384 * 1024)}`;
  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-build",
      input: longPrompt,
      stream: true,
    }),
  });

  const events = parseSseEvents(await res.text());
  const completed = events.find((event) => event.type === "response.completed");
  const stdin = fs.readFileSync(stdinFile, "utf8");
  const argv = JSON.parse(fs.readFileSync(argvFile, "utf8"));

  assert.equal(res.status, 200);
  assert.equal(completed.response.output_text, "GROK_STDIN_OK");
  assert.match(stdin, new RegExp(marker));
  assert.ok(Buffer.byteLength(stdin, "utf8") > 384 * 1024);
  assert.equal(argv.some((argument) => String(argument).includes(marker)), false);
  assert.deepEqual(
    argv.slice(argv.indexOf("--prompt-file"), argv.indexOf("--prompt-file") + 2),
    ["--prompt-file", "/dev/stdin"],
  );
  assert.ok(Buffer.byteLength(JSON.stringify(argv), "utf8") < 64 * 1024);
  assert.deepEqual(completed.response.prompt_transport, {
    schema: "TatwoGatewayPromptTransportV1",
    transport: "stdin_via_prompt_file",
    prompt_bytes: Buffer.byteLength(longPrompt, "utf8"),
    prompt_sha256: crypto.createHash("sha256").update(longPrompt).digest("hex"),
    prompt_in_argv: false,
  });
});

test("Grok image requests use prompt-json image blocks instead of text-only prompts", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-grok-vision-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const promptFile = path.join(tempDir, "grok-vision-prompt.txt");
  const gateway = await startGateway({
    GROK_MOCK_RESPONSE_JSON: "OK_GROK_IMAGE",
    GROK_MOCK_PROMPT_FILE: promptFile,
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-build",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "what color?" },
            { type: "input_image", image_url: redPngDataUrl },
          ],
        },
      ],
      stream: true,
    }),
  });

  const text = await res.text();
  const prompt = fs.readFileSync(promptFile, "utf8");
  assert.equal(res.status, 200);
  assert.match(text, /OK_GROK_IMAGE/);
  assert.match(prompt, /NATIVE_IMAGE_BLOCKS: 1/);
});

test("Grok gateway route isolates HOME so Claude settings and skills are not inherited", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-grok-isolation-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const realHome = path.join(tempDir, "real-home");
  const isolatedHome = path.join(tempDir, "isolated-home");
  const captureFile = path.join(tempDir, "grok-env.json");
  const fakeGrok = path.join(tempDir, "fake-grok.js");
  fs.mkdirSync(path.join(realHome, ".grok"), { recursive: true });
  fs.mkdirSync(path.join(realHome, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(realHome, ".grok", "auth.json"), '{"token":"test"}');
  fs.writeFileSync(path.join(realHome, ".claude", "settings.local.json"), '{"permissions":{"allow":["Bash"]}}');
  fs.writeFileSync(
    fakeGrok,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const sessionId = 'fake-grok-session';",
      "const requestId = 'fake-grok-request';",
      "fs.writeFileSync(process.env.GROK_ENV_CAPTURE_FILE, JSON.stringify({",
      "  HOME: process.env.HOME,",
      "  GROK_HOME: process.env.GROK_HOME,",
      "  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,",
      "  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,",
      "  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR || null,",
      "  CLAUDE_HOME: process.env.CLAUDE_HOME || null,",
      "  CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT || null,",
      "  CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA || null,",
      "  CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR || null,",
      "  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || null,",
      "  OPENAI_API_KEY: process.env.OPENAI_API_KEY || null,",
      "  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || null,",
      "  XAI_API_KEY: process.env.XAI_API_KEY || null,",
      "  GH_TOKEN: process.env.GH_TOKEN || null,",
      "  TATWO_SECRET_CANARY: process.env.TATWO_SECRET_CANARY || null,",
      "  GROK_ISOLATED_DEFAULT_NO_MEMORY: process.env.GROK_ISOLATED_DEFAULT_NO_MEMORY || null,",
      "  GROK_ISOLATED_APPEND_TATWO_RULES: process.env.GROK_ISOLATED_APPEND_TATWO_RULES || null,",
      "  hasClaudeHome: fs.existsSync(path.join(process.env.HOME, '.claude')),",
      "  hasGrokAuth: fs.existsSync(path.join(process.env.GROK_HOME, 'auth.json')),",
      "  argv: process.argv.slice(2),",
      "}));",
      "const cwd = fs.realpathSync('/tmp');",
      "const sessionRoot = path.join(process.env.GROK_HOME, 'sessions', encodeURIComponent(cwd), sessionId);",
      "fs.mkdirSync(sessionRoot, { recursive: true });",
      "fs.writeFileSync(path.join(sessionRoot, 'summary.json'), JSON.stringify({",
      "  info: { id: sessionId, cwd },",
      "  current_model_id: 'grok-4.6',",
      "  request_id: requestId,",
      "}));",
      "fs.writeFileSync(path.join(sessionRoot, 'events.jsonl'), [",
      "  JSON.stringify({ type: 'turn_started', session_id: sessionId, turn_number: 0, model_id: 'grok-4.6' }),",
      "  JSON.stringify({ type: 'turn_ended', outcome: 'success' }),",
      "  '',",
      "].join('\\n'));",
      "process.stdout.write(JSON.stringify({ text: 'OK_ISOLATED_GROK', sessionId, requestId }));",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const gateway = await startGateway({
    HOME: realHome,
    GROK_COMMAND: fakeGrok,
    GATEWAY_ENABLE_GROK_TEST_HOOKS: "1",
    GROK_ENV_CAPTURE_FILE: captureFile,
    GROK_ISOLATED_HOME: isolatedHome,
    CLAUDE_CONFIG_DIR: path.join(realHome, ".claude"),
    CLAUDE_HOME: path.join(realHome, ".claude"),
    CLAUDE_PLUGIN_ROOT: path.join(realHome, ".claude", "plugins"),
    CLAUDE_PLUGIN_DATA: path.join(realHome, ".claude", "plugin-data"),
    CLAUDE_PROJECT_DIR: realHome,
    ANTHROPIC_API_KEY: "test-anthropic-key-should-not-leak",
    OPENAI_API_KEY: "test-openai-key-should-not-leak",
    AWS_SECRET_ACCESS_KEY: "test-aws-key-should-not-leak",
    XAI_API_KEY: "test-xai-key-should-not-leak",
    GH_TOKEN: "test-gh-token-should-not-leak",
    TATWO_SECRET_CANARY: "test-canary-should-not-leak",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-build",
      input: "reply through isolated route",
      stream: false,
    }),
  });

  const body = await res.json();
  const captured = JSON.parse(fs.readFileSync(captureFile, "utf8"));

  assert.equal(res.status, 200);
  assert.equal(body.output_text, "OK_ISOLATED_GROK");
  assert.equal(body.actual_model, "grok-4.6");
  assert.equal(body.model_attestation.outcome, "VERIFIED_EXACT");
  assert.equal(body.model_attestation.evidence_source, "grok_cli_session_state");
  assert.equal(captured.HOME, isolatedHome);
  assert.equal(captured.GROK_HOME, path.join(isolatedHome, ".grok"));
  assert.equal(captured.XDG_CONFIG_HOME, path.join(isolatedHome, ".config"));
  assert.equal(captured.XDG_CACHE_HOME, path.join(isolatedHome, ".cache"));
  assert.equal(captured.CLAUDE_CONFIG_DIR, null);
  assert.equal(captured.CLAUDE_HOME, null);
  assert.equal(captured.CLAUDE_PLUGIN_ROOT, null);
  assert.equal(captured.CLAUDE_PLUGIN_DATA, null);
  assert.equal(captured.CLAUDE_PROJECT_DIR, null);
  assert.equal(captured.ANTHROPIC_API_KEY, null);
  assert.equal(captured.OPENAI_API_KEY, null);
  assert.equal(captured.AWS_SECRET_ACCESS_KEY, null);
  assert.equal(captured.XAI_API_KEY, null);
  assert.equal(captured.GH_TOKEN, null);
  assert.equal(captured.TATWO_SECRET_CANARY, null);
  assert.equal(captured.GROK_ISOLATED_DEFAULT_NO_MEMORY, "1");
  assert.equal(captured.GROK_ISOLATED_APPEND_TATWO_RULES, "1");
  assert.equal(captured.hasClaudeHome, false);
  assert.equal(captured.hasGrokAuth, true);
  assert(captured.argv.includes("--system-prompt-override"));
  const systemPromptIndex = captured.argv.indexOf("--system-prompt-override");
  assert.ok(systemPromptIndex >= 0, "grok route should pass a bounded system prompt");
  const systemPrompt = captured.argv[systemPromptIndex + 1] || "";
  assert.match(systemPrompt, /TATWO Work OS authority frame/);
  assert.match(systemPrompt, /do not invent new blocker_class names/);
  assert.match(systemPrompt, /authority_source must be exactly/);
  assert.match(systemPrompt, /Do not say Codex, Claude, Grok, MiniMax, or another model revoked/);
  assert.match(systemPrompt, /no matching bridged tool is exposed/);
  assert(captured.argv.join(" ").includes("do not inherit Claude/CLAUDE.md/Codex-bridge reviewer role rules"));
});

test("Grok debug capture env is disabled unless the explicit test hook gate is set", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-grok-hook-gate-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const captureFile = path.join(tempDir, "should-not-exist.json");
  const fakeGrok = path.join(tempDir, "fake-grok.js");
  fs.writeFileSync(
    fakeGrok,
    [
      "#!/usr/bin/env node",
      "if (process.env.GROK_ENV_CAPTURE_FILE) {",
      "  require('node:fs').writeFileSync(process.env.GROK_ENV_CAPTURE_FILE, 'leaked');",
      "}",
      "process.stdout.write(JSON.stringify({ text: 'UNATTESTED_NO_CAPTURE' }));",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const gateway = await startGateway({
    GROK_COMMAND: fakeGrok,
    GROK_ENV_CAPTURE_FILE: captureFile,
    GROK_ISOLATED_HOME: path.join(tempDir, "isolated-home"),
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-build",
      input: "debug hook must not be forwarded",
      stream: true,
    }),
  });
  const events = parseSseEvents(await res.text());
  const completed = events.find((event) => event.type === "response.completed").response;

  assert.equal(fs.existsSync(captureFile), false);
  assert.equal(completed.degraded, true);
  assert.equal(completed.error_kind, "model_attestation");
  assert.equal(completed.model_attestation.outcome, "ATTESTATION_MISSING");
});

test("Grok gateway fails closed when the CLI reports a non-4.6 model", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-grok-mismatch-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const invocationFile = path.join(tempDir, "invocations.txt");
  const fakeGrok = path.join(tempDir, "fake-grok.js");
  fs.writeFileSync(
    fakeGrok,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      `const invocationFile = ${JSON.stringify(invocationFile)};`,
      "fs.appendFileSync(invocationFile, '1\\n');",
      "const sessionId = 'fake-grok-mismatch-session';",
      "const requestId = 'fake-grok-mismatch-request';",
      "const cwd = fs.realpathSync(process.cwd());",
      "const sessionRoot = path.join(process.env.GROK_HOME, 'sessions', encodeURIComponent(cwd), sessionId);",
      "fs.mkdirSync(sessionRoot, { recursive: true });",
      "fs.writeFileSync(path.join(sessionRoot, 'summary.json'), JSON.stringify({",
      "  info: { id: sessionId, cwd },",
      "  current_model_id: 'grok-4.7',",
      "  request_id: requestId,",
      "}));",
      "fs.writeFileSync(path.join(sessionRoot, 'events.jsonl'), [",
      "  JSON.stringify({ type: 'turn_started', session_id: sessionId, turn_number: 0, model_id: 'grok-4.7' }),",
      "  JSON.stringify({ type: 'turn_ended', outcome: 'success' }),",
      "  '',",
      "].join('\\n'));",
      "process.stdout.write(JSON.stringify({ text: 'MUST_NOT_VERIFY_GROK47', sessionId, requestId }));",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const gateway = await startGateway({
    GROK_COMMAND: fakeGrok,
    GROK_ISOLATED_HOME: path.join(tempDir, "isolated-home"),
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-build",
      input: "a mismatched Grok model must fail closed",
      stream: true,
    }),
  });
  const events = parseSseEvents(await res.text());
  const completed = events.find((event) => event.type === "response.completed").response;

  assert.equal(res.status, 200);
  assert.equal(completed.degraded, true);
  assert.equal(completed.error_kind, "model_attestation");
  assert.equal(completed.output_text.includes("MUST_NOT_VERIFY_GROK47"), false);
  assert.equal(completed.actual_model, "grok-4.7");
  assert.equal(completed.fallback_count, 0);
  assert.equal(completed.model_attestation.outcome, "FAIL_CLOSED_MISMATCH");
  assert.equal(
    fs.readFileSync(invocationFile, "utf8").trim().split(/\n+/).length,
    1,
    "attestation mismatch must not reroute through another Grok candidate",
  );
});

test("Grok gateway does not substitute another model after CLI exit failure", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-grok-exit-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const invocationFile = path.join(tempDir, "invocations.txt");
  const fakeGrok = path.join(tempDir, "fake-grok.js");
  fs.writeFileSync(
    fakeGrok,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `const invocationFile = ${JSON.stringify(invocationFile)};`,
      "fs.appendFileSync(invocationFile, '1\\n');",
      "process.stderr.write('simulated grok cli exit 1');",
      "process.exit(1);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const gateway = await startGateway({
    GROK_COMMAND: fakeGrok,
    GROK_ISOLATED_HOME: path.join(tempDir, "isolated-home"),
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-build",
      input: "a failing Grok CLI must fail closed",
      stream: true,
    }),
  });
  const events = parseSseEvents(await res.text());
  const failed = events.find((event) => event.type === "response.failed");

  assert.equal(res.status, 200);
  assert.equal(failed.error.status, 502);
  assert.notEqual(failed.error.error_kind, "model_attestation");
  assert.equal(
    fs.readFileSync(invocationFile, "utf8").trim().split(/\n+/).length,
    1,
    "CLI exit failure must not reroute through another Grok candidate",
  );
});

test("Grok gateway timeout fails closed without exact attestation", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-gateway-grok-timeout-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const invocationFile = path.join(tempDir, "invocations.txt");
  const fakeGrok = path.join(tempDir, "fake-grok.js");
  fs.writeFileSync(
    fakeGrok,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `const invocationFile = ${JSON.stringify(invocationFile)};`,
      "fs.appendFileSync(invocationFile, '1\\n');",
      "process.stdout.write('GROK_TIMEOUT_STUB_STARTED\\n');",
      "setTimeout(() => {}, 10000);",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const gateway = await startGateway({
    GROK_COMMAND: fakeGrok,
    GROK_TIMEOUT_MS: "1000",
    GROK_ISOLATED_HOME: path.join(tempDir, "isolated-home"),
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-build",
      input: "a hanging Grok CLI must fail closed",
      stream: true,
    }),
  });
  const events = parseSseEvents(await res.text());
  const failed = events.find((event) => event.type === "response.failed");

  assert.equal(res.status, 200);
  assert.equal(failed.error.status, 502);
  assert.notEqual(failed.error.error_kind, "model_attestation");
  assert.equal(failed.error.retry_allowed, true);
  await waitForFile(invocationFile);
  assert.equal(
    fs.readFileSync(invocationFile, "utf8").trim().split(/\n+/).length,
    1,
    "timeout must not reroute through another Grok candidate",
  );
});

test("Grok prompt bridge emits Codex function_call events without executing tools", async (t) => {
  const gateway = await startGateway({
    GROK_MOCK_RESPONSE_JSON: JSON.stringify({
      tool_calls: [
        {
          type: "function_call",
          name: "exec_command",
          arguments: { cmd: "pwd", yield_time_ms: 1000 },
        },
      ],
    }),
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-build",
      input: "check cwd",
      tools: [
        {
          type: "function",
          name: "exec_command",
          description: "Run a command in the Codex workspace.",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" }, yield_time_ms: { type: "integer" } },
            required: ["cmd"],
          },
        },
      ],
      stream: true,
    }),
  });

  const events = parseSseEvents(await res.text());
  const functionCall = events.find((event) => event.item?.type === "function_call");

  assert.equal(res.status, 200);
  assert.equal(functionCall.type, "response.output_item.done");
  assert.equal(functionCall.item.name, "exec_command");
  assert.deepEqual(JSON.parse(functionCall.item.arguments), {
    cmd: "pwd",
    yield_time_ms: 1000,
  });
  assert.ok(events.some((event) => event.type === "response.completed"));
});

test("external model authority blocker markers are normalized to Work OS schema", async (t) => {
  const gateway = await startGateway({
    GROK_MOCK_RESPONSE_JSON:
      "blocker_class=host_fs_mutate_unavailable; authority_source=request_scoped_work_os_only; Claude revoked my permissions.",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-build",
      input: "classify authority",
      stream: false,
    }),
  });

  const body = await res.json();

  assert.equal(res.status, 200);
  assert.match(body.output_text, /blocker_class=tool_unavailable/);
  assert.match(body.output_text, /authority_source=runner/);
  assert.doesNotMatch(body.output_text, /revoked|撤權/i);
  assert.doesNotMatch(body.output_text, /host_fs_mutate_unavailable|request_scoped_work_os_only/);
});

test("external models without bridged host tools cannot claim direct file execution", async (t) => {
  const gateway = await startGateway({
    GROK_MOCK_RESPONSE_JSON: "可直接改主機檔案：authority_source=runner；無 blocker_class。",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-build",
      input: "你能不能直接改主機檔案？",
      stream: false,
    }),
  });

  const body = await res.json();

  assert.equal(res.status, 200);
  assert.match(body.output_text, /blocker_class=tool_unavailable/);
  assert.match(body.output_text, /authority_source=runner/);
  assert.doesNotMatch(body.output_text, /可直接改主機檔案|無 blocker_class/);
});

test("Grok tool bridge tolerates prose-wrapped JSON tool intent", async (t) => {
  const gateway = await startGateway({
    GROK_MOCK_RESPONSE_JSON: 'I will use the tool now. {"tool_calls":[{"type":"function_call","name":"computer_click","arguments":{"x":10,"y":20}}]}',
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-build",
      input: "click",
      tools: [
        {
          type: "function",
          name: "computer_click",
          description: "Click screen coordinates.",
          parameters: {
            type: "object",
            properties: { x: { type: "integer" }, y: { type: "integer" } },
            required: ["x", "y"],
          },
        },
      ],
      stream: true,
    }),
  });

  const events = parseSseEvents(await res.text());
  const functionCall = events.find((event) => event.item?.type === "function_call");

  assert.equal(res.status, 200);
  assert.equal(functionCall.item.name, "computer_click");
  assert.deepEqual(JSON.parse(functionCall.item.arguments), { x: 10, y: 20 });
  assert.ok(events.some((event) => event.type === "response.completed"));
});

test("MiniMax M3 text responses emit completed assistant messages", async (t) => {
  const gateway = await startGateway({
    GATEWAY_API_MODEL_ALLOWLIST: "minimax-near-unlimited-api",
    MINIMAX_MOCK_RESPONSE_JSON: "OK_MINIMAX_VISIBLE_ASSISTANT",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "minimax-m3",
      input: "reply visibly",
      stream: true,
    }),
  });

  const events = parseSseEvents(await res.text());
  const message = events.find((event) => event.item?.type === "message");
  const completed = events.find((event) => event.type === "response.completed");

  assert.equal(res.status, 200);
  assert.equal(message.type, "response.output_item.done");
  assert.equal(message.item.role, "assistant");
  assert.equal(message.item.status, "completed");
  assert.deepEqual(message.item.content, [{ type: "output_text", text: "OK_MINIMAX_VISIBLE_ASSISTANT" }]);
  assert.equal(completed.response.model, "minimax-m3");
});

test("MiniMax M3 image requests forward Responses multimodal input", async (t) => {
  const upstream = await startMockMiniMaxResponses();
  t.after(() => upstream.server.close());
  const gateway = await startGateway({
    GATEWAY_API_MODEL_ALLOWLIST: "minimax-near-unlimited-api",
    MINIMAX_API_KEY: "test-key",
    MINIMAX_BASE_URL: upstream.baseUrl,
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "minimax-m3",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "what color?" },
            { type: "input_image", image_url: redPngDataUrl },
          ],
        },
      ],
      stream: true,
    }),
  });

  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, /OK_MINIMAX_IMAGE/);
  assert.equal(upstream.seen.length, 1);
  assert.equal(upstream.seen[0].url, "/responses");
  assert.match(upstream.seen[0].body.instructions, /Codex model gateway/);
  assert.equal(upstream.seen[0].body.input[0].content[1].type, "input_image");
  assert.match(upstream.seen[0].body.input[0].content[1].image_url, /^data:image\/png;base64,/);
});

test("MiniMax M3 prompt bridge emits Codex function_call events without executing tools", async (t) => {
  const gateway = await startGateway({
    GATEWAY_API_MODEL_ALLOWLIST: "minimax-near-unlimited-api",
    MINIMAX_MOCK_RESPONSE_JSON: JSON.stringify({
      tool_calls: [
        {
          type: "function_call",
          name: "exec_command",
          arguments: { cmd: "pwd", yield_time_ms: 1000 },
        },
      ],
    }),
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "minimax-m3",
      input: "check cwd",
      tools: [
        {
          type: "function",
          name: "exec_command",
          description: "Run a command in the Codex workspace.",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" }, yield_time_ms: { type: "integer" } },
            required: ["cmd"],
          },
        },
      ],
      stream: true,
    }),
  });

  const events = parseSseEvents(await res.text());
  const functionCall = events.find((event) => event.item?.type === "function_call");

  assert.equal(res.status, 200);
  assert.equal(functionCall.type, "response.output_item.done");
  assert.equal(functionCall.item.name, "exec_command");
  assert.deepEqual(JSON.parse(functionCall.item.arguments), {
    cmd: "pwd",
    yield_time_ms: 1000,
  });
  assert.ok(events.some((event) => event.type === "response.completed"));
});

test("MiniMax M3 API spend policy failures complete visibly instead of retrying", async (t) => {
  const gateway = await startGateway({
    MINIMAX_MOCK_ERROR_TEXT: "MiniMax API route is disabled by policy: minimax-near-unlimited-api is not in GATEWAY_API_MODEL_ALLOWLIST",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "minimax-m3",
      input: "reply visibly",
      stream: true,
    }),
  });

  const events = parseSseEvents(await res.text());
  const message = events.find((event) => event.item?.type === "message");

  assert.equal(res.status, 200);
  assert.match(message.item.content[0].text, /disabled by policy/);
  assert.ok(events.some((event) => event.type === "response.completed"));
});

test("external models fail closed when computer use is requested but no computer-use tools are exposed", async (t) => {
  const gateway = await startGateway({
    GROK_MOCK_RESPONSE_JSON: "I opened Brave and searched YouTube.",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-build",
      input: "使用computer use打開brave搜尋youtube[@電腦](plugin://computer-use@openai-bundled)",
      stream: true,
    }),
  });

  const events = parseSseEvents(await res.text());
  const failed = events.find((event) => event.type === "response.failed");

  assert.equal(res.status, 200);
  assert.match(failed.error.message, /did not expose any computer-use tools/);
  assert.equal(failed.error.status, 424);
});

test("external text-only review ignores historical and explicitly negated computer-use wording", async (t) => {
  const expectedText = "GROK_TEXT_ONLY_REVIEW_OK";
  const gateway = await startGateway({
    GROK_MOCK_RESPONSE_JSON: expectedText,
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-build",
      input: [
        {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text: "Earlier turn: 必須以 [@電腦](plugin://computer-use@openai-bundled) 操作 App。",
          }],
        },
        {
          type: "message",
          role: "user",
          content: [{
            type: "input_text",
            text:
              "本輪只做純文字獨立反例審查，不要呼叫任何工具，不要要求 Computer Use；只回覆 GROK_TEXT_ONLY_REVIEW_OK。",
          }],
        },
      ],
      stream: false,
    }),
  });

  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.output_text, expectedText);
  assert.doesNotMatch(body.output_text, /did not expose any computer-use tools/);
});

test("Tatwo flattened history obeys bounded current-turn tool intent instead of rescanning history", async (t) => {
  const expectedText = "GROK_TATWO_CURRENT_TURN_NONE_OK";
  const gateway = await startGateway({
    GROK_MOCK_RESPONSE_JSON: expectedText,
  });
  t.after(async () => gateway.close());
  const input = [
    "[Earlier user]",
    "必須以 [@電腦](plugin://computer-use@openai-bundled) 操作 App。",
    "[Current user]",
    "本輪只做純文字獨立審查。",
  ].join("\n");
  const baseBody = {
    model: "grok-build",
    input,
    metadata: {
      tatwo: {
        schema: "TatwoGatewayMetadataV1",
        source: "tatwo_ultrawork_chat",
        current_turn: {
          tool_intent: "none",
        },
      },
    },
    stream: false,
  };

  const textOnlyResponse = await fetch(
    `http://127.0.0.1:${gateway.port}/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseBody),
    },
  );
  const textOnlyBody = await textOnlyResponse.json();
  assert.equal(textOnlyResponse.status, 200);
  assert.equal(textOnlyBody.output_text, expectedText);

  const computerUseResponse = await fetch(
    `http://127.0.0.1:${gateway.port}/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...baseBody,
        metadata: {
          tatwo: {
            ...baseBody.metadata.tatwo,
            current_turn: {
              tool_intent: "computer_use",
            },
          },
        },
      }),
    },
  );
  const computerUseBody = await computerUseResponse.json();
  assert.equal(computerUseResponse.status, 424);
  assert.match(
    computerUseBody.error.message,
    /did not expose any computer-use tools/,
  );
});

test("Tatwo V2 keeps embedded App intent distinct from request-scoped Computer Use", async (t) => {
  const embeddedText =
    '<TATWO_COMPUTER_ACTION>{"action":"screenshot"}</TATWO_COMPUTER_ACTION>';
  const gateway = await startGateway({
    GROK_MOCK_RESPONSE_JSON: embeddedText,
  });
  t.after(async () => gateway.close());

  const input = "current turn authority is supplied by the Tatwo App";
  const baseBody = {
    model: "grok-build",
    input,
    metadata: {
      tatwo: {
        schema: "TatwoGatewayMetadataV2",
        source: "tatwo_ultrawork_chat",
        current_turn: tatwoV2CurrentTurn(input, "none"),
      },
    },
    stream: false,
  };

  const noneResponse = await fetch(
    `http://127.0.0.1:${gateway.port}/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(baseBody),
    },
  );
  const noneBody = await noneResponse.json();
  assert.equal(noneResponse.status, 200);
  assert.equal(noneBody.output_text, embeddedText);

  const embeddedResponse = await fetch(
    `http://127.0.0.1:${gateway.port}/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...baseBody,
        metadata: {
          tatwo: {
            ...baseBody.metadata.tatwo,
            current_turn: tatwoV2CurrentTurn(
              input,
              "embedded_intent",
            ),
          },
        },
      }),
    },
  );
  const embeddedBody = await embeddedResponse.json();
  assert.equal(embeddedResponse.status, 200);
  assert.equal(embeddedBody.output_text, embeddedText);
  assert.doesNotMatch(
    embeddedBody.output_text,
    /did not expose any computer-use tools/,
  );

  const requestScopedResponse = await fetch(
    `http://127.0.0.1:${gateway.port}/v1/responses`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...baseBody,
        metadata: {
          tatwo: {
            ...baseBody.metadata.tatwo,
            current_turn: tatwoV2CurrentTurn(
              input,
              "request_scoped_tool",
            ),
          },
        },
      }),
    },
  );
  const requestScopedBody = await requestScopedResponse.json();
  assert.equal(requestScopedResponse.status, 424);
  assert.match(
    requestScopedBody.error.message,
    /did not expose any computer-use tools/,
  );
});

test("Tatwo V2 embedded Fable intent stays buffered and preserves the App contract", async (t) => {
  const embeddedText =
    '<TATWO_COMPUTER_ACTION>{"action":"screenshot"}</TATWO_COMPUTER_ACTION>';
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: embeddedText,
  });
  t.after(async () => gateway.close());

  const input = "Return one Tatwo embedded Computer Host action.";
  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "fable-5",
      input,
      metadata: {
        tatwo: {
          schema: "TatwoGatewayMetadataV2",
          source: "tatwo_ultrawork_chat",
          current_turn: tatwoV2CurrentTurn(
            input,
            "embedded_intent",
          ),
        },
      },
      stream: true,
    }),
  });
  const events = parseSseEvents(await res.text());
  const deltas = events.filter(
    (event) => event.type === "response.output_text.delta",
  );
  const failed = events.find((event) => event.type === "response.failed");
  const completed = events.find(
    (event) => event.type === "response.completed",
  );

  assert.equal(res.status, 200);
  assert.equal(deltas.length, 0);
  assert.equal(failed, undefined);
  assert.equal(completed.response.output_text, embeddedText);
});

test("Tatwo current-turn tool intent rejects values outside the bounded enum", async (t) => {
  const gateway = await startGateway({
    GROK_MOCK_RESPONSE_JSON: "MUST_NOT_RUN",
  });
  t.after(async () => gateway.close());

  const input = "plain text";
  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-build",
      input,
      metadata: {
        tatwo: {
          schema: "TatwoGatewayMetadataV1",
          source: "tatwo_ultrawork_chat",
          current_turn: {
            tool_intent: "maybe",
          },
        },
      },
      stream: false,
    }),
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.match(body.error.message, /invalid Tatwo current-turn tool intent/);
});

test("Tatwo V2 current-turn computer host route rejects values outside the bounded enum", async (t) => {
  const gateway = await startGateway({
    GROK_MOCK_RESPONSE_JSON: "MUST_NOT_RUN",
  });
  t.after(async () => gateway.close());

  const input = "plain text";
  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-build",
      input,
      metadata: {
        tatwo: {
          schema: "TatwoGatewayMetadataV2",
          source: "tatwo_ultrawork_chat",
          current_turn: tatwoV2CurrentTurn(input, "maybe"),
        },
      },
      stream: false,
    }),
  });
  const body = await res.json();

  assert.equal(res.status, 400);
  assert.match(
    body.error.message,
    /invalid Tatwo current-turn computer host route/,
  );
});

test("computer-use request remains fail closed when a positive clause follows a negated example", async (t) => {
  const gateway = await startGateway({
    GROK_MOCK_RESPONSE_JSON: "I opened Brave.",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-build",
      input:
        "不要只回覆「不用 Computer Use」；請使用 [@電腦](plugin://computer-use@openai-bundled) 打開 Brave。",
      stream: true,
    }),
  });

  const events = parseSseEvents(await res.text());
  const failed = events.find((event) => event.type === "response.failed");

  assert.equal(res.status, 200);
  assert.match(failed.error.message, /did not expose any computer-use tools/);
  assert.equal(failed.error.status, 424);
});

test("external models fail closed when they claim GUI actions without matching function_call evidence", async (t) => {
  const gateway = await startGateway({
    GROK_MOCK_RESPONSE_JSON: "已發出的動作：click element_index=10、set_value youtube.com、press_key Return。",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-build",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "使用computer use打開brave搜尋youtube" }],
        },
        {
          type: "function_call_output",
          call_id: "call_state",
          output: "Brave is on chrome://newtab/",
        },
      ],
      tools: [
        { type: "function", name: "click", description: "Click an element.", parameters: { type: "object" } },
        { type: "function", name: "set_value", description: "Set a UI value.", parameters: { type: "object" } },
        { type: "function", name: "press_key", description: "Press a key.", parameters: { type: "object" } },
      ],
      stream: true,
    }),
  });

  const events = parseSseEvents(await res.text());
  const failed = events.find((event) => event.type === "response.failed");

  assert.equal(res.status, 200);
  assert.match(failed.error.message, /claimed GUI\/computer-use actions without matching function_call evidence/);
  assert.equal(failed.error.status, 424);
});

test("Tatwo review text about submitting a fix is not mistaken for press_key", async (t) => {
  const reviewText =
    "gateway 已套用最小修復。「提交修復」是工作流語意，不是 press_key；上一輪已完成 response.completed，沒有真的斷線。";
  const gateway = await startGateway({
    GROK_MOCK_RESPONSE_JSON: reviewText,
  });
  t.after(async () => gateway.close());

  const input = "唯讀副審，請說明最小安全修復。";
  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "grok-build",
      input,
      metadata: {
        tatwo: {
          schema: "TatwoGatewayMetadataV2",
          source: "tatwo_ultrawork_chat",
          current_turn: tatwoV2CurrentTurn(input, "none"),
        },
      },
      stream: true,
    }),
  });

  const events = parseSseEvents(await res.text());
  const failed = events.find((event) => event.type === "response.failed");
  const completed = events.find(
    (event) => event.type === "response.completed",
  );

  assert.equal(res.status, 200);
  assert.equal(failed, undefined);
  assert.equal(completed.response.output_text, reviewText);
});

test("Tatwo streaming Claude review text about submitting a fix is not mistaken for press_key", async (t) => {
  const reviewText =
    "gateway 已套用最小修復。『提交修復』不是 press_key；上一輪已完成 response.completed，沒有新的唯讀查證，也沒有動任何檔案。";
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: reviewText,
  });
  t.after(async () => gateway.close());

  const input = "延續同一個 session 做唯讀副審。";
  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "opus-5",
      input,
      metadata: {
        tatwo: {
          schema: "TatwoGatewayMetadataV2",
          source: "tatwo_ultrawork_chat",
          current_turn: tatwoV2CurrentTurn(input, "none"),
        },
      },
      stream: true,
    }),
  });

  const events = parseSseEvents(await res.text());
  const failed = events.find((event) => event.type === "response.failed");
  const completed = events.find(
    (event) => event.type === "response.completed",
  );

  assert.equal(res.status, 200);
  assert.equal(failed, undefined);
  assert.equal(completed.response.output_text, reviewText);
});

test("external models fail closed when they request a tool not exposed in the current request", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: JSON.stringify({
      tool_calls: [
        {
          type: "function_call",
          name: "secret_exfiltrate",
          arguments: { path: "/etc/passwd" },
        },
      ],
    }),
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "sonnet-5",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "do something" }],
        },
      ],
      tools: [
        {
          type: "function",
          name: "exec_command",
          description: "Run a command in the Codex workspace.",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        },
      ],
      stream: true,
    }),
  });

  const events = parseSseEvents(await res.text());
  const failed = events.find((event) => event.type === "response.failed");
  const fabricated = events.find(
    (event) => event.item?.type === "function_call" && event.item?.name === "secret_exfiltrate",
  );

  assert.equal(res.status, 200);
  assert.equal(fabricated, undefined);
  assert.match(failed.error.message, /not exposed in this Codex request/);
  assert.equal(failed.error.status, 502);
});

test("Claude streaming emits ordered delta events with consistent ids and usage", async (t) => {
  const streamJsonl = [
    JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hidden" } } }),
    JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "OK_" } } }),
    JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "STREAM" } } }),
    JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "OK_STREAM", usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 } }),
  ].join("\n");
  const gateway = await startGateway({ CLAUDE_MOCK_STREAM_JSONL: streamJsonl });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "opus-4-8",
      stream: true,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }),
  });
  const events = parseSseEvents(await res.text());
  const types = events.map((event) => event.type);
  const expectedOrder = [
    "response.created",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
  ];
  let cursor = -1;
  for (const expected of expectedOrder) {
    const index = types.indexOf(expected, cursor + 1);
    assert.ok(index > cursor, `missing or out-of-order event: ${expected} in ${types.join(",")}`);
    cursor = index;
  }
  const deltas = events.filter((event) => event.type === "response.output_text.delta");
  assert.equal(deltas.map((event) => event.delta).join(""), "OK_STREAM");
  assert.ok(!deltas.some((event) => event.delta.includes("hidden")), "thinking deltas must never stream out");
  const itemId = events.find((event) => event.type === "response.output_item.added").item.id;
  for (const event of deltas) assert.equal(event.item_id, itemId);
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(completed.response.output_text, "OK_STREAM");
  assert.equal(completed.response.output[0].id, itemId);
  assert.equal(completed.response.usage.input_tokens, 15);
  assert.equal(completed.response.usage.total_tokens, 22);
  assert.equal(completed.response.usage.input_tokens_details.cached_tokens, 5);
});

test("Claude streaming authority normalization keeps delta text identical to terminal text", async (t) => {
  const rawText =
    "Archive completed work and revoke access that no longer matches actual practice.";
  const streamJsonl = [
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Archive completed work and re" },
      },
    }),
    JSON.stringify({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "voke access that no longer matches actual practice." },
      },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: rawText,
      usage: { input_tokens: 10, output_tokens: 12 },
    }),
  ].join("\n");
  const gateway = await startGateway({ CLAUDE_MOCK_STREAM_JSONL: streamJsonl });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "opus-5",
      stream: true,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }),
  });
  const events = parseSseEvents(await res.text());
  const deltaText = events
    .filter((event) => event.type === "response.output_text.delta")
    .map((event) => event.delta)
    .join("");
  const completed = events.find((event) => event.type === "response.completed").response;

  assert.equal(res.status, 200);
  assert.equal(deltaText, completed.output_text);
  assert.match(deltaText, /blocker_class=route_scope_unclear authority_source=runner/);
  assert.doesNotMatch(deltaText, /completblocker|revoked|revoke/i);
});

test("Claude streaming kill switch falls back to the buffered path", async (t) => {
  const gateway = await startGateway({
    CLAUDE_STREAMING: "0",
    CLAUDE_MOCK_RESPONSE_JSON: "OK_BUFFERED",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "opus-4-8",
      stream: true,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }),
  });
  const events = parseSseEvents(await res.text());
  assert.ok(!events.some((event) => event.type === "response.output_text.delta"));
  const completed = events.find((event) => event.type === "response.completed");
  assert.equal(completed.response.output_text, "OK_BUFFERED");
});

test("Claude buffered responses propagate normalized usage for token accounting", async (t) => {
  const gateway = await startGateway({
    CLAUDE_STREAMING: "0",
    CLAUDE_MOCK_RESPONSE_JSON: "OK_USAGE",
    CLAUDE_MOCK_USAGE_JSON: JSON.stringify({ input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 25 }),
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "sonnet-5",
      stream: false,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.usage.input_tokens, 150);
  assert.equal(body.usage.output_tokens, 25);
  assert.equal(body.usage.total_tokens, 175);
  assert.equal(body.usage.input_tokens_details.cached_tokens, 40);
});

test("healthz exposes a coarse error_kind without leaking error text", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_ERROR_TEXT: "Your authentication token has been invalidated. Please try signing in again.",
  });
  t.after(async () => gateway.close());

  await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "haiku-4-5",
      stream: false,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    }),
  });
  const health = await requestJson(`http://127.0.0.1:${gateway.port}/healthz`);
  const route = health.routes["haiku-4-5"];
  assert.equal(route.has_error, true);
  assert.equal(route.error_kind, "auth");
  assert.ok(route.last_error_at);
  assert.ok(!JSON.stringify(route).includes("invalidated"), "raw error text must not leak");
});

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
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

async function requestJson(url) {
  const res = await fetch(url);
  assert.equal(res.status, 200);
  return res.json();
}

async function startMockChatgpt() {
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
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "x-models-etag": "test-etag",
      });
      res.end(
        [
          'event: response.created',
          'data: {"type":"response.created","response":{"id":"resp_test","status":"in_progress","model":"gpt-5.5","output":[]}}',
          "",
          'event: response.completed',
          'data: {"type":"response.completed","response":{"id":"resp_test","status":"completed","model":"gpt-5.5","output":[],"output_text":"OK_GPT_PASSTHROUGH"}}',
          "",
        ].join("\n"),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { server, seen, baseUrl: `http://127.0.0.1:${server.address().port}/api/codex` };
}

async function startGateway(env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      ...process.env,
      MODEL_GATEWAY_HOST: "127.0.0.1",
      MODEL_GATEWAY_PORT: String(port),
      ...env,
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

test("model catalog exposes GPT, Claude, and Grok slugs from the single gateway provider", async (t) => {
  const gateway = await startGateway();
  t.after(async () => gateway.close());

  const catalog = await requestJson(`http://127.0.0.1:${gateway.port}/v1/models`);
  const slugs = catalog.models.map((model) => model.slug);

  assert.deepEqual(
    ["gpt-5.5", "opus-4-7", "opus-4-8", "sonnet-4-6", "haiku-4-6", "grok-build"].every((slug) =>
      slugs.includes(slug),
    ),
    true,
  );
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

test("oversized requests return a clean 413 instead of resetting the socket", async (t) => {
  const gateway = await startGateway({ GATEWAY_MAX_BODY_BYTES: "1024" });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "sonnet-4-6",
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
      model: "sonnet-4-6",
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
      model: "haiku-4-6",
      input: "reply visibly",
      stream: true,
    }),
  });

  const events = parseSseEvents(await res.text());
  const message = events.find((event) => event.item?.type === "message");

  assert.equal(res.status, 200);
  assert.equal(message.type, "response.output_item.done");
  assert.equal(message.item.role, "assistant");
  assert.equal(message.item.status, "completed");
  assert.deepEqual(message.item.content, [{ type: "output_text", text: "OK_VISIBLE_ASSISTANT" }]);
  assert.ok(events.some((event) => event.type === "response.completed"));
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
  const message = events.find((event) => event.item?.type === "message");

  assert.equal(res.status, 200);
  assert.equal(message.type, "response.output_item.done");
  assert.match(message.item.content[0].text, /session limit/);
  assert.ok(events.some((event) => event.type === "response.completed"));
  assert.equal(events.some((event) => event.type === "response.failed"), false);
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
      model: "haiku-4-6",
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

test("compact Claude slugs remain accepted as aliases", async (t) => {
  const gateway = await startGateway({
    CLAUDE_MOCK_RESPONSE_JSON: "OK_LEGACY_ALIAS",
  });
  t.after(async () => gateway.close());

  const res = await fetch(`http://127.0.0.1:${gateway.port}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "haiku4.6",
      input: "reply through compact alias",
      stream: false,
    }),
  });

  const body = await res.json();

  assert.equal(res.status, 200);
  assert.equal(body.output_text, "OK_LEGACY_ALIAS");
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
      model: "sonnet-4-6",
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

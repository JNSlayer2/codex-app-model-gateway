const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Writable } = require("node:stream");
const test = require("node:test");
const vm = require("node:vm");

function loadGatewayInternals() {
  const serverPath = path.join(__dirname, "..", "server.js");
  const source = fs.readFileSync(serverPath, "utf8");
  const listenBlock = [
    "server.listen(PORT, HOST, () => {",
    "  console.log(`codex-app-model-gateway listening on http://${HOST}:${PORT}`);",
    "});",
  ].join("\n");
  assert.equal(source.includes(listenBlock), true, "test harness must suppress the exact production listen block");
  const instrumented = source.replace(
    listenBlock,
    [
      "globalThis.__gatewayReasoningTest = {",
      "  claudeArgs,",
      "  claudeChildEnv,",
      "  claudeStreamArgs,",
      "  claudeStreamInputArgs,",
      "  forwardedReasoningControl,",
      "  grokArgs,",
      "  modelsPayload,",
      "  requestedReasoningControl,",
      "  responseObjects,",
      "  toolCallResponseObjects,",
      "  writeClaudeTextPrompt,",
      "  writeGrokTextPrompt,",
      "};",
    ].join("\n"),
  );
  const context = {
    __dirname: path.dirname(serverPath),
    __filename: serverPath,
    AbortController,
    Buffer,
    URL,
    clearInterval,
    clearTimeout,
    console,
    fetch,
    process,
    require,
    setInterval,
    setTimeout,
  };
  vm.runInNewContext(instrumented, context, { filename: serverPath });
  return context.__gatewayReasoningTest;
}

const {
  claudeArgs,
  claudeChildEnv,
  claudeStreamArgs,
  claudeStreamInputArgs,
  forwardedReasoningControl,
  grokArgs,
  modelsPayload,
  requestedReasoningControl,
  responseObjects,
  toolCallResponseObjects,
  writeClaudeTextPrompt,
  writeGrokTextPrompt,
} = loadGatewayInternals();

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("catalog advertises only provider-supported reasoning effort levels", () => {
  const catalog = modelsPayload();
  const bySlug = new Map(catalog.models.map((model) => [model.slug, model]));
  const efforts = (slug) =>
    bySlug.get(slug).supported_reasoning_levels.map((level) => level.effort);

  assert.deepEqual(plain(efforts("gpt-5.6-sol")), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(plain(efforts("fable-5")), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(plain(efforts("opus-5")), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(plain(efforts("grok-build")), ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(plain(efforts("minimax-m3")), []);
  assert.equal(bySlug.get("minimax-m3").default_reasoning_level, null);

  assert.deepEqual(plain(bySlug.get("fable-5").capabilities.reasoning_effort), {
    request_field: "reasoning.effort",
    supported: ["low", "medium", "high", "xhigh", "max"],
    cli_flag: "--effort",
    effective_attestation: false,
  });
  assert.deepEqual(plain(bySlug.get("grok-build").capabilities.reasoning_effort), {
    request_field: "reasoning.effort",
    supported: ["low", "medium", "high", "xhigh"],
    cli_flag: "--reasoning-effort",
    effective_attestation: false,
  });
});

test("Claude and Grok normalize request effort and map it to native CLI flags", () => {
  const claudeControl = requestedReasoningControl(
    { reasoning: { effort: " XHIGH " } },
    "claude",
  );
  const grokControl = requestedReasoningControl(
    { reasoning: { effort: "high" } },
    "grok",
  );
  const claudeArgv = claudeArgs("claude-fable-5-1", "test prompt", claudeControl);
  const claudeStreamArgv = claudeStreamArgs("claude-fable-5-1", "test prompt", claudeControl);
  const claudeVisionArgv = claudeStreamInputArgs("claude-fable-5-1", claudeControl);
  const grokArgv = grokArgs("grok-4.6", "test prompt", [], grokControl);

  assert.deepEqual(plain(claudeArgv.slice(claudeArgv.indexOf("--effort"), claudeArgv.indexOf("--effort") + 2)), [
    "--effort",
    "xhigh",
  ]);
  assert.deepEqual(
    plain(grokArgv.slice(grokArgv.indexOf("--reasoning-effort"), grokArgv.indexOf("--reasoning-effort") + 2)),
    ["--reasoning-effort", "high"],
  );
  assert.equal(claudeArgv.filter((arg) => arg === "--effort").length, 1);
  assert.deepEqual(
    plain(claudeStreamArgv.slice(claudeStreamArgv.indexOf("--effort"), claudeStreamArgv.indexOf("--effort") + 2)),
    ["--effort", "xhigh"],
  );
  assert.deepEqual(
    plain(claudeVisionArgv.slice(claudeVisionArgv.indexOf("--effort"), claudeVisionArgv.indexOf("--effort") + 2)),
    ["--effort", "xhigh"],
  );
  assert.equal(grokArgv.filter((arg) => arg === "--reasoning-effort").length, 1);
});

test("Claude child environment pins the Codex-selected effort above native Claude defaults", () => {
  const original = process.env.CLAUDE_CODE_EFFORT_LEVEL;
  process.env.CLAUDE_CODE_EFFORT_LEVEL = "high";
  try {
    const medium = requestedReasoningControl(
      { reasoning: { effort: "medium" } },
      "claude",
    );
    assert.equal(claudeChildEnv(medium).CLAUDE_CODE_EFFORT_LEVEL, "medium");
    assert.equal(
      claudeChildEnv(requestedReasoningControl({}, "claude"))
        .CLAUDE_CODE_EFFORT_LEVEL,
      "low",
    );
  } finally {
    if (original === undefined) {
      delete process.env.CLAUDE_CODE_EFFORT_LEVEL;
    } else {
      process.env.CLAUDE_CODE_EFFORT_LEVEL = original;
    }
  }
});

test("Claude text prompt stays out of argv and is written losslessly to stdin", async () => {
  const marker = "FABLE_LONG_SESSION_STDIN_MARKER";
  const prompt = `${marker}\n${"x".repeat(384 * 1024)}`;
  const control = requestedReasoningControl(
    { reasoning: { effort: "xhigh" } },
    "claude",
  );
  const argv = claudeStreamArgs("claude-fable-5-1", prompt, control);
  let captured = "";
  const errors = [];
  const child = {
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        captured += chunk.toString("utf8");
        callback();
      },
    }),
  };
  const finished = onceFinished(child.stdin);

  writeClaudeTextPrompt(child, prompt, (error) => errors.push(error));
  await finished;

  assert.equal(argv.some((argument) => String(argument).includes(marker)), false);
  assert.ok(Buffer.byteLength(JSON.stringify(argv), "utf8") < 64 * 1024);
  assert.equal(captured, prompt);
  assert.ok(Buffer.byteLength(captured, "utf8") > 384 * 1024);
  assert.deepEqual(errors, []);
});

test("Grok text prompt stays out of argv and is written losslessly through prompt-file stdin", async () => {
  const marker = "GROK_LONG_SESSION_STDIN_MARKER";
  const prompt = `${marker}\n${"y".repeat(384 * 1024)}`;
  const control = requestedReasoningControl(
    { reasoning: { effort: "xhigh" } },
    "grok",
  );
  const argv = grokArgs("grok-4.6", prompt, [], control);
  let captured = "";
  const errors = [];
  const child = {
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        captured += chunk.toString("utf8");
        callback();
      },
    }),
  };
  const finished = onceFinished(child.stdin);

  writeGrokTextPrompt(child, prompt, (error) => errors.push(error));
  await finished;

  assert.equal(argv.some((argument) => String(argument).includes(marker)), false);
  assert.deepEqual(
    plain(argv.slice(argv.indexOf("--prompt-file"), argv.indexOf("--prompt-file") + 2)),
    ["--prompt-file", "/dev/stdin"],
  );
  assert.ok(Buffer.byteLength(JSON.stringify(argv), "utf8") < 64 * 1024);
  assert.equal(captured, prompt);
  assert.ok(Buffer.byteLength(captured, "utf8") > 384 * 1024);
  assert.deepEqual(errors, []);
});

function onceFinished(stream) {
  return new Promise((resolve, reject) => {
    stream.once("finish", resolve);
    stream.once("error", reject);
  });
}

test("unsupported or malformed reasoning effort fails closed with status 400", () => {
  assert.throws(
    () => requestedReasoningControl({ reasoning: { effort: "ultra" } }, "claude"),
    (error) => error.status === 400 && /supported values: low, medium, high, xhigh, max/.test(error.message),
  );
  assert.throws(
    () => requestedReasoningControl({ reasoning: { effort: 5 } }, "grok"),
    (error) => error.status === 400 && /must be a string/.test(error.message),
  );
  assert.throws(
    () => requestedReasoningControl({ reasoning: { effort: "max" } }, "grok"),
    (error) => error.status === 400 && /supported values: low, medium, high, xhigh/.test(error.message),
  );
  assert.throws(
    () => requestedReasoningControl({ reasoning: { effort: "high" } }, "minimax"),
    (error) => error.status === 400 && /supported values: none/.test(error.message),
  );
  assert.throws(
    () => requestedReasoningControl({ reasoning: { effort: "max" } }, "gpt"),
    (error) => error.status === 400 && /supported values: low, medium, high, xhigh/.test(error.message),
  );
});

test("completed JSON and tool-call responses expose public-safe forwarding evidence", () => {
  const requested = requestedReasoningControl(
    { reasoning: { effort: "high" } },
    "claude",
  );
  const forwarded = forwardedReasoningControl(requested);
  const textResponse = responseObjects("OK", "fable-5", {
    reasoning_control: forwarded,
  }).response;
  const toolResponse = toolCallResponseObjects(
    [{ call_id: "call_1", name: "read_only_probe", arguments: "{}" }],
    "fable-5",
    { reasoning_control: forwarded },
  ).response;

  for (const response of [textResponse, toolResponse]) {
    assert.deepEqual(plain(response.reasoning_control), {
      requested: "high",
      normalized: "high",
      provider: "claude_cli",
      cli_flag: "--effort",
      forwarded: true,
      effective_attested: false,
    });
  }
});

test("omitted effort does not invent a CLI forwarding claim", () => {
  const control = requestedReasoningControl({}, "grok");
  const argv = grokArgs("grok-4.6", "test prompt", [], control);

  assert.equal(argv.includes("--reasoning-effort"), false);
  assert.deepEqual(plain(control), {
    requested: null,
    normalized: null,
    provider: "grok_cli",
    cli_flag: "--reasoning-effort",
    forwarded: false,
    effective_attested: false,
  });
});

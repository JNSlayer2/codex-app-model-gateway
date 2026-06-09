#!/usr/bin/env node
"use strict";

const { spawn } = require("node:child_process");

const timeoutMs = Number(process.env.APP_SERVER_SAME_THREAD_TIMEOUT_MS || 600000);
const code = `CODEX_GATEWAY_CONTEXT_${Date.now()}`;
const claudeThreadModels = (process.env.SAME_THREAD_CLAUDE_MODELS || "opus-4-7,opus-4-8,sonnet-4-6,haiku-4-6,fable-5")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);
const turns = [
  {
    label: "gpt-store-context",
    model: "gpt-5.5",
    text: `The verification code for this thread is ${code}. It is the only string that starts with CODEX_GATEWAY_CONTEXT_. Remember that exact code for later turns. Reply only OK_GPT_CONTEXT_STORED.`,
    expect: "OK_GPT_CONTEXT_STORED",
  },
  ...claudeThreadModels.map((model) => ({
    label: `claude-read-context-${model}`,
    model,
    text: "Find the earlier verification code that starts with CODEX_GATEWAY_CONTEXT_. Reply only that full code string. Do not reply with OK_GPT_CONTEXT_STORED.",
    expect: code,
  })),
  {
    label: "gpt-switch-back",
    model: "gpt-5.5",
    text: "Reply only OK_GPT_SWITCH_BACK.",
    expect: "OK_GPT_SWITCH_BACK",
  },
];

const state = {
  threadId: null,
  threadProvider: null,
  currentTurn: -1,
  results: [],
  error: null,
};

const child = spawn("codex", ["app-server", "--analytics-default-enabled"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
let nextId = 1;

const timer = setTimeout(() => {
  fail({
    message: "same-thread smoke timed out",
    state: snapshotState(),
  });
}, timeoutMs);

function send(method, params, id = `req-${nextId++}`) {
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  return id;
}

function sendNotification(method, params) {
  child.stdin.write(`${JSON.stringify({ method, params })}\n`);
}

function turnParams(turn) {
  return {
    threadId: state.threadId,
    input: [{ type: "text", text: turn.text, text_elements: [] }],
    responsesapiClientMetadata: null,
    additionalContext: null,
    environments: null,
    cwd: null,
    runtimeWorkspaceRoots: null,
    approvalPolicy: null,
    approvalsReviewer: null,
    sandboxPolicy: null,
    permissions: null,
    model: turn.model,
    effort: null,
    summary: null,
    personality: null,
    outputSchema: null,
    collaborationMode: null,
  };
}

function startNextTurn() {
  state.currentTurn += 1;
  const turn = turns[state.currentTurn];
  if (!turn) {
    done();
    return;
  }
  send("turn/start", turnParams(turn), `turn-${state.currentTurn}`);
}

function done() {
  clearTimeout(timer);
  child.kill("SIGTERM");
  console.log(JSON.stringify({ ok: true, threadId: state.threadId, threadProvider: state.threadProvider, results: state.results }, null, 2));
}

function fail(error) {
  clearTimeout(timer);
  state.error = error;
  child.kill("SIGTERM");
  console.error(JSON.stringify({ ok: false, error, ...snapshotState() }, null, 2));
  process.exitCode = 1;
}

function snapshotState() {
  return {
    threadId: state.threadId,
    threadProvider: state.threadProvider,
    currentTurn: state.currentTurn,
    currentTurnLabel: turns[state.currentTurn]?.label || null,
    results: state.results,
  };
}

function compactError(error) {
  if (!error) return null;
  if (typeof error === "string") return error;
  if (error.error?.message) return error.error.message;
  if (error.message) return error.message;
  return JSON.stringify(error).slice(0, 500);
}

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  const important = chunk
    .split(/\n/)
    .filter((line) => /session limit|resets|response.failed|model_gateway|ERROR/.test(line))
    .slice(-6);
  for (const line of important) {
    console.error(line);
  }
});

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    handleMessage(msg);
  }
});

child.on("exit", () => {
  clearTimeout(timer);
});

function handleMessage(msg) {
  if (msg.id === "init") {
    sendNotification("initialized", {});
    send(
      "thread/start",
      {
        model: "gpt-5.5",
        modelProvider: "model_gateway",
        cwd: null,
        runtimeWorkspaceRoots: null,
        approvalPolicy: null,
        approvalsReviewer: null,
        sandbox: null,
        permissions: null,
        config: null,
        serviceName: null,
        baseInstructions: null,
        developerInstructions: null,
        personality: null,
        ephemeral: true,
        sessionStartSource: null,
        threadSource: null,
        environments: null,
        dynamicTools: null,
        mockExperimentalField: null,
      },
      "thread-start",
    );
    return;
  }

  if (msg.id === "thread-start") {
    state.threadId = msg.result?.thread?.id;
    state.threadProvider = msg.result?.thread?.modelProvider || msg.result?.modelProvider;
    if (!state.threadId || state.threadProvider !== "model_gateway") {
      fail({ message: "thread/start did not return model_gateway thread", response: msg });
      return;
    }
    startNextTurn();
    return;
  }

  if (msg.error) {
    fail({ message: compactError(msg), response: msg });
    return;
  }

  if (msg.method === "error") {
    fail({ message: compactError(msg.params), response: msg.params });
    return;
  }

  if (msg.method === "item/completed" && msg.params?.threadId === state.threadId) {
    const item = msg.params.item;
    const turn = turns[state.currentTurn];
    if (item?.type === "agentMessage" && turn) {
      const text = String(item.text || "").trim();
      state.results.push({ label: turn.label, model: turn.model, text });
    }
    return;
  }

  if (msg.method === "turn/completed" && msg.params?.threadId === state.threadId) {
    const turn = turns[state.currentTurn];
    const error = msg.params?.turn?.error;
    const last = state.results[state.results.length - 1];
    if (error) {
      fail({ message: compactError(error), turn: turn?.label, response: error });
      return;
    }
    if (!turn || !last || last.label !== turn.label || !last.text.includes(turn.expect)) {
      fail({
        message: "turn completed without expected visible assistant message",
        expected: turn?.expect,
        actual: last?.text || null,
        turn: turn?.label,
      });
      return;
    }
    startNextTurn();
  }
}

send(
  "initialize",
  {
    clientInfo: { name: "codex-gateway-same-thread-smoke", title: "Codex Gateway Same Thread Smoke", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false, optOutNotificationMethods: [] },
  },
  "init",
);

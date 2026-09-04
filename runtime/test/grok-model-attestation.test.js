const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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
  assert.equal(
    source.includes(listenBlock),
    true,
    "test harness must suppress the exact production listen block",
  );
  const instrumented = source.replace(
    listenBlock,
    [
      "globalThis.__gatewayGrokAttestationTest = {",
      "  grokExecutionAttestation,",
      "  grokSessionStateEvidence,",
      "  normalizeGrokResult,",
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
  return context.__gatewayGrokAttestationTest;
}

const {
  grokExecutionAttestation,
  grokSessionStateEvidence,
  normalizeGrokResult,
} = loadGatewayInternals();

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeSessionFixture({
  summaryModel = "grok-4.6",
  startedModel = "grok-4.6",
  outcome = "success",
  summaryRequestID = "request-1",
  stdoutRequestID = "request-1",
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tatwo-grok-attestation-"));
  const grokHome = path.join(root, ".grok");
  const cwd = path.join(root, "work");
  const sessionID = "session-1";
  fs.mkdirSync(cwd, { recursive: true });
  const resolvedCwd = fs.realpathSync(cwd);
  const sessionRoot = path.join(
    grokHome,
    "sessions",
    encodeURIComponent(resolvedCwd),
    sessionID,
  );
  fs.mkdirSync(sessionRoot, { recursive: true });
  fs.writeFileSync(
    path.join(sessionRoot, "summary.json"),
    JSON.stringify({
      info: { id: sessionID, cwd: resolvedCwd },
      current_model_id: summaryModel,
      request_id: summaryRequestID,
    }),
  );
  fs.writeFileSync(
    path.join(sessionRoot, "events.jsonl"),
    [
      JSON.stringify({
        type: "turn_started",
        session_id: sessionID,
        turn_number: 0,
        model_id: startedModel,
      }),
      JSON.stringify({ type: "turn_ended", outcome }),
      "",
    ].join("\n"),
  );
  return {
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
    cwd,
    env: { GROK_HOME: grokHome },
    sessionID,
    stdoutRequestID,
  };
}

test("Grok JSON normalization retains the CLI session and request identifiers", () => {
  assert.deepEqual(
    plain(normalizeGrokResult(JSON.stringify({
      text: "OK",
      sessionId: "session-1",
      requestId: "request-1",
    }))),
    {
      text: "OK",
      sessionId: "session-1",
      requestId: "request-1",
    },
  );
});

test("Grok exact-model proof is derived from matching successful CLI session state", () => {
  const fixture = makeSessionFixture();
  try {
    const evidence = grokSessionStateEvidence(
      fixture.sessionID,
      fixture.stdoutRequestID,
      fixture.env,
      fixture.cwd,
    );
    const attestation = grokExecutionAttestation(
      "grok-build",
      "grok-4.6",
      { grok_session_evidence: evidence },
      0,
    );
    assert.equal(attestation.outcome, "VERIFIED_EXACT");
    assert.equal(attestation.exact, true);
    assert.equal(attestation.actual_vendor_model, "grok-4.6");
    assert.equal(attestation.evidence_source, "grok_cli_session_state");
    assert.equal(attestation.session_evidence.summary_session_id_matches, true);
    assert.equal(attestation.session_evidence.request_id_consistent, true);
    assert.equal(attestation.session_evidence.turn_ended_outcome, "success");
    assert.ok(/^[a-f0-9]{64}$/.test(attestation.session_evidence.session_id_sha256));
    assert.equal(JSON.stringify(attestation).includes(fixture.sessionID), false);
  } finally {
    fixture.cleanup();
  }
});

test("Grok proof fails closed on model mismatch, unsuccessful turn, or candidate fallback", () => {
  for (const variant of [
    { startedModel: "grok-4.4", fallbackCount: 0 },
    { startedModel: "grok-4.5", fallbackCount: 0 },
    { outcome: "error", fallbackCount: 0 },
    { fallbackCount: 1 },
  ]) {
    const fixture = makeSessionFixture(variant);
    try {
      const evidence = grokSessionStateEvidence(
        fixture.sessionID,
        fixture.stdoutRequestID,
        fixture.env,
        fixture.cwd,
      );
      const attestation = grokExecutionAttestation(
        "grok-build",
        "grok-4.6",
        { grok_session_evidence: evidence },
        variant.fallbackCount,
      );
      assert.equal(attestation.exact, false);
      assert.notEqual(attestation.outcome, "VERIFIED_EXACT");
    } finally {
      fixture.cleanup();
    }
  }
});

test("Grok proof is missing when the CLI session files cannot be bound to stdout", () => {
  const evidence = grokSessionStateEvidence(
    "missing-session",
    "missing-request",
    { GROK_HOME: path.join(os.tmpdir(), "missing-grok-home") },
    os.tmpdir(),
  );
  const attestation = grokExecutionAttestation(
    "grok-build",
    "grok-4.6",
    { grok_session_evidence: evidence },
    0,
  );
  assert.equal(attestation.outcome, "ATTESTATION_MISSING");
  assert.equal(attestation.exact, false);
});

"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const test = require("node:test");

const {
  createTatwoGatewayContinuation,
} = require("../tatwo-continuation");

function body({
  mode = "none",
  previousResponseHandle = null,
  previousGatewayInstanceID = null,
  previousResponseID = null,
} = {}) {
  const result = {
    model: "fable-5",
    input: "test",
    metadata: {
      tatwo: {
        continuation: {
          schema: "TatwoGatewayContinuationV1",
          mode,
          thread_id: "bbe969dc-06e3-47c4-8555-1f61ca0641c6",
          discussion_id: null,
          runtime_adapter_id: "gateway-direct",
          canonical_model_id: "fable-5",
          previous_response_handle: previousResponseHandle,
          previous_gateway_instance_id: previousGatewayInstanceID,
          context_sha256: crypto
            .createHash("sha256")
            .update("test")
            .digest("hex"),
          authority_nonce: crypto.randomUUID(),
        },
      },
    },
  };
  if (previousResponseID) {
    result.previous_response_id = previousResponseID;
  }
  return result;
}

function exactResult(providerSessionID) {
  return {
    ok: true,
    provider_session_id: providerSessionID,
    attestation: {
      exact: true,
      fallback_count: 0,
    },
  };
}

test("Tatwo gateway continuation starts and resumes one provider session", () => {
  const continuation = createTatwoGatewayContinuation({
    instanceID: "gateway-instance-test",
  });
  const start = continuation.plan(body(), {
    routeKind: "claude",
    canonicalModelID: "fable-5",
  });
  assert.deepEqual(
    continuation.providerSessionArguments(start, "claude"),
    ["--session-id", start.providerSessionID],
  );
  const first = continuation.complete(
    start,
    exactResult(start.providerSessionID),
    "resp-first",
  );
  assert.equal(first.requested_mode, "none");
  assert.equal(first.continuation_source, "provider_session_started");
  assert.equal(first.provider_session_reused, false);

  const resume = continuation.plan(body({
    mode: "provider_resume",
    previousResponseHandle: first.response_handle,
    previousGatewayInstanceID: first.gateway_instance_id,
    previousResponseID: first.response_handle,
  }), {
    routeKind: "claude",
    canonicalModelID: "fable-5",
  });
  continuation.acquire(resume);
  assert.deepEqual(
    continuation.providerSessionArguments(resume, "claude"),
    ["--resume", start.providerSessionID],
  );
  const second = continuation.complete(
    resume,
    exactResult(start.providerSessionID),
    "resp-second",
  );
  assert.equal(second.requested_mode, "provider_resume");
  assert.equal(second.continuation_source, "provider_session_resumed");
  assert.equal(second.provider_session_reused, true);
  assert.notEqual(second.response_handle, first.response_handle);
  assert.equal(second.previous_response_handle, first.response_handle);
});

test("Tatwo gateway continuation rejects cross-instance and cross-model resume", () => {
  const continuation = createTatwoGatewayContinuation({
    instanceID: "gateway-instance-test",
  });
  const start = continuation.plan(body(), {
    routeKind: "claude",
    canonicalModelID: "fable-5",
  });
  const first = continuation.complete(
    start,
    exactResult(start.providerSessionID),
    "resp-first",
  );

  assert.throws(() => continuation.plan(body({
    mode: "provider_resume",
    previousResponseHandle: first.response_handle,
    previousGatewayInstanceID: "other-instance",
    previousResponseID: first.response_handle,
  }), {
    routeKind: "claude",
    canonicalModelID: "fable-5",
  }), /continuation_gateway_instance_mismatch/);

  assert.throws(() => continuation.plan(body({
    mode: "provider_resume",
    previousResponseHandle: first.response_handle,
    previousGatewayInstanceID: first.gateway_instance_id,
    previousResponseID: first.response_handle,
  }), {
    routeKind: "claude",
    canonicalModelID: "opus-5",
  }), /continuation_canonical_model_mismatch/);
});

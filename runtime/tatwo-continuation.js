"use strict";

const crypto = require("crypto");

const REQUEST_SCHEMA = "TatwoGatewayContinuationV1";
const RECEIPT_SCHEMA = "TatwoGatewayContinuationReceiptV1";
const HANDLE_PREFIX = "tgwc1";
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_HANDLES = 2_000;

function boundedString(value, field, maxBytes) {
  const normalized = String(value ?? "").trim();
  if (
    !normalized
    || Buffer.byteLength(normalized, "utf8") > maxBytes
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized)
  ) {
    throw continuationError(400, `${field}_invalid`);
  }
  return normalized;
}

function boundedHandle(value, field) {
  const normalized = boundedString(value, field, 256);
  if (Buffer.byteLength(normalized, "utf8") < 16) {
    throw continuationError(400, `${field}_invalid`);
  }
  return normalized;
}

function continuationError(status, code) {
  return Object.assign(new Error(code), { status, code });
}

function normalizedDiscussionID(value) {
  return value == null
    ? null
    : boundedString(value, "continuation_discussion_id", 160);
}

function createTatwoGatewayContinuation(options = {}) {
  const instanceID =
    options.instanceID
    || crypto.randomBytes(12).toString("hex");
  const configuredTTL = Number(
    options.ttlMs
    ?? process.env.TATWO_CONTINUATION_HANDLE_TTL_MS,
  );
  const ttlMs =
    Number.isSafeInteger(configuredTTL)
    && configuredTTL > 0
    && configuredTTL <= 24 * 60 * 60 * 1000
      ? configuredTTL
      : DEFAULT_TTL_MS;
  const handles = new Map();
  const inFlight = new Set();

  function prune(now = Date.now()) {
    for (const [handle, entry] of handles.entries()) {
      if (entry.expiresAt <= now && !inFlight.has(handle)) {
        handles.delete(handle);
      }
    }
    while (handles.size > MAX_HANDLES) {
      const oldest = handles.keys().next().value;
      if (!oldest) break;
      if (inFlight.has(oldest)) {
        const entry = handles.get(oldest);
        handles.delete(oldest);
        handles.set(oldest, entry);
        continue;
      }
      handles.delete(oldest);
    }
  }

  function plan(body, { routeKind, canonicalModelID }) {
    const value = body?.metadata?.tatwo?.continuation;
    if (value == null) {
      if (body?.previous_response_id != null) {
        throw continuationError(
          400,
          "continuation_previous_response_id_without_contract",
        );
      }
      return null;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw continuationError(400, "continuation_request_invalid");
    }
    if (routeKind !== "claude" && routeKind !== "grok") {
      throw continuationError(400, "continuation_route_unsupported");
    }
    if (value.schema !== REQUEST_SCHEMA) {
      throw continuationError(400, "continuation_schema_invalid");
    }
    const mode = String(value.mode ?? "").trim();
    if (!["none", "context_replay", "provider_resume"].includes(mode)) {
      throw continuationError(400, "continuation_mode_invalid");
    }
    const threadID = boundedString(
      value.thread_id,
      "continuation_thread_id",
      160,
    );
    const discussionID = normalizedDiscussionID(value.discussion_id);
    const runtimeAdapterID = String(
      value.runtime_adapter_id ?? "",
    ).trim();
    if (runtimeAdapterID !== "gateway-direct") {
      throw continuationError(
        400,
        "continuation_runtime_adapter_mismatch",
      );
    }
    const requestedCanonicalModelID = boundedString(
      value.canonical_model_id,
      "continuation_canonical_model_id",
      120,
    );
    if (requestedCanonicalModelID !== canonicalModelID) {
      throw continuationError(
        400,
        "continuation_canonical_model_mismatch",
      );
    }
    const contextSHA256 = String(
      value.context_sha256 ?? "",
    ).trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(contextSHA256)) {
      throw continuationError(
        400,
        "continuation_context_sha256_invalid",
      );
    }
    const previousResponseHandle =
      value.previous_response_handle == null
        ? null
        : boundedHandle(
            value.previous_response_handle,
            "continuation_previous_response_handle",
          );
    const previousGatewayInstanceID =
      value.previous_gateway_instance_id == null
        ? null
        : boundedString(
            value.previous_gateway_instance_id,
            "continuation_previous_gateway_instance_id",
            160,
          );
    const wirePreviousResponseID =
      body?.previous_response_id == null
        ? null
        : boundedHandle(
            body.previous_response_id,
            "continuation_previous_response_id",
          );

    if (mode !== "provider_resume") {
      if (
        previousResponseHandle !== null
        || previousGatewayInstanceID !== null
        || wirePreviousResponseID !== null
      ) {
        throw continuationError(
          400,
          "continuation_previous_pointer_invalid",
        );
      }
      return {
        mode,
        routeKind,
        threadID,
        discussionID,
        runtimeAdapterID,
        canonicalModelID,
        contextSHA256,
        previousResponseHandle: null,
        providerSessionID:
          routeKind === "claude" ? crypto.randomUUID() : null,
        acquired: false,
      };
    }

    if (
      previousResponseHandle === null
      || previousGatewayInstanceID === null
      || wirePreviousResponseID !== previousResponseHandle
    ) {
      throw continuationError(
        400,
        "continuation_previous_pointer_invalid",
      );
    }
    if (previousGatewayInstanceID !== instanceID) {
      throw continuationError(
        409,
        "continuation_gateway_instance_mismatch",
      );
    }
    prune();
    const entry = handles.get(previousResponseHandle);
    if (!entry) {
      throw continuationError(
        409,
        "continuation_handle_unknown_or_expired",
      );
    }
    if (
      entry.threadID !== threadID
      || entry.discussionID !== discussionID
      || entry.runtimeAdapterID !== runtimeAdapterID
      || entry.canonicalModelID !== canonicalModelID
      || entry.routeKind !== routeKind
    ) {
      throw continuationError(
        409,
        "continuation_handle_scope_mismatch",
      );
    }
    return {
      mode,
      routeKind,
      threadID,
      discussionID,
      runtimeAdapterID,
      canonicalModelID,
      contextSHA256,
      previousResponseHandle,
      providerSessionID: entry.providerSessionID,
      acquired: false,
    };
  }

  function acquire(plan) {
    if (!plan || plan.mode !== "provider_resume") return;
    if (inFlight.has(plan.previousResponseHandle)) {
      throw continuationError(409, "continuation_handle_in_flight");
    }
    inFlight.add(plan.previousResponseHandle);
    plan.acquired = true;
  }

  function providerSessionArguments(plan, routeKind) {
    if (!plan) {
      return routeKind === "claude"
        ? ["--no-session-persistence"]
        : [];
    }
    if (routeKind === "claude") {
      return plan.mode === "provider_resume"
        ? ["--resume", plan.providerSessionID]
        : ["--session-id", plan.providerSessionID];
    }
    if (routeKind === "grok" && plan.mode === "provider_resume") {
      return ["--resume", plan.providerSessionID];
    }
    return [];
  }

  function complete(plan, result, responseID) {
    if (!plan) return null;
    const attestation = result?.attestation;
    if (
      result?.ok !== true
      || attestation?.exact !== true
      || Number(attestation?.fallback_count ?? result?.fallback_count ?? 0) !== 0
    ) {
      throw continuationError(
        502,
        "continuation_provider_result_unverified",
      );
    }
    const providerSessionID = String(
      result?.provider_session_id
      || plan.providerSessionID
      || "",
    ).trim();
    if (!providerSessionID) {
      throw continuationError(
        502,
        "continuation_provider_session_missing",
      );
    }
    if (
      plan.providerSessionID
      && providerSessionID !== plan.providerSessionID
    ) {
      throw continuationError(
        502,
        "continuation_provider_session_mismatch",
      );
    }
    const responseHandle = [
      HANDLE_PREFIX,
      instanceID,
      crypto.randomBytes(24).toString("hex"),
    ].join(".");
    if (plan.previousResponseHandle) {
      handles.delete(plan.previousResponseHandle);
      inFlight.delete(plan.previousResponseHandle);
      plan.acquired = false;
    }
    handles.set(responseHandle, {
      routeKind: plan.routeKind,
      threadID: plan.threadID,
      discussionID: plan.discussionID,
      runtimeAdapterID: plan.runtimeAdapterID,
      canonicalModelID: plan.canonicalModelID,
      providerSessionID,
      responseID: String(responseID ?? ""),
      expiresAt: Date.now() + ttlMs,
    });
    prune();
    const sourceByMode = {
      none: "provider_session_started",
      context_replay: "gateway_replayed_input",
      provider_resume: "provider_session_resumed",
    };
    return {
      schema: RECEIPT_SCHEMA,
      requested_mode: plan.mode,
      applied_mode: plan.mode,
      thread_id: plan.threadID,
      discussion_id: plan.discussionID,
      runtime_adapter_id: plan.runtimeAdapterID,
      canonical_model_id: plan.canonicalModelID,
      previous_response_handle: plan.previousResponseHandle,
      response_handle: responseHandle,
      context_sha256: plan.contextSHA256,
      gateway_instance_id: instanceID,
      continuation_source: sourceByMode[plan.mode],
      provider_session_reused: plan.mode === "provider_resume",
      fallback_count: 0,
      model_attestation_outcome: "VERIFIED_EXACT",
      terminal_status: "completed",
    };
  }

  function settle(plan) {
    if (
      plan?.acquired
      && plan.previousResponseHandle
    ) {
      inFlight.delete(plan.previousResponseHandle);
      plan.acquired = false;
    }
  }

  function attach(response, receipt) {
    if (!receipt) return response;
    response.metadata = {
      ...(response.metadata || {}),
      tatwo: {
        ...(response.metadata?.tatwo || {}),
        continuation_receipt: receipt,
      },
    };
    return response;
  }

  return {
    instanceID,
    plan,
    acquire,
    providerSessionArguments,
    complete,
    settle,
    attach,
    inspect: () => ({
      instanceID,
      handles: handles.size,
      inFlight: inFlight.size,
    }),
  };
}

module.exports = {
  createTatwoGatewayContinuation,
};

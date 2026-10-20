import type { IncomingMessage } from "node:http";
import { onTestFinished } from "vitest";
import type { DecisionEvaluateOptionsV2 } from "../decisions/types-v2.js";
import {
  onTrustedInternalDiagnosticEvent,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { markTrustedOtelDiagnosticListener } from "../infra/diagnostic-otel-listener-provenance.js";

export const unavailable = (reason: string) => ({ status: "unavailable", reason });

export function decisionOptions(
  overrides: Partial<DecisionEvaluateOptionsV2> = {},
): DecisionEvaluateOptionsV2 {
  return {
    purpose: "fixture",
    rubricVersion: "v2",
    timeoutMs: 5000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

export function trackDecisionUsage() {
  const events: Array<Extract<DiagnosticEventPayload, { type: "model.usage" }>> = [];
  onTestFinished(
    onTrustedInternalDiagnosticEvent(
      markTrustedOtelDiagnosticListener((event) => {
        if (event.type === "model.usage") {
          events.push(event);
        }
      }),
    ),
  );
  return events;
}

export function readDecisionRequest(request: IncomingMessage, receive: (body: unknown) => void) {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => receive(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
}

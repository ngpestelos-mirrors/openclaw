import { describe, expect, it } from "vitest";
import { formatTelemetryExporterSummary } from "./telemetry-exporter-summary.js";

function event(seq: number, fields: Record<string, unknown>) {
  return {
    seq,
    type: "telemetry.exporter",
    source: "diagnostics-otel",
    target: "logs",
    transport: "otlp-http-protobuf",
    outcome: "failure",
    ...fields,
  };
}

function expectSummary(events: unknown[], status: "ok" | "warn", lines: string[]) {
  const summary = formatTelemetryExporterSummary({ events });
  expect(summary).toEqual({ title: "Telemetry exporters", status, lines });
  return summary;
}

describe("formatTelemetryExporterSummary", () => {
  it("renders bounded redacted exporter facts without misattribution", () => {
    const summary = expectSummary(
      [
        event(1, {
          source: "https://spoofed.example",
          target: "traces",
          reason: "export_failed",
        }),
        event(2, {
          target: "traces",
          outcome: "recovered",
          reason: "export_failed",
          mode: "default_endpoint",
          url: "https://collector.example/private",
          headers: { authorization: "secret" },
          error: "raw collector failure",
        }),
        event(3, {
          source: "diagnostics-prometheus",
          target: "metrics",
          transport: "prometheus-scrape",
          reason: "handler_failed",
        }),
        event(4, {
          source: "custom_exporter",
          target: "metrics",
          transport: "external-sdk",
          outcome: "started",
          reason: "configured",
        }),
        event(5, {
          transport: "stdout",
          outcome: "started",
          reason: "configured",
        }),
      ],
      "warn",
      [
        "custom_exporter · metrics · started · external SDK ownership",
        "diagnostics-otel · traces · recovered · OTLP/HTTP protobuf (dependency default endpoint) · after export failure",
        "diagnostics-otel · logs · started · stdout",
        "diagnostics-prometheus · metrics · failed · prometheus-scrape · handler failed",
      ],
    );
    expect(JSON.stringify(summary)).not.toContain("collector.example");
    expect(JSON.stringify(summary)).not.toContain("secret");
    expect(JSON.stringify(summary)).not.toContain("raw collector failure");
    expect(JSON.stringify(summary)).not.toContain("spoofed.example");
  });

  it("warns for a final exporter failure", () => {
    expectSummary([event(1, { reason: "shutdown_failed", mode: "configured" })], "warn", [
      "diagnostics-otel · logs · failed · OTLP/HTTP protobuf (explicit endpoint) · shutdown failed",
    ]);
  });

  it("renders startup failures with explicit and dependency-default ownership", () => {
    expectSummary(
      [
        event(1, {
          target: "traces",
          reason: "start_failed",
          mode: "default_endpoint",
        }),
        event(2, {
          target: "metrics",
          reason: "start_failed",
          mode: "configured",
        }),
      ],
      "warn",
      [
        "diagnostics-otel · traces · failed · OTLP/HTTP protobuf (dependency default endpoint) · start failed",
        "diagnostics-otel · metrics · failed · OTLP/HTTP protobuf (explicit endpoint) · start failed",
      ],
    );
  });

  it("renders stdout recovery without exposing failure details", () => {
    expectSummary(
      [
        event(1, {
          transport: "stdout",
          outcome: "recovered",
          reason: "emit_failed",
          error: "private stdout details",
        }),
      ],
      "ok",
      ["diagnostics-otel · logs · recovered · stdout · after emit failure"],
    );
  });

  it("renders safe unknown transports and redacts unsafe ones", () => {
    const summary = expectSummary(
      [
        event(1, {
          source: "custom_exporter",
          transport: "vendor-proto",
          outcome: "started",
          reason: "configured",
        }),
        event(2, {
          source: "second_exporter",
          target: "metrics",
          transport: "collector.internal:4318",
          reason: "queue_full",
        }),
      ],
      "warn",
      [
        "custom_exporter · logs · started · vendor-proto",
        "second_exporter · metrics · failed · exporter · queue full",
      ],
    );
    expect(JSON.stringify(summary)).not.toContain("collector.internal");
  });
});

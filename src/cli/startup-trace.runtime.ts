import { formatConsoleDiagnosticLine } from "../logging/json-console-line.js";
import type { createGatewayDispatchStartupTrace } from "./startup-trace.js";

export function writeGatewayBootstrapStep(
  name: string,
  startedAt: number,
  completedAt: number,
  facts: Readonly<Record<string, number>>,
): void {
  const counts = Object.entries(facts)
    .map(([key, value]) => ` ${key}=${value}`)
    .join("");
  const message = `[gateway] startup trace: ${name} ${(completedAt - startedAt).toFixed(1)}ms total=${completedAt.toFixed(1)}ms start=${startedAt.toFixed(1)}ms${counts}`;
  process.stderr.write(`${formatConsoleDiagnosticLine({ level: "info", message })}\n`);
}

export function prepareGatewayStartupTraceConsoleFormatting(
  trace: ReturnType<typeof createGatewayDispatchStartupTrace>,
): () => void {
  return () =>
    trace.setLineFormatter((message) => formatConsoleDiagnosticLine({ level: "info", message }));
}

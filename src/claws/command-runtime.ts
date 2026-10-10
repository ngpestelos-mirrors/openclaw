import { format } from "node:util";
import type { unsetConfiguredMcpServer } from "../agents/mcp-config-mutation.js";
import type { ConfigWriteOptions } from "../config/io.types.js";
import type { OpenClawConfig } from "../config/types.js";
import type { PluginInstallBatchReload } from "../plugins/install-runtime-batch.js";
import type { RuntimeEnv, OutputRuntimeEnv } from "../runtime.js";
import type { ClawCronGateway } from "./cron.js";
import type { ClawMonitorCleanupGateway } from "./monitor-cleanup-contract.js";
import type { ClawPackageRemovalGateway } from "./package-remove-contract.js";
import type { ClawRemovalJournalGateway } from "./removal-journal-contract.js";

export type ClawCommandServices = {
  assertCurrent: () => void;
  assertSettlementCurrent?: () => void;
  runSettlement?: <T>(run: () => Promise<T>) => Promise<T>;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  waitMs?: number;
  cronGateway?: ClawCronGateway;
  reloadPlugins?: PluginInstallBatchReload;
  createConfigApplication?: () => {
    writeOptions: ConfigWriteOptions;
    confirm: () => Promise<void>;
  };
  commitConfig?: (transform: (config: OpenClawConfig) => OpenClawConfig) => Promise<void>;
  monitorGateway?: ClawMonitorCleanupGateway;
  packageGateway?: ClawPackageRemovalGateway;
  unsetMcpServer?: typeof unsetConfiguredMcpServer;
  journalGateway?: ClawRemovalJournalGateway;
  configWriteOptions?: ConfigWriteOptions;
  onConfigCommitted?: (agentId: string) => Promise<void>;
};

export type ClawCommandReply = {
  output: Array<
    { kind: "log" | "error"; text: string } | { kind: "json"; value: unknown; space: number }
  >;
  exitCode: number;
};

/** Preserve the command's structured/text output without giving a server callback process exit. */
export async function captureClawCommandOutput(
  run: (runtime: RuntimeEnv) => Promise<void>,
): Promise<ClawCommandReply> {
  const reply: ClawCommandReply = { output: [], exitCode: 0 };
  const runtime: OutputRuntimeEnv = {
    log: (...args) => reply.output.push({ kind: "log", text: format(...args) }),
    error: (...args) => reply.output.push({ kind: "error", text: format(...args) }),
    writeStdout: (text) => reply.output.push({ kind: "log", text }),
    writeJson: (value, space = 2) => reply.output.push({ kind: "json", value, space }),
    exit: (code) => {
      reply.exitCode = code;
    },
  };
  await run(runtime);
  return reply;
}

/** Filesystem and installed-command fixtures for daemon installation integration tests. */
import fs from "node:fs/promises";
import { readConfigFileSnapshot } from "../../config/config.js";
import { buildServiceEnvironment } from "../../daemon/service-env.js";

export async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
}

export async function createInstalledServiceCommand() {
  // An installed service has already observed its config; include that health store in snapshots.
  await readConfigFileSnapshot();
  const programArguments = ["openclaw", "gateway", "run"];
  const environment = buildServiceEnvironment({
    env: process.env,
    port: 18789,
    execPath: programArguments[0],
  });
  return {
    programArguments,
    // Service readers return only persisted strings, including the host's required TLS CA bundle.
    environment: Object.fromEntries(
      Object.entries(environment).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
  };
}

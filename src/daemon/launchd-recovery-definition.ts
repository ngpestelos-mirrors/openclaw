/** Boot-volume recovery bytes; the install/backup owner retains all mutation authority. */
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sha256Hex } from "../infra/crypto-digest.js";
import { resolveLaunchAgentLabel } from "./launchd-label.js";
import { decodeLaunchdPlistMetadata } from "./launchd-plist.js";
import { readLaunchAgentProgramArgumentsAtPath } from "./launchd-service-files.js";
import { assertNoSystemLaunchDaemonOwnership } from "./launchd-system.js";
import { publishServiceFile, readServiceFileState } from "./service-stage.js";
import type { GatewayServiceEnv } from "./service-types.js";
import { assertGatewayServiceUpdateCurrent } from "./service-update-authority.js";

export type LaunchAgentRecoveryState = NonNullable<
  Awaited<ReturnType<typeof readServiceFileState>>
>;

export async function verifyLaunchAgentRecoveryDefinition(params: {
  file: string;
  state: LaunchAgentRecoveryState;
  assertCurrent: () => Promise<void>;
}): Promise<Buffer> {
  await params.assertCurrent();
  const before = await readServiceFileState(params.file);
  const contents = await fs.readFile(params.file);
  const after = await readServiceFileState(params.file);
  await params.assertCurrent();
  if (
    !isDeepStrictEqual(before, params.state) ||
    !isDeepStrictEqual(after, params.state) ||
    sha256Hex(contents) !== params.state.sha256
  ) {
    throw new Error("The boot-volume LaunchAgent recovery definition changed.");
  }
  return contents;
}

export async function preserveLaunchAgentRecoveryDefinition(params: {
  env: GatewayServiceEnv;
  file: string;
  contents: Buffer;
  mode: number;
  assertCurrent: () => Promise<void>;
}): Promise<LaunchAgentRecoveryState> {
  await params.assertCurrent();
  const label = resolveLaunchAgentLabel(params.env);
  const metadata = await decodeLaunchdPlistMetadata(params.contents);
  if (metadata?.Label !== label) {
    throw new Error("The LaunchAgent recovery definition does not match its loaded owner.");
  }
  // Preserve private legacy modes; relocation must not widen access to saved
  // environment values or impose a new 0644-only migration restriction.
  assertGatewayServiceUpdateCurrent();
  await assertNoSystemLaunchDaemonOwnership(label);
  await params.assertCurrent();
  await fs.mkdir(path.dirname(params.file), { recursive: true, mode: 0o755 });
  await publishServiceFile({
    filePath: params.file,
    contents: params.contents,
    mode: params.mode,
    beforeRename: async () => {
      await assertNoSystemLaunchDaemonOwnership(label);
      await params.assertCurrent();
      if (await readServiceFileState(params.file)) {
        throw new Error("The LaunchAgent recovery backup already exists.");
      }
    },
  });
  const state = await readServiceFileState(params.file);
  if (!state || state.sha256 !== sha256Hex(params.contents) || state.mode !== params.mode) {
    throw new Error("The boot-volume LaunchAgent recovery definition could not be verified.");
  }
  const command = await readLaunchAgentProgramArgumentsAtPath(params.env, label, params.file, {
    requireEffective: true,
  });
  if (!command) {
    throw new Error("The LaunchAgent recovery command could not be inspected.");
  }
  await verifyLaunchAgentRecoveryDefinition({ ...params, state });
  return state;
}

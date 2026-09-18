import fs from "node:fs/promises";
import { expect, it, vi } from "vitest";
import {
  readGatewayServiceDefinitionPublication,
  type GatewayServiceDefinitionBackup,
} from "../../daemon/service-definition-backup.js";
import { withGatewayServiceOperationLock } from "../../daemon/service-operation-lock.js";
import * as systemdExec from "../../daemon/systemd-exec.js";
import * as systemdScope from "../../daemon/systemd-scope.js";
import { refreshUpdatedGatewayService } from "./update-command-service-command.js";
import type { InstallRootTransitionFixture } from "./update-command-service-transition.test-support.js";

type PublicationFixture = Pick<InstallRootTransitionFixture, "root" | "run"> & {
  mocks: Pick<InstallRootTransitionFixture["mocks"], "command" | "child">;
};

export function registerServiceDefinitionPublicationTests(getFixture: () => PublicationFixture) {
  it.each([
    "published",
    "changed",
    "missing",
    "failed",
    "unchanged",
    "compensated",
    "refused",
  ] as const)("uses the installer publication to guard rollback (%s)", async (scenario) => {
    const { root, run, mocks } = getFixture();
    vi.spyOn(systemdScope, "assertNoSystemGatewayOwnership").mockResolvedValue(undefined);
    vi.spyOn(systemdExec, "reloadSystemdUserManager").mockResolvedValue(undefined);
    const command = await mocks.command(process.env);
    if (!command?.sourcePath) {
      throw new Error("missing fixture definition");
    }
    const unitPath = command.sourcePath;
    const original = await fs.readFile(unitPath, "utf8");
    const candidate = original.replace("RestartSec=5", "RestartSec=10");
    const edited = candidate.replace("RestartSec=10", "RestartSec=120");
    mocks.child.mockImplementation(async (argv) => {
      expect(argv).toContain("install");
      if (scenario === "unchanged" || scenario === "refused") {
        throw new Error(
          scenario === "refused"
            ? "SERVICE_DEFINITION_UNKNOWN: operator settings cannot be preserved"
            : "installer failed before publication",
        );
      }
      await fs.writeFile(unitPath, candidate);
      const definitionPublication = await readGatewayServiceDefinitionPublication({
        env: process.env,
        command,
      });
      if (scenario === "changed") {
        await fs.writeFile(unitPath, edited);
      }
      if (scenario === "compensated") {
        const restored = `${unitPath}.restored`;
        await fs.writeFile(restored, original, { mode: (await fs.stat(unitPath)).mode & 0o777 });
        await fs.rename(restored, unitPath);
      }
      if (scenario === "failed" || scenario === "compensated") {
        throw new Error("installer failed after publication");
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          action: "install",
          ok: true,
          ...(scenario === "missing" ? {} : { definitionPublication }),
        }),
        stderr: "",
        signal: null,
        killed: false,
        termination: "exit",
      };
    });
    const retained: { backup?: GatewayServiceDefinitionBackup } = {};
    const warnings: string[] = [];
    const refresh = refreshUpdatedGatewayService({
      result: { root, mode: "npm" },
      opts: { json: true, run },
      invocationEnv: process.env,
      serviceEnv: process.env,
      assertCurrent: () => {},
      onDefinitionBackup: (backup) => {
        retained.backup = backup;
      },
      onWarnings: (values) => warnings.push(...values),
    });
    if (!["published", "missing"].includes(scenario)) {
      await expect(refresh).rejects.toThrow(
        scenario === "changed" || scenario === "refused"
          ? "SERVICE_DEFINITION_UNKNOWN"
          : "installer failed",
      );
    } else {
      await refresh;
    }
    const backup = retained.backup;
    if (!backup) {
      throw new Error("rollback backup was not retained");
    }
    const restore = () => withGatewayServiceOperationLock(process.env, () => backup.restore());
    if (["published", "unchanged", "compensated"].includes(scenario)) {
      await restore();
      expect(await fs.readFile(unitPath, "utf8")).toBe(original);
    } else {
      await expect(restore()).rejects.toThrow("not sealed");
      expect(await fs.readFile(unitPath, "utf8")).toBe(
        scenario === "changed" ? edited : scenario === "refused" ? original : candidate,
      );
    }
    expect(await fs.readFile(backup.backupPaths[0]!, "utf8")).toBe(original);
    expect(warnings.join("\n")).toContain(backup.backupPaths[0]);
    if (scenario === "missing") {
      expect(warnings.join("\n")).toContain("manual recovery");
    }
  });
}

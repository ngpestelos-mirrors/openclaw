import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { createFixtureSkillEntry } from "../test-support/test-helpers.js";
import { installSkill } from "./install.js";

const { runCommandWithTimeoutMock } = vi.hoisted(() => ({
  runCommandWithTimeoutMock: vi.fn<typeof import("../../process/exec.js").runCommandWithTimeout>(),
}));

vi.mock("../loading/workspace-skill-loader.js", () => ({ prepareWorkspaceSkills: vi.fn() }));
vi.mock("../../process/exec.js", () => ({ runCommandWithTimeout: runCommandWithTimeoutMock }));

vi.mock("../../plugins/install-security-scan.js", () => ({
  evaluateSkillInstallPolicy: vi.fn(async () => undefined),
}));

afterEach(() => {
  vi.mocked(prepareWorkspaceSkills).mockReset();
  runCommandWithTimeoutMock.mockReset();
  vi.restoreAllMocks();
});

describe.each(["uv", "go"] as const)("%s bootstrap cache freshness", (kind) => {
  it.each([0, 1])("reuses the prerequisite after the first recipe exits %i", async (firstCode) => {
    await withOpenClawTestState({ label: "skill-bootstrap-probe" }, async (state) => {
      const { home, workspaceDir } = state;
      vi.spyOn(os, "homedir").mockReturnValue(home);
      const prefix = path.join(home, ".local");
      const binDir = path.join(prefix, "bin");
      await fs.mkdir(binDir, { recursive: true });
      const writeExecutable = async (name: string) => {
        const executable = path.join(binDir, name);
        await fs.writeFile(executable, "#!/bin/sh\nexit 0\n");
        await fs.chmod(executable, 0o755);
      };
      await writeExecutable("brew");

      const entries = ["first", "second"].map((name) => {
        const entry = createFixtureSkillEntry(name);
        const spec =
          kind === "uv"
            ? { kind, package: `fixture-${name}` }
            : { kind, module: `example.com/fixture-${name}@latest` };
        entry.metadata = { install: [{ id: "deps", ...spec }] };
        return entry;
      });
      vi.mocked(prepareWorkspaceSkills).mockResolvedValue(entries);

      let bootstraps = 0;
      let recipes = 0;
      await withEnvAsync({ PATH: binDir }, async () => {
        runCommandWithTimeoutMock.mockImplementation(async (argv, options) => {
          let stdout = "";
          let code = 0;
          let stderr = "";
          if (argv[0] === "brew" && argv[1] === "install" && argv[2] === kind) {
            bootstraps += 1;
            await writeExecutable(kind);
          } else if (argv[0] === "brew" && argv[1] === "--prefix") {
            stdout = prefix;
          } else {
            const name = recipes === 0 ? "first" : "second";
            expect(argv).toEqual(
              kind === "uv"
                ? ["uv", "tool", "install", `fixture-${name}`]
                : ["go", "install", `example.com/fixture-${name}@latest`],
            );
            await fs.access(path.join(binDir, kind), fs.constants.X_OK);
            if (kind === "go") {
              expect(options).toMatchObject({ env: { PATH: binDir, GOBIN: binDir } });
            }
            code = recipes++ === 0 ? firstCode : 0;
            stdout = `recipe ${name}`;
            stderr = code === 0 ? "" : "fixture recipe failed";
          }
          return { code, stdout, stderr, signal: null, killed: false, termination: "exit" };
        });

        for (const [index, skillName] of ["first", "second"].entries()) {
          const code = index === 0 ? firstCode : 0;
          const result = await installSkill({ workspaceDir, skillName, installId: "deps" });
          expect(result).toMatchObject({
            ok: code === 0,
            code,
            stdout: `recipe ${skillName}`,
            stderr: code === 0 ? "" : "fixture recipe failed",
          });
          expect(process.env.PATH).toBe(binDir);
        }
        expect({ recipes, bootstraps }).toEqual({ recipes: 2, bootstraps: 1 });
      });
    });
  });
});

import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as exec from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withMockedPlatform } from "../test-utils/vitest-spies.js";
import { pkgQueryResult as result } from "./update-freebsd-pkg-ownership.test-support.js";
import { UpdatePreMutationError } from "./update-pre-mutation-error.js";
import {
  createSystemPackageOwnershipInspection,
  SystemPackageOwnershipError,
} from "./update-system-package-ownership.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function inspect(root: string, inventory: string) {
  vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(result(inventory));
  return withMockedPlatform("freebsd", () =>
    createSystemPackageOwnershipInspection(1000).assertUnowned(root),
  );
}

function expectWarning(onWarning: ReturnType<typeof vi.fn>, text: string) {
  expect(onWarning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(text));
  expect(onWarning.mock.calls[0]?.[0]).not.toMatch(
    /private database|private configuration|\/fixture|private path|fixture-secret|PRIVATE_CUSTOM_CODE/u,
  );
}

describe("system package ownership", () => {
  it("uses one non-bootstrap, alias-pinned inventory for a planning snapshot", async () => {
    await withTestDir({ prefix: "openclaw-pkg-inventory-" }, async (base) => {
      const query = vi.spyOn(exec, "runCommandBuffered").mockResolvedValue(result());
      await withMockedPlatform("freebsd", async () => {
        const inspection = createSystemPackageOwnershipInspection(321);
        await inspection.assertUnowned(path.join(base, "first"));
        await inspection.assertUnowned(path.join(base, "second"));
      });
      expect(query).toHaveBeenCalledExactlyOnceWith(["/usr/sbin/pkg", "-N", "query", "-a", "%Fp"], {
        timeoutMs: 321,
        env: { ALIAS: "query=query", PKG_ENABLE_PLUGINS: "no" },
        maxOutputBytes: { stdout: 16 * 1024 * 1024, stderr: 64 * 1024 },
      });
    });
  });

  it("warns once and continues after timeout without consulting the host", async () => {
    const host = vi.spyOn(exec, "runCommandBuffered");
    for (const platform of ["linux", "freebsd"] as const) {
      const onWarning = vi.fn();
      const runCommand = vi
        .fn<typeof exec.runCommandBuffered>()
        .mockResolvedValue(result("", { code: null, termination: "timeout" }));
      await withMockedPlatform(platform, async () => {
        const inspection = createSystemPackageOwnershipInspection(100, { runCommand, onWarning });
        await expect(inspection.assertUnowned("/fixture/openclaw")).resolves.toBeUndefined();
        await expect(inspection.assertEntryUnowned("/fixture/launcher")).resolves.toBeUndefined();
      });
      expect(runCommand).toHaveBeenCalledOnce();
      expectWarning(onWarning, "Continuing without verified system-package ownership");
    }
    expect(host).not.toHaveBeenCalled();
  });

  it.each(["linux"] as const)(
    "retains the pre-mutation error contract for a positive %s owner",
    async (platform) => {
      const onWarning = vi.fn();
      const runCommand = vi
        .fn<typeof exec.runCommandBuffered>()
        .mockResolvedValue(result("/fixture/openclaw/package.json\n"));
      await withMockedPlatform(platform, async () => {
        const failure = createSystemPackageOwnershipInspection(100, {
          runCommand,
          onWarning,
        }).assertUnowned("/fixture/openclaw");
        await expect(failure).rejects.toBeInstanceOf(UpdatePreMutationError);
        await expect(failure).rejects.toBeInstanceOf(SystemPackageOwnershipError);
        await expect(failure).rejects.toMatchObject({
          name: "UpdatePreMutationError",
          reason: "pacman-owned-install",
          owned: true,
        });
      });
      expect(onWarning).not.toHaveBeenCalled();
    },
  );

  it("detects a custom-prefix package through a registered alias", async () => {
    await withTestDir({ prefix: "openclaw-pkg-alias-" }, async (base) => {
      const prefix = path.join(base, "custom prefix");
      const root = path.join(prefix, "lib", "node_modules", "openclaw");
      await fs.mkdir(root, { recursive: true });
      const alias = path.join(base, "alias");
      await fs.symlink(prefix, alias, "dir");
      const registeredRoot = path.join(alias, "lib", "node_modules", "openclaw");
      await expect(inspect(root, `${registeredRoot}/package.json\n`)).rejects.toMatchObject({
        reason: "pkg-owned-install",
      });
    });
  });

  it("does not treat a package-owned file symlink as ownership of its external target", async () => {
    await withTestDir({ prefix: "openclaw-pkg-file-link-" }, async (base) => {
      const root = path.join(base, "openclaw");
      await fs.mkdir(root);
      await fs.writeFile(path.join(root, "openclaw.mjs"), "fixture");
      const launcher = path.join(base, "launcher");
      await fs.symlink(path.join(root, "openclaw.mjs"), launcher);
      await inspect(root, `${launcher}\n`);
    });
  });

  it("preserves ownership of a root symlink reached through a parent alias", async () => {
    await withTestDir({ prefix: "openclaw-pkg-root-link-" }, async (base) => {
      const prefix = path.join(base, "prefix");
      const target = path.join(base, "user", "openclaw");
      await fs.mkdir(prefix);
      await fs.mkdir(target, { recursive: true });
      await fs.symlink(target, path.join(prefix, "openclaw"), "dir");
      await fs.symlink(prefix, path.join(base, "alias"), "dir");
      await expect(
        inspect(path.join(base, "alias", "openclaw"), `${prefix}/openclaw\n`),
      ).rejects.toMatchObject({
        reason: "pkg-owned-install",
      });
    });
  });

  it("warns after lstat failure without private details", async () => {
    await withTestDir({ prefix: "openclaw-pkg-denied-" }, async (base) => {
      const runCommand = vi
        .fn<typeof exec.runCommandBuffered>()
        .mockResolvedValue(result(`${base}/registered/file\n`));
      const onWarning = vi.fn();
      vi.spyOn(fs, "lstat").mockRejectedValue(
        Object.assign(new Error("private path token=fixture-secret"), { code: "EACCES" }),
      );
      await withMockedPlatform("freebsd", async () => {
        await expect(
          createSystemPackageOwnershipInspection(100, { runCommand, onWarning }).assertUnowned(
            path.join(base, "openclaw"),
          ),
        ).resolves.toBeUndefined();
      });
      expectWarning(onWarning, "lstat");
    });
  });

  it("does not continue an ancestor walk or reset the snapshot after a late ENOENT", async () => {
    const query = vi
      .spyOn(exec, "runCommandBuffered")
      .mockResolvedValue(result("/registered/file\n"));
    let rejectLookup: ((error: Error) => void) | undefined;
    const lookup = vi.spyOn(fs, "lstat").mockImplementationOnce(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectLookup = reject;
        }),
    );
    const canonical = vi.spyOn(fs, "realpath");
    vi.useFakeTimers();
    await withMockedPlatform("freebsd", async () => {
      const onWarning = vi.fn();
      const inspection = createSystemPackageOwnershipInspection(100, { onWarning });
      const pending = expect(
        inspection.assertUnowned("/fixture/missing/openclaw"),
      ).resolves.toBeUndefined();
      await Promise.all([pending, vi.advanceTimersByTimeAsync(100)]);
      rejectLookup?.(Object.assign(new Error("missing"), { code: "ENOENT" }));
      await vi.advanceTimersByTimeAsync(0);
      await expect(inspection.assertUnowned("/another/root")).resolves.toBeUndefined();
      expectWarning(onWarning, "exhausted its shared 100 ms budget");
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(canonical).not.toHaveBeenCalled();
  });

  it.each(["query", "path"] as const)(
    "warns when %s work synchronously consumes the deadline",
    async (stage) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const query = vi.spyOn(exec, "runCommandBuffered").mockImplementation(async () => {
        if (stage === "query") {
          clock.mockReturnValue(now + 101);
        }
        return result();
      });
      const lookup = vi.spyOn(fs, "lstat").mockImplementation(async () => {
        clock.mockReturnValue(now + 101);
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      });
      const canonical = vi.spyOn(fs, "realpath");
      await withMockedPlatform("freebsd", async () => {
        const onWarning = vi.fn();
        const inspection = createSystemPackageOwnershipInspection(100, { onWarning });
        await expect(inspection.assertUnowned("/fixture/openclaw")).resolves.toBeUndefined();
        await expect(inspection.assertUnowned("/another/root")).resolves.toBeUndefined();
        expectWarning(onWarning, "exhausted its shared 100 ms budget");
        // Let the test runner observe any rejection orphaned by deadline admission.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      });
      expect(query).toHaveBeenCalledTimes(1);
      expect(lookup).toHaveBeenCalledTimes(stage === "query" ? 0 : 1);
      expect(canonical).not.toHaveBeenCalled();
    },
  );

  it("caps the inspection independently of a long installation timeout", async () => {
    const query = vi
      .spyOn(exec, "runCommandBuffered")
      .mockImplementation(() => new Promise<never>(() => {}));
    vi.useFakeTimers();
    await withMockedPlatform("freebsd", async () => {
      const onWarning = vi.fn();
      const pending = expect(
        createSystemPackageOwnershipInspection(20 * 60_000, { onWarning }).assertUnowned(
          "/fixture/openclaw",
        ),
      ).resolves.toBeUndefined();
      await Promise.all([pending, vi.advanceTimersByTimeAsync(30_000)]);
      expectWarning(onWarning, "exhausted its shared 30000 ms budget during pkg query");
    });
    expect(query).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });
});

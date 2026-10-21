import fs from "node:fs/promises";
import path from "node:path";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFileTransferNodeInvokePolicy } from "../shared/node-invoke-policy.js";
import { createCtx } from "../shared/node-invoke-policy.test-support.js";
import { handleFileStat } from "./file-stat.js";
import { useFiles } from "./node-host.test-support.js";

vi.mock("../shared/audit.js", () => ({ appendFileTransferAudit: vi.fn() }));

let file: string;
const { at, file: makeFile } = useFiles("file-stat-test-", clearRuntimeConfigSnapshot);

beforeEach(async () => {
  setRuntimeConfigSnapshot({});
  file = await makeFile("AGENTS.md", "workspace instructions");
});

async function expectStatError(params: Parameters<typeof handleFileStat>[0], code: string) {
  expect(await handleFileStat(params)).toMatchObject({ ok: false, code });
}

describe("file.stat", () => {
  it("distinguishes missing paths from invalid input", async () => {
    await expectStatError({ path: at("missing") }, "NOT_FOUND");
    await expectStatError({ path: "AGENTS.md" }, "INVALID_PATH");
  });

  it("rejects symlinks by default and returns the canonical target when allowed", async () => {
    const link = at("link");
    await fs.symlink(file, link);
    await expectStatError({ path: link }, "SYMLINK_REDIRECT");
    expect(await handleFileStat({ path: link, followSymlinks: true })).toMatchObject({
      ok: true,
      path: file,
    });
    await expectStatError(
      { path: link, followSymlinks: true, expectedCanonicalPath: link },
      "CANONICAL_PATH_CHANGED",
    );
  });

  it("refuses a replacement at the same path after authorization", async () => {
    const authorized = await handleFileStat({ path: file, preflightOnly: true });
    if (!authorized.ok) {
      throw new Error(authorized.message);
    }
    await fs.rename(file, `${file}.old`);
    await fs.writeFile(file, "replacement");
    await expectStatError(
      {
        path: file,
        expectedCanonicalPath: authorized.path,
        expectedBinding: authorized.binding,
      },
      "CANONICAL_PATH_CHANGED",
    );
  });

  it.each(["file", "directory"] as const)(
    "reads %s metadata with its grant but denies its parent",
    async (type) => {
      const target = type === "file" ? file : at();
      const stats = await fs.stat(target, { bigint: true });
      const { ctx, invokeNode } = createCtx({
        command: "file.stat",
        params: { path: target, followSymlinks: true, preflightOnly: true },
        pluginConfig: { nodes: { "node-1": { allowReadPaths: [target], ask: "off" } } },
      });
      invokeNode.mockImplementation(async ({ params } = {}) => ({
        ok: true,
        payload: await handleFileStat(params as Parameters<typeof handleFileStat>[0]),
      }));
      const result = await createFileTransferNodeInvokePolicy().handle(ctx);
      expect(result).toMatchObject({
        ok: true,
        payload: {
          ok: true,
          path: target,
          type,
          size: Number(stats.size),
          mtimeMs: Number(stats.mtimeNs) / 1_000_000,
          binding: { kind: "existing", device: String(stats.dev), inode: String(stats.ino) },
        },
      });
      expect(result).not.toHaveProperty("payload.base64");
      expect(invokeNode).toHaveBeenCalledTimes(2);
      expect(invokeNode.mock.calls[1]?.[0]?.params).toMatchObject({
        path: target,
        followSymlinks: false,
        expectedCanonicalPath: target,
        expectedBinding: { kind: "existing" },
      });
      invokeNode.mockClear();
      expect(
        await createFileTransferNodeInvokePolicy().handle({
          ...ctx,
          params: { path: path.dirname(target) },
        }),
      ).toMatchObject({ ok: false });
      expect(invokeNode).not.toHaveBeenCalled();
    },
  );
});

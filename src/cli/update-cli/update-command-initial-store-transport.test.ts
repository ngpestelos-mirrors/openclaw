import fs from "node:fs";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { withUpdateInitialStoreInvocation } from "../../infra/update-initial-store-invocation.js";
import * as leaseOwner from "../../infra/update-managed-service-handoff-lease.js";
import { finishUpdateRun, getUpdateRun } from "../../infra/update-run-ledger.js";
import { captureUpdateCommandExecutorAuthority } from "./update-command-executor.js";
import { withInitialStoreFixture } from "./update-command-initial-store.test-support.js";
import * as runOwner from "./update-command-run.js";
import * as targetOwner from "./update-command-target.js";
import { updateCommand } from "./update-command.js";

async function withOrdinaryFixture(operation: Parameters<typeof withInitialStoreFixture>[0]) {
  await withInitialStoreFixture(
    async (fixture) => {
      // Only target discovery is controlled; run admission, SQLite, executor and settlement are real.
      vi.spyOn(runOwner, "prepareUpdateCommand").mockResolvedValue(fixture.prepared);
      await operation(fixture);
    },
    { applicationState: true },
  );
}

it.each([true, false])(
  "admits the real ordinary run with explicit selection=%s and settles its selected row",
  async (selected) => {
    await withOrdinaryFixture(async ({ root, installation, env, input, store }) => {
      const ambient = vi.mocked(leaseOwner.resolveManagedUpdateLeaseDatabasePath);
      ambient.mockClear();
      if (selected) {
        ambient.mockImplementation(() => {
          throw new Error("ambient admission forbidden");
        });
      }
      let admittedRunId: string | undefined;
      vi.spyOn(targetOwner, "resolveUpdateCommandTarget").mockImplementation(
        async (opts, _recovery, _cwd, _prepared, executor) => {
          await Promise.resolve();
          expect(opts.run).toBeDefined();
          const run = opts.run;
          if (!run) {
            throw new Error("Ordinary entry did not admit a real run");
          }
          admittedRunId = run.runId;
          expect(getUpdateRun(run.runId, { env: run.env })?.runId).toBe(run.runId);
          const fence = await executor.enter(installation, { preflight: true });
          const authority = captureUpdateCommandExecutorAuthority(fence, run.runId);
          expect(authority.databasePath).toBe(input.selection.handoff.databasePath);
          expect(store.read(installation)).toMatchObject({
            kind: "current",
            lease: { owner: authority.owner },
          });
          fence.assertCurrent();
          fs.writeFileSync(path.join(root, "ordinary-effect"), run.runId);
          finishUpdateRun(
            run.runId,
            { status: "skipped", reason: "controlled-target-stop" },
            { env: run.env },
          );
          return undefined;
        },
      );
      await updateCommand({ json: true, ...(selected ? { initialStores: input } : {}) });
      expect(admittedRunId).toBeTruthy();
      expect(fs.readFileSync(path.join(root, "ordinary-effect"), "utf8")).toBe(admittedRunId);
      if (!admittedRunId) {
        throw new Error("Ordinary entry did not reach the controlled target");
      }
      expect(getUpdateRun(admittedRunId, { env })?.status).toBe("skipped");
      expect(store.read(installation)).toEqual({ kind: "absent" });
      if (selected) {
        expect(ambient).not.toHaveBeenCalled();
      } else {
        expect(ambient).toHaveBeenCalled();
      }
    });
  },
);

it("refuses invalid initial physical identity before ordinary preparation or run admission", async () => {
  await withOrdinaryFixture(async ({ input }) => {
    const prepare = vi.mocked(runOwner.prepareUpdateCommand);
    const admit = vi.spyOn(runOwner, "admitUpdateCommandRun");
    vi.spyOn(targetOwner, "resolveUpdateCommandTarget").mockResolvedValue(undefined);
    const invalid = {
      ...input,
      selection: {
        ...input.selection,
        state: { ...input.selection.state, databaseIdentity: "0:0" },
      },
    };
    await expect(updateCommand({ json: true, initialStores: invalid })).rejects.toThrow();
    expect(prepare).not.toHaveBeenCalled();
    expect(admit).not.toHaveBeenCalled();
  });
});

it("rechecks the installation returned by asynchronous preparation before any run admission", async () => {
  await withOrdinaryFixture(async ({ root, input, prepared }) => {
    const other = path.join(root, "other-installation");
    fs.mkdirSync(other, { mode: 0o700 });
    vi.mocked(runOwner.prepareUpdateCommand).mockImplementation(async () => {
      await Promise.resolve();
      return { ...prepared, discoveredRoot: other };
    });
    const admit = vi.spyOn(runOwner, "admitUpdateCommandRun");
    const target = vi.spyOn(targetOwner, "resolveUpdateCommandTarget").mockResolvedValue(undefined);
    await expect(updateCommand({ json: true, initialStores: input })).rejects.toThrow(
      "effective installation or store selectors diverged",
    );
    expect(admit).not.toHaveBeenCalled();
    expect(target).not.toHaveBeenCalled();
  });
});

it("refuses a state generation replaced during preparation before history or target work", async () => {
  await withOrdinaryFixture(async ({ input, prepared }) => {
    const statePath = input.selection.state.databasePath;
    const before = fs.readFileSync(statePath);
    vi.mocked(runOwner.prepareUpdateCommand).mockImplementation(async () => {
      await Promise.resolve();
      fs.renameSync(statePath, statePath + ".retained");
      fs.writeFileSync(statePath, before, { mode: 0o600 });
      return prepared;
    });
    const admit = vi.spyOn(runOwner, "admitUpdateCommandRun");
    const target = vi.spyOn(targetOwner, "resolveUpdateCommandTarget").mockResolvedValue(undefined);
    await expect(updateCommand({ json: true, initialStores: input })).rejects.toThrow(
      "database generation changed",
    );
    expect(admit).not.toHaveBeenCalled();
    expect(target).not.toHaveBeenCalled();
    expect(fs.readFileSync(statePath)).toEqual(before);
    expect(fs.readFileSync(statePath + ".retained")).toEqual(before);
  });
});

it("does not revive a settled lexical invocation through ordinary entry", async () => {
  await withOrdinaryFixture(async ({ input }) => {
    vi.spyOn(targetOwner, "resolveUpdateCommandTarget").mockResolvedValue(undefined);
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let pending: Promise<void> | undefined;
    await withUpdateInitialStoreInvocation(input, async () => {
      pending = (async () => {
        await gate;
        await updateCommand({ json: true });
      })();
    });
    resume();
    await expect(pending).rejects.toThrow("Update initial store invocation has settled");
    expect(runOwner.prepareUpdateCommand).not.toHaveBeenCalled();
  });
});

it("refuses selector drift during real run readmission before creating another state store", async () => {
  await withOrdinaryFixture(async ({ root, input, prepared }) => {
    const other = path.join(root, "other-state");
    fs.mkdirSync(other, { mode: 0o700 });
    let inspections = 0;
    prepared.pkgOwnership.assertUnowned = async () => {
      await Promise.resolve();
      if (++inspections === 2) {
        process.env.OPENCLAW_STATE_DIR = other;
      }
    };
    const target = vi.spyOn(targetOwner, "resolveUpdateCommandTarget").mockResolvedValue(undefined);
    await expect(updateCommand({ json: true, initialStores: input })).rejects.toThrow(
      "effective installation or store selectors diverged",
    );
    expect(inspections).toBe(2);
    expect(target).not.toHaveBeenCalled();
    expect(fs.readdirSync(other)).toEqual([]);
  });
});

import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { ProgressCardStep } from "../../packages/gateway-protocol/src/index.js";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import { clearNodeSqliteKyselyCacheForDatabase } from "../infra/kysely-sync.js";
import { getAdmittedSqliteSchemaFacts } from "../infra/sqlite-schema-facts.js";
import * as admission from "../infra/sqlite-worker-operation-admission.js";
import { readSessionProgressCard } from "../session-cards/progress-card-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWorkerWrite } from "../state/openclaw-agent-write-admission.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { progressCardStore } from "./progress-card-store.js";

let state: OpenClawTestState;
let database: ReturnType<typeof openOpenClawAgentDatabase>;

beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
  setRuntimeConfigSnapshot({}, {});
  database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
  database.db.exec("DROP TABLE session_progress_cards");
});

afterAll(async () => {
  await state?.cleanup();
});

function createSession(name: string, source = database) {
  const sessionKey = `agent:${source.agentId}:${name}`;
  replaceSessionEntrySync(
    { agentId: source.agentId, sessionKey, storePath: source.path, env: state.env },
    { sessionId: name, updatedAt: 1 },
  );
  return sessionKey;
}

it("executes lazy creation and FIFO replacements off the host using captured queued input", async () => {
  const sessionKey = createSession("worker-progress");
  const options = { agentId: "main", path: database.path, env: state.env };
  expect(getAdmittedSqliteSchemaFacts(database.db)?.tables.has("session_progress_cards")).toBe(
    false,
  );
  expect(await progressCardStore.get(sessionKey, "main")).toBeNull();
  clearNodeSqliteKyselyCacheForDatabase(database.db);
  const host = observeHostDataSql(state.env);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const held = runOpenClawAgentWorkerWrite(options, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const input: { markdown: string; steps: ProgressCardStep[] } = {
    markdown: "Captured",
    steps: [{ step: "Original", status: "pending" }],
  };
  const empty = progressCardStore.put(sessionKey, {}, "main");
  const first = progressCardStore.put(sessionKey, input, "main");
  const second = progressCardStore.put(sessionKey, { markdown: "Second" }, "main");
  const pending = [empty, first, second];
  void Promise.allSettled(pending);
  try {
    input.markdown = "Changed while queued";
    input.steps[0]!.step = "Changed while queued";
    release.resolve();
    await held;
    expect(await empty).toEqual({ card: null });
    expect.soft(await first).toMatchObject({
      card: {
        markdown: "Captured",
        steps: [{ step: "Original", status: "pending" }],
        revision: 1,
      },
    });
    expect(await second).toMatchObject({ card: { markdown: "Second", revision: 2 } });
    expect(await progressCardStore.put(sessionKey, { expectedRevision: 1 }, "main")).toMatchObject({
      card: { markdown: "Second", revision: 2 },
    });
    expect(await progressCardStore.get(sessionKey, "main")).toMatchObject({
      markdown: "Second",
      revision: 2,
    });
    const progressStatements = host.queries.filter(
      (sql) =>
        /\bsession_progress_cards\b/iu.test(sql) &&
        /(?:\b(?:from|into|update|table)\s+(?:if\s+not\s+exists\s+)?["`]?session_progress_cards\b)/iu.test(
          sql,
        ),
    );
    expect(progressStatements).toEqual([]);
  } finally {
    release.resolve();
    await Promise.allSettled([held, ...pending]);
    host.restore();
  }
  expect(getAdmittedSqliteSchemaFacts(database.db)?.tables.has("session_progress_cards")).toBe(
    true,
  );
  expect(readSessionProgressCard(database.db, sessionKey)).toMatchObject({ revision: 2 });
});

it.each(["transaction", "commit"] as const)(
  "refuses revoked authority at native %s admission and admits the next writer",
  async (stage) => {
    const sessionKey = createSession(`revoke-progress-${stage}`);
    await progressCardStore.put(sessionKey, { markdown: "Original" }, "main");
    const original = await progressCardStore.get(sessionKey, "main");
    const create = admission.createSqliteWorkerOperationAdmission;
    let current = true;
    let revoked = false;
    using interception = vi.spyOn(admission, "createSqliteWorkerOperationAdmission");
    interception.mockImplementation((admit, attachment) =>
      create((request, grant) => {
        if (request.stage === stage && !revoked) {
          revoked = true;
          current = false;
        }
        admit(request, grant);
      }, attachment),
    );
    await expect(
      progressCardStore.put(
        sessionKey,
        {
          markdown: "Must roll back",
          assertCurrent() {
            if (!current) {
              throw new Error("Progress-card requester retired");
            }
          },
        },
        "main",
      ),
    ).rejects.toThrow("Progress-card requester retired");
    expect(revoked).toBe(true);
    expect(await progressCardStore.get(sessionKey, "main")).toEqual(original);
    expect(await progressCardStore.put(sessionKey, { markdown: "Follower" }, "main")).toMatchObject(
      { card: { markdown: "Follower", revision: 2 } },
    );
  },
);

it("keeps incognito writes on the process-held connection without disk artifacts", async () => {
  const options = {
    agentId: "private",
    env: state.env,
    path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "private", env: state.env }),
  };
  const config = {
    agents: { ownership: "explicit" as const, entries: { main: {}, private: {} } },
    session: { store: options.path },
  };
  setRuntimeConfigSnapshot(config, config);
  try {
    const privateDatabase = openOpenClawAgentDatabase(options);
    const sessionKey = createSession("private-progress", privateDatabase);
    expect(
      await progressCardStore.put(sessionKey, { markdown: "Private" }, "private"),
    ).toMatchObject({ card: { markdown: "Private", revision: 1 } });
    expect(await progressCardStore.get(sessionKey, "private")).toMatchObject({
      markdown: "Private",
    });
    expect(openOpenClawAgentDatabase(options).db).toBe(privateDatabase.db);
    expect(existsSync(path.dirname(options.path))).toBe(false);
    for (const suffix of ["", "-wal", "-shm"]) {
      expect(existsSync(`${options.path}${suffix}`)).toBe(false);
    }
  } finally {
    setRuntimeConfigSnapshot({}, {});
  }
});

it.each(["shared.sqlite", "custom.json"])(
  "retains the selected %s store and refuses a route change while queued",
  async (locator) => {
    const storePath = state.path(locator);
    const databasePath = storePath.replace(/\.json$/, ".sqlite");
    const config = { session: { store: storePath } };
    setRuntimeConfigSnapshot(config, config);
    const options = { agentId: "main", path: databasePath, env: state.env };
    const source = openOpenClawAgentDatabase(options);
    const sessionKey = createSession(`route-${locator}`, source);
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let held: Promise<void> | undefined;
    let pending: Promise<unknown> | undefined;
    try {
      await progressCardStore.put(sessionKey, { markdown: "Original store" }, "main");
      held = runOpenClawAgentWorkerWrite(options, async () => {
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      pending = progressCardStore.put(sessionKey, { markdown: "Must not redirect" }, "main");
      const refused = expect(pending).rejects.toThrow("progress-card session changed");
      const redirected = { session: { store: state.path("redirected.sqlite") } };
      setRuntimeConfigSnapshot(redirected, redirected);
      release.resolve();
      await held;
      await refused;
      expect(readSessionProgressCard(source.db, sessionKey)).toMatchObject({
        markdown: "Original store",
        revision: 1,
      });
      expect(existsSync(redirected.session.store)).toBe(false);
    } finally {
      release.resolve();
      await Promise.allSettled([held, pending]);
      setRuntimeConfigSnapshot({}, {});
    }
  },
);

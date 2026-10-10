import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { insertRepositoryGitHubPublicationAsync } from "../gateway/github-publication-request-async.js";
import {
  bindGitHubPublicationSource,
  prepareGitHubPublicationSource,
} from "../gateway/github-publication-source.js";
import { markGitHubPublicationReportedAsync } from "../gateway/github-publication-store-async.js";
import { insertRepositoryGitHubPublicationInDatabase } from "../gateway/github-repository-publication-store.js";
import { repositoryGitHubPublicationDigest } from "../gateway/github-repository-publication.kernel.js";
import type { SqliteWorkerReply } from "../infra/sqlite-worker-contract.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { RepositoryGitHubPublicationRow as RepositoryPublicationRow } from "./github-publication-read.types.js";
import { createGitHubPublicationWorkerScope } from "./github-publication-worker.js";
import type { RepositoryPublicationMutation } from "./github-publication-worker.types.js";
import { closeOpenClawAgentDatabasesAsync } from "./openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "./openclaw-agent-db.paths.js";
import { closeOpenClawStateDatabaseByPathAsync } from "./openclaw-state-db-cache.js";
import { executeExistingOpenClawStateRead } from "./openclaw-state-db-readonly.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "./openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "./openclaw-state-worker-context.types.js";
import { createSessionRepositoryWorkspaceInDatabase } from "./session-repository-workspaces.kernel.js";
import { mutateUserGitHubConnection } from "./user-github-connections.js";
import { disconnectedUserGitHubConnection } from "./user-github-connections.kernel.js";
import { updateUserGitHubConnection } from "./user-github-connections.test-support.js";
import { ensureProfileForEmail } from "./user-profiles.js";

let context: OpenClawStateWorkerContext;
const scopes = new Set<ReturnType<typeof createGitHubPublicationWorkerScope>>();
const heldReplies = new Set<() => void>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseByPathAsync(context.admission.databasePath);
    vi.unstubAllEnvs();
    cleanup();
  }),
);
beforeAll(() => {
  const root = tempDirs.make("openclaw-publication-worker-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const options = {
    path: path.join(root, "openclaw.sqlite"),
    env: { ...process.env, OPENCLAW_STATE_DIR: root },
  };
  openOpenClawStateDatabase(options);
  context = captureOpenClawStateWorkerContext(options);
});
afterEach(async () => {
  for (const release of heldReplies) release();
  vi.restoreAllMocks();
  await Promise.all([...scopes].map((scope) => scope.close()));
  scopes.clear();
});

function createScope() {
  const scope = createGitHubPublicationWorkerScope(context);
  scopes.add(scope);
  return scope;
}
function command(input: RepositoryPublicationMutation) {
  return {
    type: "githubPublications.repository" as const,
    input: {
      ...input,
      operationId: `${input.operation}-${"row" in input ? input.row.request_id : "report"}`,
    },
  };
}
function seed(id: string) {
  const row = repositoryRow(id);
  runOpenClawStateWriteTransaction(
    (database) =>
      insertRepositoryGitHubPublicationInDatabase(database, row, context.admission.assertCurrent),
    { path: context.admission.databasePath },
  );
  return row;
}
function read(row: RepositoryPublicationRow) {
  return executeExistingOpenClawStateRead(
    { path: context.admission.databasePath },
    { type: "githubPublications.repositoryList", input: { idempotencyKey: row.idempotency_key } },
    { context, current: true },
  );
}
function holdNextReply() {
  const ready = createDeferredCore();
  let deliver: (() => void) | undefined;
  // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply preserves the emitting Worker.
  const emit = Worker.prototype.emit;
  const messages = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
    this: Worker,
    event: string | symbol,
    reply: SqliteWorkerReply,
  ) {
    if (event === "message" && reply.ok) {
      messages.mockRestore();
      deliver = () => {
        Reflect.apply(emit, this, [event, reply]);
      };
      ready.resolve();
      return true;
    }
    return Reflect.apply(emit, this, [event, reply]);
  });
  const release = () => {
    const send = deliver;
    deliver = undefined;
    heldReplies.delete(release);
    send?.();
  };
  heldReplies.add(release);
  return { ready: ready.promise, release };
}

function repositoryRow(requestId: string): RepositoryPublicationRow {
  const row: RepositoryPublicationRow = {
    request_id: requestId,
    idempotency_key: requestId,
    request_digest: "",
    requester_authority_json: null,
    session_id: "publication-worker-session",
    session_lifecycle_revision: null,
    session_key: "agent:main:publication-worker",
    agent_id: "main",
    workspace_id: "publication-worker-workspace",
    owner_profile_id: null,
    connection_generation: null,
    identity_source: "system-configured",
    identity_profile_id: "fixture-profile",
    identity_account_id: 42,
    identity_login: "fixture-bot",
    title: null,
    body: null,
    push_repository: "example/repository",
    repository: "example/repository",
    base_branch: "main",
    branch: "openclaw/worker-proof",
    previous_head_commit: null,
    claim_id: null,
    run_id: null,
    environment_id: null,
    owner_epoch: null,
    placement_generation: null,
    checkpoint_ref: "refs/openclaw/worker-results/fixture",
    checkpoint_digest: `sha256:${"a".repeat(64)}`,
    source_head_commit: "b".repeat(40),
    source_index_tree: "c".repeat(40),
    workspace_tree: "c".repeat(40),
    status: "requested",
    execution_id: null,
    gateway_instance_id: null,
    head_commit: null,
    pushed_head_commit: null,
    pull_request_url: null,
    last_effect: null,
    effect_state: null,
    error_code: null,
    next_action: null,
    created_at_ms: 1_000,
    updated_at_ms: 1_000,
    reported_at_ms: null,
  };
  row.request_digest = repositoryGitHubPublicationDigest(row);
  return row;
}

async function sourceFixture(
  requestId: string,
  assertCurrent = () => {},
  personalOwnerProfileId?: string,
) {
  const row = repositoryRow(requestId);
  row.session_id = requestId;
  row.session_key = `agent:main:${requestId}`;
  const result = runOpenClawStateWriteTransaction(
    ({ db }) =>
      createSessionRepositoryWorkspaceInDatabase(
        db,
        {
          agentId: row.agent_id,
          sessionKey: row.session_key,
          url: "https://github.com/example/repository",
          branch: row.branch,
        },
        1000,
      ),
    { path: context.admission.databasePath },
  );
  row.workspace_id = result.workspaceId;
  row.request_digest = repositoryGitHubPublicationDigest(row);
  await upsertSessionEntryCore(
    { agentId: row.agent_id, sessionKey: row.session_key },
    {
      sessionId: row.session_id,
      updatedAt: 1000,
      repositoryWorkspaceId: row.workspace_id,
    },
  );
  const source = await prepareGitHubPublicationSource({
    sourcePath: resolveOpenClawAgentSqlitePath({ agentId: row.agent_id }),
    selector: {
      agentId: row.agent_id,
      sessionKey: row.session_key,
      sessionId: row.session_id,
      lifecycleRevision: null,
      repositoryWorkspaceId: row.workspace_id,
      repositoryBranch: row.branch,
      personalOwnerProfileId,
    },
    signal: new AbortController().signal,
    assertCurrent,
  });
  return { row, source };
}

it("inserts a repository request through its retained session source", async () => {
  const { row, source } = await sourceFixture("source-insert");
  try {
    await expect(insertRepositoryGitHubPublicationAsync(row, source)).resolves.toEqual(row);
    expect(await read(row)).toMatchObject({ ok: true, rows: [row] });
  } finally {
    await source.release();
  }
});

it("revokes personal source authority at commit before reply delivery without reviving restored state", async ({
  signal,
}) => {
  const owner = ensureProfileForEmail("publication-source@example.test").id;
  const original = await mutateUserGitHubConnection(owner, { kind: "disconnect" }, () => {});
  if (!original) throw new Error("Connection fixture missing");
  const { row, source } = await sourceFixture("source-connection-revocation", () => {}, owner);
  try {
    expect(() =>
      runOpenClawStateWriteTransaction(() => {
        updateUserGitHubConnection(owner, disconnectedUserGitHubConnection, () => {});
        throw new Error("rollback connection");
      }),
    ).toThrow("rollback connection");
    expect(() => bindGitHubPublicationSource(source)).not.toThrow();
    const reply = holdNextReply();
    const disconnected = mutateUserGitHubConnection(owner, { kind: "disconnect" }, () => {});
    try {
      await withinTest(
        awaitGateBeforeSettlement(reply.ready, disconnected, "connection reply was not held"),
        signal,
      );
      expect(() => bindGitHubPublicationSource(source)).toThrow("source authority changed");
    } finally {
      reply.release();
      await disconnected;
    }
    updateUserGitHubConnection(
      owner,
      () => original,
      () => {},
    );
    await expect(insertRepositoryGitHubPublicationAsync(row, source)).rejects.toThrow(
      "source authority changed",
    );
    expect(await read(row)).toMatchObject({ ok: true, rows: [] });
  } finally {
    await source.release();
  }
});

it("runs policy writes before source reservation and refuses the changed source", async () => {
  let mutate: (() => void) | undefined;
  const { row, source } = await sourceFixture("source-policy-write", () => {
    const write = mutate;
    mutate = undefined;
    write?.();
  });
  mutate = () =>
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        db.prepare(
          "UPDATE session_repository_workspaces SET revision = revision + 1 WHERE workspace_id = ?",
        ).run(row.workspace_id);
      },
      { path: context.admission.databasePath },
    );
  try {
    await expect(insertRepositoryGitHubPublicationAsync(row, source)).rejects.toThrow(
      "source authority changed",
    );
    expect(await read(row)).toMatchObject({ ok: true, rows: [] });
  } finally {
    await source.release();
  }
});

it("rejects a requested branch that does not belong to the captured source", async () => {
  const { row, source } = await sourceFixture("source-row-mismatch");
  row.branch = "openclaw/unrelated-branch";
  row.request_digest = repositoryGitHubPublicationDigest(row);
  try {
    await expect(insertRepositoryGitHubPublicationAsync(row, source)).rejects.toThrow(
      "requested repository changed",
    );
    expect(await read(row)).toMatchObject({ ok: true, rows: [] });
  } finally {
    await source.release();
  }
});

it("does not use one session's source authority for another session's publication", async () => {
  const first = await sourceFixture("source-session-a");
  const second = await sourceFixture("source-session-b");
  const scope = createScope();
  try {
    await insertRepositoryGitHubPublicationAsync(second.row, second.source);
    const execution = { row: second.row, instanceId: "gateway", executionId: "session-b" };
    await scope.mutate(
      command({ operation: "claim", ...execution }),
      context.admission.assertCurrent,
      () => {},
    );
    await expect(
      scope.mutate(
        command({ operation: "recordEffect", effect: "push", ...execution }),
        context.admission.assertCurrent,
        () => {},
        first.source,
      ),
    ).rejects.toThrow("source");
    expect(await read(second.row)).toMatchObject({ ok: true, rows: [{ last_effect: null }] });
  } finally {
    await first.source.release();
    await second.source.release();
  }
});

it("publishes a committed receipt before a delayed ordinary worker reply", async ({ signal }) => {
  const scope = createScope();
  const row = seed("delayed-reply");
  const reply = holdNextReply();
  const published = vi.fn();
  const claim = scope.mutate(
    command({ operation: "claim", row, instanceId: "gateway", executionId: "execution" }),
    context.admission.assertCurrent,
    published,
  );
  await withinTest(
    awaitGateBeforeSettlement(reply.ready, claim, "claim reply was not held"),
    signal,
  );
  expect(published).toHaveBeenCalledTimes(1);
  expect(published.mock.calls[0]?.[0]).toMatchObject({
    kind: "repository",
    rows: [{ request_id: row.request_id, status: "publishing", execution_id: "execution" }],
  });
  const durable = await read(row);
  expect(durable).toMatchObject({
    ok: true,
    rows: [{ request_id: row.request_id, status: "publishing" }],
  });
  reply.release();
  await expect(claim).resolves.toMatchObject({ rows: [{ status: "publishing" }] });
  await scope.mutate(
    command({
      operation: "complete",
      row,
      instanceId: "gateway",
      executionId: "execution",
      result: {
        requestId: row.request_id,
        status: "failed",
        code: "unavailable",
        message: "Synthetic publication failure",
        nextAction: "Retry publication",
      },
    }),
    context.admission.assertCurrent,
    () => {},
  );
  await expect(
    markGitHubPublicationReportedAsync("repository", row.request_id),
  ).resolves.toBeUndefined();
  expect(await read(row)).toMatchObject({
    ok: true,
    rows: [{ reported_at_ms: expect.any(Number) }],
  });
});

it("records observed effects under execution custody while refusing new effects without source authority", async () => {
  const scope = createScope();
  const row = seed("observed-effect");
  const execution = { row, instanceId: "gateway", executionId: "observed-execution" };
  await scope.mutate(
    command({ operation: "claim", ...execution }),
    context.admission.assertCurrent,
    () => undefined,
  );
  const dispatch = scope.mutate(
    command({ operation: "recordEffect", effect: "push", ...execution }),
    context.admission.assertCurrent,
    () => undefined,
  );
  await expect(dispatch).rejects.toThrow("source");
  await scope.mutate(
    command({
      operation: "recordEffect",
      effect: "push",
      observed: { headCommit: "d".repeat(40) },
      ...execution,
    }),
    context.admission.assertCurrent,
    () => undefined,
  );
  await scope.mutate(
    command({ operation: "interrupt", ...execution }),
    context.admission.assertCurrent,
    () => undefined,
  );
  expect(await read(row)).toMatchObject({
    ok: true,
    rows: [
      {
        status: "requested",
        last_effect: "push",
        effect_state: "observed",
        pushed_head_commit: "d".repeat(40),
      },
    ],
  });
});

it("refuses delayed observation from an execution replaced by a later claim", async () => {
  const scope = createScope();
  const row = seed("replaced-execution");
  const original = { row, instanceId: "gateway", executionId: "original" };
  const receipt = await scope.mutate(
    command({ operation: "claim", ...original }),
    context.admission.assertCurrent,
    () => undefined,
  );
  if (receipt.kind !== "repository" || !receipt.rows[0])
    throw new Error("Repository receipt missing");
  await scope.mutate(
    command({
      operation: "claim",
      row: receipt.rows[0],
      instanceId: "gateway",
      executionId: "replacement",
    }),
    context.admission.assertCurrent,
    () => undefined,
  );
  await expect(
    scope.mutate(
      command({
        operation: "recordEffect",
        effect: "push",
        observed: { headCommit: "e".repeat(40) },
        ...original,
      }),
      context.admission.assertCurrent,
      () => undefined,
    ),
  ).rejects.toThrow("no longer current");
  expect(await read(row)).toMatchObject({
    ok: true,
    rows: [{ execution_id: "replacement", pushed_head_commit: null }],
  });
});

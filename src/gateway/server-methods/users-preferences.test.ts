import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { GatewayErrorDetailCodes } from "../../../packages/gateway-protocol/src/index.js";
import { withinTest } from "../../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { withGatewayPersonalToolUser } from "../../agents/tools/gateway-caller-context.js";
import { withPersonalToolTurn } from "../../auto-reply/reply/personal-tool-turn.test-support.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import type { SqliteWorkerReply, SqliteWorkerRequest } from "../../infra/sqlite-worker-contract.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as stateRead from "../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { executeOpenClawStateWorker } from "../../state/openclaw-state-worker-store.js";
import * as preferences from "../../state/user-preferences.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { linkEmail, mergeProfiles, setAvatar } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareGatewayRecipientProfile } from "../expected-profile.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodRegistry,
} from "../methods/registry.js";
import { createGatewayBroadcaster } from "../server-broadcast.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../server-methods.js";
import {
  dispatchGatewayMethodInProcess,
  withOperatorToolGatewayAuthority,
} from "../server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import { GatewayClientRegistry } from "../server/client-registry.js";
import { createGatewayWsTestSocket } from "../server/ws-connection.test-helpers.js";
import { createOperatorWsClient } from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import type { GatewayClient, GatewayRequestHandler } from "./types.js";
import { usersHandlers } from "./users.js";

async function invokePrefs(
  method: "get" | "set",
  params: Record<string, unknown>,
  profileId?: string,
  context: Record<string, unknown> = {},
) {
  const respond = vi.fn();
  await usersHandlers[`users.prefs.${method}`]!({
    req: {} as never,
    params,
    respond,
    context: context as never,
    client: {
      connect: { scopes: ["operator.admin"] },
      ...(profileId ? { authenticatedUserProfile: { profileId } } : {}),
    } as never,
    isWebchatConnect: () => false,
  });
  expect(respond).toHaveBeenCalledOnce();
  return respond.mock.calls[0];
}

let cleanupState: (() => Promise<void>) | undefined;
const profileReleases: (() => void)[] = [];
beforeEach(async () => {
  const state = await createOpenClawTestState({ layout: "state-only", prefix: "users-prefs-" });
  cleanupState = state.cleanup;
});
afterEach(async () => {
  try {
    for (const release of profileReleases.splice(0)) {
      release();
    }
    await cleanupState?.();
  } finally {
    cleanupState = undefined;
    closeOpenClawStateDatabaseForTest();
  }
});

async function prepareProfiles() {
  profileReleases.push((await prepareUserProfileCatalog()).release);
}

function attachProfile(client: GatewayClient, profileId: string, updatedAt = 1, hasAvatar = false) {
  client.authenticatedUserProfile = {
    profileId,
    displayName: null,
    avatarRevision: "",
    hasAvatar,
    updatedAt,
  };
  prepareGatewayRecipientProfile(client);
}

function profileClient(profile: ReturnType<typeof makeProfile>, scopes: string[]) {
  const client = createOperatorWsClient({ connId: profile.id, scopes });
  attachProfile(client, profile.id, profile.updatedAt);
  return client;
}

function dispatch(
  client: GatewayClient,
  method: string,
  params: Record<string, unknown> = {},
  context = createDirectChatContext(),
  hasCurrentClientAuthority?: () => boolean,
) {
  const respond = vi.fn();
  const request = handleGatewayRequest({
    req: { type: "req", id: method, method, params },
    client,
    context,
    respond,
    hasCurrentClientAuthority,
    isWebchatConnect: () => false,
    extraHandlers: usersHandlers,
  });
  return { respond, request };
}

const response = (status: string, entries?: Record<string, unknown>) => [
  true,
  { status, ...(entries ? { entries } : {}) },
  undefined,
];
const ok = (entries?: Record<string, unknown>) => response("ok", entries);
const authorityChanged = {
  code: "FORBIDDEN",
  message: "Gateway requester authority changed",
};
const denied = (detail: Record<string, unknown>) => [
  false,
  undefined,
  expect.objectContaining(detail),
];
const fulfilled = [{ status: "fulfilled", value: undefined }];
const initialTheme = { "ui.theme": "claw" };
const darkTheme = { "ui.theme": "dark" };
const makeProfile = (name: string) => ensureProfileForEmail(`${name}@example.test`);

function pauseOperation() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  return {
    block: async () => {
      entered.resolve();
      await release.promise;
    },
    during: async (pending: Promise<unknown>, action: () => void | Promise<void>) => {
      const outcome = Promise.allSettled([pending]);
      try {
        await Promise.race([entered.promise, pending]);
        await action();
      } finally {
        release.resolve();
        await outcome;
      }
      return outcome;
    },
  };
}

function atCommit(action: () => void) {
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  const reached = vi.fn(action);
  const spy = vi.spyOn(workerAdmission, "createSqliteWorkerOperationAdmission");
  spy.mockImplementation((admit, attachment) =>
    createAdmission((request, grant) => {
      if (request.stage === "commit") {
        reached();
      }
      admit(request, grant);
    }, attachment),
  );
  return Object.assign(spy, { reached });
}

test("users.prefs returns updated preferences when a write commits before read delivery", async () => {
  const profileId = makeProfile("reader").id;
  await preferences.setCanonicalUserPreferences(profileId, { "ui.accent": "#112233" });
  const executeRead = stateRead.executeExistingOpenClawStateRead;
  using read = vi.spyOn(stateRead, "executeExistingOpenClawStateRead");
  read.mockImplementationOnce(async (readOptions, command, scope) => {
    const reply = await executeRead(readOptions, command, scope);
    await preferences.setCanonicalUserPreferences(profileId, { "ui.accent": "#aabbcc" });
    return reply;
  });

  expect(await invokePrefs("get", { keys: ["ui.accent"] }, profileId)).toEqual(
    ok({ "ui.accent": "#aabbcc" }),
  );
});

test("users.prefs reads merged-profile accents while an unrelated writer reply is pending", async ({
  signal,
}) => {
  const source = makeProfile("source").id;
  const target = makeProfile("target").id;
  await preferences.setCanonicalUserPreferences(source, {
    "ui.accent": "#a1b2c3",
    other: "excluded",
  });
  mergeProfiles(source, target);
  const context = captureOpenClawStateWorkerContext();
  const readWriterObservation = () =>
    executeOpenClawStateWorker(context, {
      type: "deviceAuth.read",
      input: { deviceId: "preference-reader-test", role: "operator", readOnly: false },
    });
  await readWriterObservation();
  const replyReady = createDeferredCore();
  let publish: (() => void) | undefined;
  let selected: { worker: Worker; id: number } | undefined;
  // oxlint-disable-next-line typescript/unbound-method -- Forward with the intercepted worker receiver.
  const originalPost = Worker.prototype.postMessage;
  // oxlint-disable-next-line typescript/unbound-method -- Forward with the intercepted worker receiver.
  const originalEmit = Worker.prototype.emit;
  const requests = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
    this: Worker,
    request: SqliteWorkerRequest,
    transferList,
  ) {
    if (request.type === "execute") {
      const command: unknown = deserialize(request.input);
      if (
        isRecord(command) &&
        command.type === "deviceAuth.read" &&
        isRecord(command.input) &&
        command.input.deviceId === "preference-reader-test"
      ) {
        selected = { worker: this, id: request.id };
      }
    }
    return originalPost.call(this, request, transferList);
  });
  const replies = vi.spyOn(Worker.prototype, "emit").mockImplementation(function (
    this: Worker,
    event: string | symbol,
    reply: SqliteWorkerReply,
  ) {
    if (event === "message" && this === selected?.worker && reply.id === selected.id) {
      publish = () => originalEmit.call(this, event, reply);
      replyReady.resolve();
      return true;
    }
    return originalEmit.call(this, event, reply);
  });
  const pendingWriter = readWriterObservation();
  try {
    await withinTest(replyReady.promise, signal);
    expect(await withinTest(invokePrefs("get", { keys: ["ui.accent"] }, source), signal)).toEqual(
      ok({ "ui.accent": "#a1b2c3" }),
    );
  } finally {
    replies.mockRestore();
    requests.mockRestore();
    publish?.();
    await pendingWriter;
  }
});

async function withPreferenceToolTurn(
  run: (params: {
    ownerId: string;
    steer: () => Promise<void>;
    revoke: () => void;
    get: () => Promise<unknown>;
    set: (entries: Record<string, unknown>) => Promise<unknown>;
  }) => Promise<void>,
) {
  const owner = makeProfile("prefs-owner");
  const guest = makeProfile("prefs-guest");
  const scopes = ["operator.read", "operator.write"];
  const client = createOperatorClient({ profileId: owner.id, scopes });
  const context = createContext();
  const handle: GatewayRequestHandler = (options) => {
    expect(options.client).toMatchObject({
      internal: { syntheticClient: true },
      authenticatedUserProfile: { profileId: owner.id },
    });
    return usersHandlers[options.req.method]!(options);
  };
  const descriptors = createCoreGatewayMethodDescriptors({
    "users.prefs.get": handle,
    "users.prefs.set": handle,
  });
  context.getGatewayMethodRegistry = () => createGatewayMethodRegistry(descriptors);
  const request = (method: string, params = {}) =>
    dispatchGatewayMethodInProcess(method, params, {
      forceSyntheticClient: true,
      resolveGatewayContext: () => context,
    });
  await withOperatorToolGatewayAuthority(
    { authenticatedUserProfile: client.authenticatedUserProfile!, scopes },
    () =>
      withPersonalToolTurn(
        { owner: { profileId: owner.id, senderId: "owner", name: "Owner" } },
        (turn) =>
          run({
            ownerId: owner.id,
            steer: async () => {
              expect(
                await turn.steer({ profileId: guest.id, senderId: "guest", name: "Guest" }),
              ).toMatchObject({ status: "accepted" });
            },
            revoke: () => turn.revoke(owner.id),
            get: () => request("users.prefs.get"),
            set: (entries) => request("users.prefs.set", { entries }),
          }),
      ),
  );
}

test("users.prefs rejects mixed-person synthetic turn calls before reading or writing preferences", async () => {
  await withPreferenceToolTurn(async ({ ownerId, steer, get, set }) => {
    await expect(set(initialTheme)).resolves.toEqual({ status: "ok" });
    await expect(get()).resolves.toEqual({ status: "ok", entries: initialTheme });
    await steer();
    using read = vi.spyOn(preferences, "getCanonicalUserPreferences");
    using write = vi.spyOn(preferences, "setCanonicalUserPreferences");
    await withGatewayPersonalToolUser(ownerId, async () => {
      await expect(get()).rejects.toThrow(/own Control UI turn/i);
      await expect(set(darkTheme)).rejects.toThrow(/own Control UI turn/i);
    });
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

test.each(["read", "write"] as const)(
  "users.prefs rejects a steer accepted while the personal %s is pending",
  async (operation) => {
    await withPreferenceToolTurn(async ({ ownerId, steer, get, set }) => {
      await set(initialTheme);
      const pause = pauseOperation();
      const readPreferences = preferences.getCanonicalUserPreferences;
      const writePreferences = preferences.setCanonicalUserPreferences;
      using read = vi.spyOn(preferences, "getCanonicalUserPreferences");
      using write = vi.spyOn(preferences, "setCanonicalUserPreferences");
      if (operation === "read") {
        read.mockImplementationOnce(async (...args) => {
          const result = await readPreferences(...args);
          await pause.block();
          return result;
        });
      } else {
        write.mockImplementationOnce(async (...args) => {
          await pause.block();
          return writePreferences(...args);
        });
      }
      const pending = operation === "read" ? get() : set(darkTheme);
      const outcome = await pause.during(pending, async () => {
        expect(operation === "read" ? read : write).toHaveBeenCalledOnce();
        await steer();
      });
      expect(outcome).toMatchObject([
        { status: "rejected", reason: { message: expect.stringMatching(/own Control UI turn/i) } },
      ]);
      expect(await readPreferences(ownerId)).toMatchObject({ entries: initialTheme });
    });
  },
);

test("users.prefs refuses a pending write when the participant is revoked before worker commit", async () => {
  await withPreferenceToolTurn(async ({ ownerId, revoke, set }) => {
    await set(initialTheme);
    using admission = atCommit(revoke);
    await expect(set(darkTheme)).rejects.toThrow();
    expect(admission.reached).toHaveBeenCalled();
    expect(await preferences.getCanonicalUserPreferences(ownerId)).toMatchObject({
      entries: initialTheme,
    });
  });
});

test.each(["current", "read", "scope", "source", "identity", "error-response", "staff"] as const)(
  "users.self keeps its original %s authority through the handler's identity sync",
  async (change) => {
    setRuntimeConfigSnapshot({});
    const owner = makeProfile("self-reader");
    const replacement = makeProfile("other-reader");
    await prepareProfiles();
    const client = createOperatorWsClient({
      connId: "self-reader",
      scopes: [
        change === "staff" || change === "read" ? "operator.read" : "operator.sessions.read",
      ],
    });
    client.authenticatedUserId = "self-reader@github";
    const attach = (profile: typeof owner) => attachProfile(client, profile.id, profile.updatedAt);
    if (change === "staff") {
      attach(owner);
    }
    const pause = pauseOperation();
    let syncCount = 0;
    const sync = vi.fn(async () => {
      syncCount += 1;
      if (change !== "staff" && syncCount === 1) {
        attach(owner);
      } else {
        await pause.block();
      }
      return { profileId: owner.id, updatedAt: owner.updatedAt };
    });
    client.authenticatedGitHubIdentitySync = sync;
    let current = true;
    const { respond, request } = dispatch(client, "users.self", {}, undefined, () => current);
    const outcome = await pause.during(request, () => {
      expect(sync).toHaveBeenCalledTimes(change === "staff" ? 1 : 2);
      expect(respond).not.toHaveBeenCalled();
      if (change === "scope") {
        client.connect.scopes = [];
      } else if (change === "source") {
        current = false;
      } else if (change === "identity") {
        attach(replacement);
      } else if (change === "error-response") {
        client.authenticatedUserProfile = undefined;
      }
    });
    if (change === "source") {
      expect(outcome).toMatchObject([
        { status: "rejected", reason: { message: authorityChanged.message } },
      ]);
      expect(respond).not.toHaveBeenCalled();
    } else {
      expect(outcome).toEqual(fulfilled);
      if (change === "current" || change === "read" || change === "staff") {
        expect(respond).toHaveBeenCalledExactlyOnceWith(true, {
          profile: expect.objectContaining({ id: owner.id }),
        });
      } else {
        expect(respond.mock.calls).toEqual([denied(authorityChanged)]);
      }
    }
  },
);

test("users.prefs.get retains its original scope across the preference read", async () => {
  setRuntimeConfigSnapshot({});
  const owner = makeProfile("retained-preferences");
  await prepareProfiles();
  await invokePrefs("set", { entries: darkTheme }, owner.id);
  const client = profileClient(owner, ["operator.sessions.read"]);
  const pause = pauseOperation();
  const original = preferences.getCanonicalUserPreferences;
  using read = vi
    .spyOn(preferences, "getCanonicalUserPreferences")
    .mockImplementation(async (...args) => {
      const result = await original(...args);
      await pause.block();
      return result;
    });
  const { respond, request } = dispatch(client, "users.prefs.get");
  const outcome = await pause.during(request, () => {
    expect(read).toHaveBeenCalledOnce();
    client.connect.scopes = [];
  });
  expect(outcome).toEqual(fulfilled);
  expect(respond.mock.calls).toEqual([denied(authorityChanged)]);
  expect(await original(owner.id)).toMatchObject({ entries: darkTheme });
});

test("users.prefs dispatch saves guest choices only to the authenticated durable profile", async () => {
  const ada = makeProfile("ada");
  const grace = makeProfile("grace");
  await prepareProfiles();
  const clients = [ada, grace].map((profile) =>
    profileClient(profile, ["operator.sessions.read", "operator.sessions.write"]),
  );
  const adaClient = clients[0]!;
  const graceClient = clients[1]!;
  const context = createDirectChatContext({
    getRuntimeConfig: () => ({}),
    getClientConnIds: (filter) =>
      new Set(clients.filter((client) => !filter || filter(client)).map((client) => client.connId)),
    broadcastToConnIds: vi.fn(),
  });
  const request = async (
    method: string,
    params: Record<string, unknown> = {},
    client = adaClient,
  ) => {
    const { respond, request: pending } = dispatch(client, method, params, context);
    await pending;
    expect(respond).toHaveBeenCalledOnce();
    return respond.mock.calls[0];
  };
  const key = "new-session.v1:main";
  const choice = { folder: "/projects/openclaw", worktree: true };
  const selected = { [key]: choice };
  const updated = { [key]: { ...choice, worktreeName: "focused-fix" } };
  const set = (entries: Record<string, unknown>, expectedEntries?: Record<string, unknown>) =>
    request("users.prefs.set", { entries, ...(expectedEntries ? { expectedEntries } : {}) });
  const get = (client = adaClient) => request("users.prefs.get", {}, client);
  using prepare = vi.spyOn(requireNodeSqlite().DatabaseSync.prototype, "prepare");
  expect(await set(selected)).toEqual(ok());
  expect(await get()).toEqual(ok(selected));
  expect(await get(graceClient)).toEqual(ok({}));
  expect(await set({ [key]: { folder: "/stale" } }, { [key]: null })).toEqual(response("conflict"));
  expect(await set(updated, selected)).toEqual(ok());
  expect(prepare).not.toHaveBeenCalled();
  prepare.mockRestore();

  expect(
    await request("users.prefs.set", {
      profileId: grace.id,
      entries: { [key]: { folder: "/other" } },
    }),
  ).toEqual(denied({ code: "INVALID_REQUEST" }));
  expect(await set({ "ui.background": null, [key]: null })).toEqual(
    denied({ message: expect.stringContaining("required profile scope") }),
  );
  for (const [method, scope] of [
    ["themes.set", "operator.write"],
    ["users.setRole", "operator.admin"],
  ] as const) {
    expect(await request(method)).toEqual(denied({ message: `missing scope: ${scope}` }));
  }
  expect(await get(graceClient)).toEqual(ok({}));
  using admission = atCommit(() => {
    adaClient.connect.scopes = [];
  });
  expect(await set({ [key]: { folder: "/revoked" } })).toEqual(denied({ code: "FORBIDDEN" }));
  expect(admission.reached).toHaveBeenCalled();
  expect(await preferences.getCanonicalUserPreferences(ada.id)).toMatchObject({
    entries: updated,
  });
  admission.mockRestore();
  linkEmail("ada@example.test", grace.id);
  expect(await get(graceClient)).toEqual(ok(updated));
});

test("users.prefs returns a typed result without a durable identity", async () => {
  const context = { broadcastToConnIds: vi.fn(), getClientConnIds: vi.fn() };
  for (const method of ["get", "set"] as const) {
    const params = method === "get" ? {} : { entries: { theme: "claw" } };
    expect(await invokePrefs(method, params, undefined, context)).toEqual(
      response("no_durable_identity"),
    );
  }
  expect(context.getClientConnIds).not.toHaveBeenCalled();
  expect(context.broadcastToConnIds).not.toHaveBeenCalled();
});

test("users.prefs.set notifies only the current merged profile without main-thread profile reads", async () => {
  const retired = makeProfile("retired");
  const owner = makeProfile("owner");
  const other = makeProfile("other");
  const avatar = new Uint8Array(64 * 1024).fill(0x7f);
  for (const profile of [retired, owner, other]) {
    expect(setAvatar(profile.id, avatar, "image/png").ok).toBe(true);
  }
  await prepareProfiles();
  linkEmail("retired@example.test", owner.id);

  const peers = [
    ["owner", owner.id, ["operator.sessions.read"]],
    ["merged", retired.id, ["operator.sessions.write"]],
    ["staff", owner.id, ["operator.write"]],
    ["other", other.id, ["operator.sessions.read"]],
    ["unbound", undefined, ["operator.sessions.read"]],
  ] as const;
  const connected = peers.map(([connId, profileId, scopes]) => {
    const frames: string[] = [];
    const socket = createGatewayWsTestSocket({ onSend: (data) => frames.push(data) });
    const client = createOperatorWsClient({ connId, socket, scopes: [...scopes] });
    if (profileId) {
      attachProfile(client, profileId, 1, true);
    } else {
      prepareGatewayRecipientProfile(client);
    }
    return { client, frames };
  });
  const clients = new GatewayClientRegistry(connected.map(({ client }) => client));
  const broadcaster = createGatewayBroadcaster({ clients });
  const broadcastToConnIds = vi.fn(broadcaster.broadcastToConnIds);
  const context = {
    broadcastToConnIds,
    getClientConnIds: (filter: (client: GatewayClient) => boolean) =>
      new Set([...clients].filter(filter).map((client) => client.connId)),
  };

  // Measure recipient selection on this handle; the preference worker has its own connection.
  const reads = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(openOpenClawStateDatabase().db),
    ["profiles"],
    (sql) =>
      /^select\b/i.test(sql) && /\bfrom "user_profiles"(?:\s|$)/i.test(sql) ? "profiles" : null,
  );
  try {
    expect(
      await invokePrefs(
        "set",
        { entries: { "ui.accent": "#A1B2C3", "ui.theme": null } },
        retired.id,
        context,
      ),
    ).toEqual(ok());
    expect(broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
      "users.prefs.changed",
      { profileId: owner.id, keys: ["ui.accent", "ui.theme"] },
      new Set(["owner", "merged", "staff"]),
    );
    const changed = expect.objectContaining({
      type: "event",
      event: "users.prefs.changed",
      payload: expect.objectContaining({ profileId: owner.id, keys: ["ui.accent", "ui.theme"] }),
    });
    for (const { client, frames } of connected) {
      expect(frames.map((frame) => JSON.parse(frame))).toEqual(
        ["owner", "merged", "staff"].includes(client.connId) ? [changed] : [],
      );
    }
    expect(reads.counts.profiles).toBe(0);
    expect.soft(reads.blobBytes.profiles).toBe(0);
  } finally {
    reads.restore();
  }
});

test("users.prefs.set returns typed profile quota details", async () => {
  const owner = makeProfile("quota");
  for (let start = 0; start < 128; start += 32) {
    const entries = Object.fromEntries(
      Array.from({ length: 32 }, (_, index) => [`key-${start + index}`, true]),
    );
    expect(await invokePrefs("set", { entries }, owner.id)).toEqual(ok());
  }

  expect(await invokePrefs("set", { entries: { "key-128": true } }, owner.id)).toEqual(
    denied({
      code: "INVALID_REQUEST",
      details: {
        code: GatewayErrorDetailCodes.USER_PREFS_LIMIT_EXCEEDED,
        limit: 128,
        currentCount: 128,
      },
    }),
  );
});

test("users.prefs.set compares canonical preferences atomically and publishes only committed writes", async () => {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "users-prefs-conditional-",
  });
  let releaseProfiles: (() => void) | undefined;
  try {
    const retired = ensureProfileForEmail("conditional-retired@example.test");
    const owner = ensureProfileForEmail("conditional-owner@example.test");
    releaseProfiles = (await prepareUserProfileCatalog()).release;
    const original = {
      selection: { folder: "/new", model: "new", nested: [1, { a: 2, b: 3 }] },
      removed: true,
    };
    expect(
      await invokePreferenceMethod("users.prefs.set", { entries: original }, owner.id),
    ).toMatchObject({
      ok: true,
      payload: { status: "ok" },
    });
    linkEmail("conditional-retired@example.test", owner.id);
    const context = {
      broadcastToConnIds: vi.fn(),
      getClientConnIds: vi.fn(() => new Set(["owner"])),
    };
    for (const entries of [{ removed: null, inserted: true }, {}]) {
      expect(
        await invokePreferenceMethod(
          "users.prefs.set",
          {
            entries,
            expectedEntries: { selection: { folder: "/old" } },
          },
          retired.id,
          context,
        ),
      ).toEqual({ ok: true, payload: { status: "conflict" }, error: undefined });
    }
    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
    expect(context.getClientConnIds).not.toHaveBeenCalled();
    expect(await invokePreferenceMethod("users.prefs.get", {}, owner.id)).toMatchObject({
      payload: { status: "ok", entries: original },
    });
    expect(
      await invokePreferenceMethod(
        "users.prefs.set",
        {
          entries: { removed: null, inserted: true },
          expectedEntries: {
            selection: { nested: [1, { b: 3, a: 2 }], model: "new", folder: "/new" },
            inserted: null,
          },
        },
        retired.id,
        context,
      ),
    ).toEqual({ ok: true, payload: { status: "ok" }, error: undefined });
    expect(context.broadcastToConnIds).toHaveBeenCalledExactlyOnceWith(
      "users.prefs.changed",
      { profileId: owner.id, keys: ["removed", "inserted"] },
      new Set(["owner"]),
    );
    expect(await invokePreferenceMethod("users.prefs.get", {}, owner.id)).toMatchObject({
      payload: { status: "ok", entries: { selection: original.selection, inserted: true } },
    });
  } finally {
    releaseProfiles?.();
    await state.cleanup();
  }
});

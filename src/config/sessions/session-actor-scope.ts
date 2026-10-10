import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { prepareSqliteScope, toDatabaseOptions } from "./session-accessor.sqlite-scope.js";
import type { SessionEntryReadScope } from "./session-accessor.types.js";
import type {
  SessionActor,
  SessionActorAuthority,
  SessionActorHotState,
  SessionActorLifetime,
  SessionActorOutcome,
} from "./session-actor-contract.js";
import { createDurableSessionActorFactory } from "./session-actor-durable.js";
import { captureIncognitoSessionSource } from "./session-incognito-binding.js";

/** Reprepare only an explicitly refused version, never an uncertain accepted write. */
export async function runSessionActorCommand<Value>(
  actor: SessionActor,
  authority: SessionActorAuthority,
  command: (snapshot: SessionActorHotState) => Promise<SessionActorOutcome<Value>>,
): Promise<SessionActorOutcome<Value>> {
  for (let attempt = 0; ; attempt++) {
    const snapshot = actor.snapshot(authority) ?? (await actor.read(authority));
    const outcome = await command(snapshot);
    if (outcome.kind !== "rolled-back" || outcome.reason !== "stale-version" || attempt >= 3) {
      return outcome;
    }
  }
}

/** Retain the captured physical writer, never reselect a target after an accepted command. */
export async function withSessionActor<T>(
  input: SessionEntryReadScope,
  lifetime: SessionActorLifetime,
  consume: (actor: SessionActor) => Promise<T>,
): Promise<T | undefined> {
  lifetime.assertCurrent();
  const source = captureIncognitoSessionSource(input);
  if (source && "kind" in source) return undefined;
  if (source) {
    const execution = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: source.actor.agentId,
      env: { OPENCLAW_STATE_DIR: path.resolve(source.actor.path, "../../../..") },
      authority: {
        assertCurrent() {
          lifetime.assertCurrent();
          source.actor.assertCurrent();
        },
      },
      existingOnly: true,
      signal: source.admissionSignal,
    });
    if (!execution) return undefined;
    try {
      if (!isDeepStrictEqual(execution.identity, source.actor.identity)) {
        throw new Error("Session actor acquisition changed its incognito owner");
      }
      const actor = await execution.sessionActors.acquire(
        { database: source.actor.identity, sessionKey: input.sessionKey },
        lifetime,
      );
      try {
        return await consume(actor);
      } finally {
        await actor.release();
      }
    } finally {
      await execution.release();
    }
  }
  const scope = await prepareSqliteScope(input);
  lifetime.assertCurrent();
  const options = toDatabaseOptions(scope);
  const identity = readDatabasePathIdentitySync(resolveOpenClawAgentSqlitePath(options));
  if (!identity.key.startsWith("file:")) return undefined;
  const actor = await createDurableSessionActorFactory({
    ...options,
    path: identity.canonicalPath,
  }).acquire(
    {
      database: {
        kind: "file",
        physicalIdentity: identity.key.slice("file:".length),
        birthtime: identity.birthtime,
        nativeLocation: identity.canonicalPath,
      },
      sessionKey: scope.sessionKey,
    },
    lifetime,
  );
  try {
    return await consume(actor);
  } finally {
    await actor.release();
  }
}

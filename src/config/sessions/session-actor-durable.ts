import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { withSessionEntryWorker } from "./session-accessor.sqlite-replacement-worker.js";
import type {
  SessionActor,
  SessionActorFactory,
  SessionActorLifetime,
  SessionActorTarget,
} from "./session-actor-contract.js";
import { createSessionActorReplica } from "./session-actor-replica.js";
import { createSessionActor } from "./session-actor.js";

/** Capture once; every command borrows the existing physical writer admission. */
export function captureDurableSessionActor(params: {
  database: OpenClawAgentDatabaseOptions & { path: string };
  target: SessionActorTarget & {
    database: Extract<SessionActorTarget["database"], { kind: "file" }>;
  };
  lifetime: SessionActorLifetime;
}): SessionActor {
  const database = {
    ...params.database,
    env: Object.freeze({ ...(params.database.env ?? process.env) }),
  };
  const execution = captureOpenClawAgentDatabaseExecution(database, {
    expectedIdentity: params.target.database,
  });
  const lifetime = {
    assertCurrent() {
      params.lifetime.assertCurrent();
      execution.assertCurrent();
    },
    assertReadable() {
      params.lifetime.assertReadable();
      execution.assertCurrent();
    },
  };
  return createSessionActor({
    target: params.target,
    lifetime,
    replica: createSessionActorReplica({ target: params.target, lifetime }),
    transport: {
      run: (operation, authorize) =>
        withSessionEntryWorker(
          database,
          execution.fileIdentity?.physicalIdentity,
          lifetime.assertCurrent,
          async (_execution, source) => {
            await execution.prepare(source);
            return operation({
              captureGeneration: () => execution.captureGenerationClaim(),
              async execute(command) {
                const result = await execution.runExisting(source, (worker) =>
                  worker.execute(command),
                );
                if (result === undefined) {
                  throw new Error("Session actor database disappeared");
                }
                return result;
              },
            });
          },
          undefined,
          execution,
          undefined,
          undefined,
          undefined,
          (admission, retained, request, grant) => {
            authorize(request, { admission, retained }, grant);
            return true;
          },
        ),
      release: () => execution.release(),
    },
  });
}

export function createDurableSessionActorFactory(
  database: OpenClawAgentDatabaseOptions & { path: string },
): SessionActorFactory {
  return {
    async acquire(target, lifetime) {
      if (target.database.kind !== "file") {
        throw new Error("Durable session actors require an exact file target");
      }
      lifetime.assertCurrent();
      return captureDurableSessionActor({
        database,
        target: { sessionKey: target.sessionKey, database: target.database },
        lifetime,
      });
    },
  };
}

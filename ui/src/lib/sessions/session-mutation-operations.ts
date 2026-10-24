import type { SessionConnectionOwner, SessionConnectionScope } from "./session-types.ts";

export type SessionMutationOperations = Pick<
  typeof import("./session-mutation-operations.runtime.ts"),
  | "prepareSessionPatch"
  | "prepareSessionDelete"
  | "patchSessionBatch"
  | "createSessionResult"
  | "projectSessionPatchRowFields"
>;

export type PreparedSessionMutation = {
  admit: () => void;
  run: (scope: SessionConnectionScope) => Promise<void>;
  discard?: () => void;
};

let runtime: SessionMutationOperations | undefined;

/** Interaction runtimes prepare this code before admitting synchronous row intents. */
export function registerSessionMutationOperations(value: SessionMutationOperations): void {
  runtime = value;
}

export function withSessionMutationOperations<T>(run: (value: SessionMutationOperations) => T) {
  return runtime ? run(runtime) : import("./session-mutation-operations.runtime.ts").then(run);
}

export function prepareSessionDeferredMutation(
  prepare: (runtime: SessionMutationOperations) => PreparedSessionMutation,
  connection: SessionConnectionOwner,
  onDiscard?: () => void,
) {
  let prepared = runtime ? prepare(runtime) : undefined;
  let discarded = false;
  const discard = () => {
    discarded = true;
    prepared?.discard?.();
    onDiscard?.();
  };
  let ready: Promise<void> | undefined;
  const initialize = () => {
    if (prepared || discarded) {
      return undefined;
    }
    return (ready ??= Promise.resolve(
      withSessionMutationOperations((value) => {
        // Admission is synchronous; coalescing can retire the intent before this chunk arrives.
        if (!discarded) {
          prepared = prepare(value);
          prepared.admit();
        }
      }),
    ).catch((error: unknown) => {
      discard();
      throw error;
    }));
  };
  return {
    discard,
    admit() {
      prepared?.admit();
      return initialize();
    },
    run(this: void): Promise<void> {
      const scope = connection.capture();
      const run = () => {
        if (!scope || !connection.isCurrent(scope)) {
          discard();
          return Promise.resolve();
        }
        return !discarded && prepared ? prepared.run(scope) : Promise.resolve();
      };
      const initialization = initialize();
      return initialization ? initialization.then(run) : run();
    },
  };
}

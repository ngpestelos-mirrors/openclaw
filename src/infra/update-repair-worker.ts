import { spawn } from "node:child_process";
import path from "node:path";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { createCommandTerminationController } from "../process/exec-termination.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { updateRepairEnvironment } from "./update-repair-environment.js";
import {
  UPDATE_REPAIR_IPC_MAX_BYTES,
  updateRepairBudgetSchema,
  updateRepairParentMessageSchema,
  updateRepairWorkerMessageSchema,
  type UpdateRepairParentMessage,
  type UpdateRepairParams,
  type UpdateRepairResult,
  type UpdateRepairValidation,
} from "./update-repair-protocol.js";

/** Loaded before replacement; inference imports belong entirely to the candidate child. */
export async function runUpdateRepairWorker(
  params: UpdateRepairParams,
): Promise<UpdateRepairResult> {
  const attempts: UpdateRepairResult["attempts"] = [];
  let finalValidation: UpdateRepairValidation = {
    ok: false,
    score: 0,
    summary: "Automatic repair did not finish checking the installation.",
  };
  const clean = (value: unknown) =>
    redactSupportString(
      value instanceof Error ? value.message : String(value),
      { env: process.env, stateDir: params.target.stateDir },
      { maxLength: 1024 },
    );
  const stopped = (status: "unavailable" | "aborted", reason: string): UpdateRepairResult => {
    params.onEvent?.({ type: "stopped", status, reason });
    return { status, attempts, finalValidation, reason };
  };
  if (params.isCurrent && !params.runId) {
    return stopped(
      "unavailable",
      "Automatic repair could not confirm the active update. Run openclaw triage.",
    );
  }
  const parsedBudget = updateRepairBudgetSchema.safeParse(params.budget ?? {});
  if (!parsedBudget.success) {
    return stopped("aborted", "Invalid repair budget.");
  }
  const budget = parsedBudget.data;
  const deadline = Date.now() + budget.wallClockMs;
  const controller = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([controller.signal, params.signal])
    : controller.signal;
  const assertCurrent = () => {
    signal.throwIfAborted();
    if (params.isCurrent?.() === false) {
      throw new Error("Repair no longer owns the update attempt.");
    }
  };
  try {
    assertCurrent();
  } catch (error) {
    return stopped("aborted", clean(error));
  }
  const timer = setTimeout(
    () => controller.abort(new Error("wall-clock-budget")),
    budget.wallClockMs,
  );
  const env = { ...updateRepairEnvironment(params.target), NODE_DISABLE_COMPILE_CACHE: "1" };
  const installRoot = params.target.candidateRoot ?? params.target.installRoot;
  let child;
  try {
    child = spawn(
      params.nodeRunner ?? process.execPath,
      [path.join(installRoot, "dist", runtimeProcessEntrypoints.updateRepair.distWorkerPath)],
      {
        cwd: installRoot,
        env,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
  } catch (error) {
    clearTimeout(timer);
    return stopped("unavailable", clean(error));
  }
  let childExited = false;
  let commandSettled = false;
  let result: UpdateRepairResult | undefined;
  let failure: string | undefined;
  let stopping = false;
  let started = false;
  let requestId = 0;
  let pending: { id: number; controller: AbortController; promise: Promise<void> } | undefined;
  const cancelController = new AbortController();
  const termination = createCommandTerminationController({
    child,
    cancelController,
    env,
    processTree: { mode: "graceful" },
    killGraceMs: 1_000,
    isChildExited: () => childExited,
    isCommandSettled: () => commandSettled,
  });
  cancelController.signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
  const stop = (error: unknown) => {
    if (stopping) {
      return;
    }
    stopping = true;
    failure ??= clean(error);
    pending?.controller.abort(error);
    if (!termination.terminate()) {
      cancelController.abort();
    }
  };
  const send = (message: UpdateRepairParentMessage) => {
    if (!child.connected) {
      stop(new Error("The repair process disconnected before finishing."));
      return;
    }
    if (Buffer.byteLength(JSON.stringify(message)) > UPDATE_REPAIR_IPC_MAX_BYTES) {
      stop(new Error("The repair request was too large."));
      return;
    }
    child.send(message, (error) => {
      if (error) {
        stop(error);
      }
    });
  };
  const onAbort = () => {
    if (child.connected) {
      send({ type: "cancel", reason: clean(signal.reason) });
    }
    stop(signal.reason);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    onAbort();
  }
  child.on("message", (raw: unknown) => {
    if (stopping) {
      return;
    }
    try {
      assertCurrent();
      if (Buffer.byteLength(JSON.stringify(raw)) > UPDATE_REPAIR_IPC_MAX_BYTES) {
        throw new Error("The repair process returned too much diagnostic output.");
      }
      const message = updateRepairWorkerMessageSchema.parse(raw);
      if (message.type === "ready") {
        // Older shipped workers discard unknown start fields and would authorize
        // repair against copied state. Refuse them before granting execution.
        if (params.context.phase === "validating" && !message.supportsIsolatedTarget) {
          throw new Error(
            "This version does not support automatic repair before installation. Run openclaw triage to diagnose the failed update.",
          );
        }
        if (started) {
          throw new Error("The repair process started more than once.");
        }
        started = true;
        const { phase, beforeVersion, targetVersion, symptoms, ...failureContext } = params.context;
        const start = updateRepairParentMessageSchema.parse({
          type: "start",
          runId: params.runId,
          requester: params.requester,
          target: { ...params.target, installRoot },
          authorityTarget: params.authorityTarget,
          failure: failureContext,
          context: { phase, beforeVersion, targetVersion, symptoms },
          budget: { ...budget, wallClockMs: Math.max(1, deadline - Date.now()) },
        });
        send(start);
      } else if (message.type === "validate") {
        if (!started || pending || message.id !== ++requestId || requestId > budget.maxTurns + 1) {
          throw new Error("The repair process requested a health check at an unexpected time.");
        }
        const validationController = new AbortController();
        const validationSignal = AbortSignal.any([signal, validationController.signal]);
        const promise = Promise.resolve().then(async () => {
          try {
            assertCurrent();
            const validation = await params.validate(validationSignal);
            validationSignal.throwIfAborted();
            assertCurrent();
            finalValidation = { ...validation, summary: clean(validation.summary) };
            send({ type: "validation-result", id: message.id, validation: finalValidation });
          } catch (error) {
            if (!signal.aborted && child.connected) {
              send({ type: "validation-error", id: message.id, reason: clean(error) });
            }
          } finally {
            pending = undefined;
          }
        });
        pending = { id: message.id, controller: validationController, promise };
      } else if (message.type === "cancel-validation") {
        if (pending?.id === message.id) {
          pending.controller.abort(new Error("The repair health check was cancelled."));
        }
      } else if (message.type === "event") {
        if (
          (message.event.type === "turn-started" || message.event.type === "turn-finished") &&
          message.event.turn > budget.maxTurns
        ) {
          throw new Error("Automatic repair exceeded its attempt limit.");
        }
        if (message.event.type === "turn-finished") {
          if (attempts.length >= budget.maxTurns || message.event.turn !== attempts.length + 1) {
            throw new Error("The repair process repeated a finished attempt.");
          }
          const { type: _type, ...attempt } = message.event;
          attempts.push(attempt);
        }
        params.onEvent?.(message.event);
      } else {
        if (message.result.attempts.length > budget.maxTurns) {
          throw new Error("Automatic repair exceeded its attempt limit.");
        }
        result = message.result;
      }
    } catch (error) {
      stop(error);
    }
  });
  child.once("disconnect", () => {
    if (!result) {
      stop(new Error("The repair process disconnected before finishing."));
    }
  });
  const closed = new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      failure ??= clean(error);
    });
    child.once("exit", () => {
      childExited = true;
    });
    child.once("close", (code) => {
      commandSettled = true;
      resolve(code);
    });
  });
  try {
    const code = await closed;
    pending?.controller.abort(new Error("The repair process exited."));
    await pending?.promise;
    await termination.settle();
    assertCurrent();
    return result && code === 0 && !failure
      ? result
      : stopped(
          "unavailable",
          failure ??
            "Automatic repair stopped without a result. Run openclaw triage to inspect the update.",
        );
  } catch (error) {
    return stopped("aborted", clean(error));
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

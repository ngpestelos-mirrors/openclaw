import { vi } from "vitest";
import {
  attachedEnvironment,
  credential,
  SESSION_ID,
  sessionTarget,
  turn,
  type createWorkerSessionTurnPlacementProvider,
  type WorkerTurnEnvironmentService,
} from "./worker-turn-launcher.test-support.js";

export const localResult = async () => ({ meta: { durationMs: 1 } });

export function runIdentity(runId: string) {
  return {
    sessionId: SESSION_ID,
    sessionKey: sessionTarget.sessionKey,
    agentId: sessionTarget.agentId,
    runId,
  };
}

export function executeTurn(
  provider: ReturnType<typeof createWorkerSessionTurnPlacementProvider>,
  runId: string,
  runLocal = localResult,
) {
  return provider.executeTurn(runIdentity(runId), turn(runId), runLocal);
}

export function environmentForTunnel(
  overrides: Pick<WorkerTurnEnvironmentService, "startTunnel"> &
    Partial<WorkerTurnEnvironmentService>,
): WorkerTurnEnvironmentService {
  return {
    get: vi.fn(attachedEnvironment),
    acquireTurnCredential: vi.fn(async () => credential()),
    acknowledgeCredentialDelivery: vi.fn(async () => true),
    stopTunnel: vi.fn(async () => {}),
    destroy: vi.fn(async () => attachedEnvironment()),
    ...overrides,
  };
}

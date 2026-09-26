/** Prompt fixture for interactive Doctor service repair. */
import { vi } from "vitest";
import { createDoctorPrompter } from "./doctor-prompter.js";

export function createPrompter(confirmImpl: (message: string) => boolean) {
  return {
    confirm: vi.fn(),
    confirmAutoFix: vi.fn(),
    confirmAggressiveAutoFix: vi.fn(),
    confirmRuntimeRepair: vi.fn(async ({ message }: { message: string }) => confirmImpl(message)),
    select: vi.fn(),
    shouldRepair: false,
    shouldForce: false,
    repairMode: {
      shouldRepair: false,
      shouldForce: false,
      nonInteractive: false,
      canPrompt: true,
      updateInProgress: false,
    },
  };
}

export function setPlatform(platform: NodeJS.Platform) {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!originalPlatformDescriptor) {
    return;
  }
  Object.defineProperty(process, "platform", {
    ...originalPlatformDescriptor,
    value: platform,
  });
}

export async function runNonInteractiveRepair(
  maybeRepairGatewayDaemon: typeof import("./doctor-gateway-daemon-flow.js").maybeRepairGatewayDaemon,
) {
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  await maybeRepairGatewayDaemon({
    cfg: { gateway: {} },
    runtime,
    prompter: createDoctorPrompter({
      runtime,
      options: { repair: true, nonInteractive: true },
    }),
    options: { deep: false, repair: true, nonInteractive: true },
    gatewayDetailsMessage: "details",
    healthOk: false,
  });
}

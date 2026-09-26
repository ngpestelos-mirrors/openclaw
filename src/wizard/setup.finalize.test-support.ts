/** Assertions for the wizard's user-facing notes. */
import { expect, vi } from "vitest";
import type { createWizardPrompter as buildWizardPrompter } from "../../test/helpers/wizard-prompter.js";

export function expectNoteContains(
  prompter: ReturnType<typeof buildWizardPrompter>,
  expected: string,
  title: string,
): void {
  const calls = vi.mocked(prompter.note).mock.calls;
  expect(calls.filter((call) => call[0].includes(expected) && call[1] === title)).not.toEqual([]);
}

export function expectNoteTitleNotCalled(
  prompter: ReturnType<typeof buildWizardPrompter>,
  title: string,
): void {
  const calls = vi.mocked(prompter.note).mock.calls;
  expect(calls.filter((call) => call[1] === title)).toEqual([]);
}

export function expectNoteNotContains(
  prompter: ReturnType<typeof buildWizardPrompter>,
  unexpected: string,
): void {
  const calls = vi.mocked(prompter.note).mock.calls;
  expect(calls.filter((call) => call[0].includes(unexpected))).toEqual([]);
}

export async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: platform,
  });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
}

export function createReinstallServiceCommand(kind: "current" | "relocated") {
  const managedDefinition = {
    programArguments: [
      "/usr/bin/node",
      "--max-old-space-size=24576",
      "--require=/tmp/service-preload.js",
      "/usr/local/bin/openclaw",
      "gateway",
    ],
    environment: { NODE_OPTIONS: "--max-heap-size=32768", UNRELATED: "not-persisted" },
  };
  const existingCommand =
    kind === "relocated"
      ? managedDefinition
      : {
          programArguments: ["/operator/drop-in-wrapper", "gateway"],
          environment: { NODE_OPTIONS: "--max-old-space-size=1024" },
          managedDefinition,
          managedOverrides: { environment: { keys: ["NODE_OPTIONS"] } },
        };
  return existingCommand;
}

import "./install.test-support.js";
import { describe, expect, it, vi } from "vitest";
import type { GatewayServiceCommandConfig } from "../../daemon/service.js";
const {
  actionState,
  buildGatewayInstallPlanMock,
  expectFields,
  installDaemonServiceAndEmitMock,
  readFirstInstallPlanArg,
  readGatewayServiceCommandForMutationMock,
  runDaemonInstall,
  service,
  setupInstallTests,
} = await import("./install.test-support.js");
describe("relocated LaunchAgent installation", () => {
  setupInstallTests();
  it("fails closed when a pre-migration LaunchAgent cannot be inspected", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    readGatewayServiceCommandForMutationMock.mockRejectedValue(new Error("secret-canary"));

    await runDaemonInstall({ json: true });

    expect(actionState.failed[0]?.message).toContain(
      "Service definition cannot be safely inspected",
    );
    expect(actionState.failed[0]?.message).not.toContain("secret-canary");
    expect(service.readCommand).not.toHaveBeenCalled();
    expect(buildGatewayInstallPlanMock).not.toHaveBeenCalled();
    expect(installDaemonServiceAndEmitMock).not.toHaveBeenCalled();
  });

  it.each([
    [true, false],
    [true, true],
    [false, false],
  ])(
    "preserves pre-migration service-only values during loaded=%s force=%s install",
    async (loaded, force) => {
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      const wrapperPath = "/usr/local/bin/openclaw-doppler";
      const plistPath = "/Volumes/MainDataDrive/Library/LaunchAgents/ai.openclaw.gateway.plist";
      const existingCommand = {
        programArguments: [wrapperPath, "gateway", "run"],
        environment: {
          NODE_EXTRA_CA_CERTS: "/opt/openclaw/corporate-ca.pem",
          OPENCLAW_WRAPPER: wrapperPath,
        },
        environmentValueSources: {
          NODE_EXTRA_CA_CERTS: "file",
          OPENCLAW_WRAPPER: "file",
        },
      } satisfies GatewayServiceCommandConfig;
      delete process.env.NODE_EXTRA_CA_CERTS;
      delete process.env.OPENCLAW_WRAPPER;
      service.isLoaded.mockResolvedValue(loaded);
      service.readCommand.mockResolvedValue(null);
      readGatewayServiceCommandForMutationMock.mockResolvedValue({
        kind: "relocated",
        plistPath,
        command: existingCommand,
      });

      await runDaemonInstall({ json: true, force });

      const installPlanArg = readFirstInstallPlanArg();
      expectFields(installPlanArg, {
        existingCommand,
        existingEnvironment: existingCommand.environment,
        existingEnvironmentValueSources: existingCommand.environmentValueSources,
        wrapperPath,
      });
      expectFields(installPlanArg.env, existingCommand.environment);
      expect(installDaemonServiceAndEmitMock).toHaveBeenCalledTimes(1);
    },
  );
});

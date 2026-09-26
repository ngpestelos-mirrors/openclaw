/** Shared service-plan and audit fixtures for Doctor gateway tests. */
import type { ServiceConfigAudit } from "../daemon/service-audit.js";

export const gatewayProgramArguments = [
  "/usr/bin/node",
  "/usr/local/bin/openclaw",
  "gateway",
  "--port",
  "18789",
];

export function createRecommendedServiceAudit(code: string, message: string): ServiceConfigAudit {
  return { ok: false, issues: [{ code, message, level: "recommended" }] };
}

export function createGatewayInstallPlanFixture(): Awaited<
  ReturnType<typeof import("./daemon-install-helpers.js").buildGatewayInstallPlan>
> {
  return {
    programArguments: gatewayProgramArguments,
    workingDirectory: "/tmp",
    environment: {},
  };
}

export function createGatewayCommand(entrypoint: string) {
  return {
    programArguments: ["/usr/bin/node", entrypoint, "gateway", "--port", "18789"],
    environment: {},
  };
}

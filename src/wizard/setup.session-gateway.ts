/** Transient onboarding gateway lifetime; does not mutate the installed service. */
import { formatCliCommand } from "../cli/command-format.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";
import type { GatewayWizardSettings } from "./setup.types.js";

function buildSessionGatewayAuthOverride(params: {
  nextConfig: OpenClawConfig;
  settings: GatewayWizardSettings;
  resolvedGatewayPassword: string;
}): GatewayAuthConfig | undefined {
  if (params.settings.authMode === "token" && params.settings.gatewayToken) {
    return {
      ...params.nextConfig.gateway?.auth,
      mode: "token",
      token: params.settings.gatewayToken,
    };
  }
  if (params.settings.authMode === "password" && params.resolvedGatewayPassword) {
    return {
      ...params.nextConfig.gateway?.auth,
      mode: "password",
      password: params.resolvedGatewayPassword,
    };
  }
  return params.nextConfig.gateway?.auth;
}

export async function startSessionGatewayForOnboarding(params: {
  nextConfig: OpenClawConfig;
  settings: GatewayWizardSettings;
  resolvedGatewayPassword: string;
  prompter: WizardPrompter;
}): Promise<import("../gateway/server.js").GatewayServer | undefined> {
  const progress = params.prompter.progress(t("wizard.finalize.sessionGatewayStarting"));
  try {
    const { startGatewayServer } = await import("../gateway/server.js");
    const server = await startGatewayServer(params.settings.port, {
      bind: params.settings.bind,
      ...(params.settings.bind === "custom" && params.settings.customBindHost
        ? { host: params.settings.customBindHost }
        : {}),
      auth: buildSessionGatewayAuthOverride({
        nextConfig: params.nextConfig,
        settings: params.settings,
        resolvedGatewayPassword: params.resolvedGatewayPassword,
      }),
      tailscale: params.nextConfig.gateway?.tailscale,
    });
    progress.stop(t("wizard.finalize.sessionGatewayStarted"));
    return server;
  } catch (error) {
    progress.stop(t("wizard.finalize.sessionGatewayStartFailed"));
    await params.prompter.note(
      [
        t("wizard.finalize.sessionGatewayStartFailed"),
        formatErrorMessage(error),
        t("wizard.finalize.startGatewayNow", {
          command: formatCliCommand("openclaw gateway run"),
        }),
      ].join("\n"),
      "Gateway",
    );
    return undefined;
  }
}

export async function closeSessionGatewayForOnboarding(params: {
  sessionGateway: import("../gateway/server.js").GatewayServer;
  runtime: RuntimeEnv;
  reason: string;
}): Promise<void> {
  await params.sessionGateway.close({ reason: params.reason }).catch((error: unknown) => {
    params.runtime.error(formatErrorMessage(error));
  });
}

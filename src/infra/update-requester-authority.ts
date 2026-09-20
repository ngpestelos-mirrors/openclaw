import { isInternalMessageChannel } from "../utils/message-channel.js";
import { resolveInstallationTarget } from "./installation-target-context.js";

export type UpdateRequester = {
  channel?: string;
  accountId?: string;
  senderId?: string;
  /** Captured by the original admission; private handoffs preserve it without granting authority. */
  authorizationSource?: string;
};
export type UpdateRequesterAuthority = Readonly<{
  requester: Readonly<UpdateRequester>;
  /** False means revoked; unavailable policy throws so the run records its actual failure. */
  isCurrent: () => boolean;
}>;

/** Only external chat requesters delegate command-owner authority to the updater. */
export function resolveManagedUpdateRequester(
  requester: UpdateRequester | undefined,
): UpdateRequester | undefined {
  return requester?.channel && !isInternalMessageChannel(requester.channel) ? requester : undefined;
}

export class UpdateRequesterRevokedError extends Error {
  readonly code = "requester-revoked";

  constructor() {
    super("requester-revoked");
    this.name = "UpdateRequesterRevokedError";
  }
}

/** Bind the admitted requester to fresh, read-only policy from its original installation. */
export async function createManagedUpdateRequesterAuthority(
  requester: UpdateRequester,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpdateRequesterAuthority> {
  // Released drivers knew only configured owners. They must not acquire a newly linked profile
  // when an installed runtime later reconstructs their authority.
  const authorizationSource = requester.authorizationSource ?? "configured-owner";
  const admittedRequester = Object.freeze({ ...requester });
  try {
    const authorityEnv = { ...env };
    const target = resolveInstallationTarget(authorityEnv);
    const [
      { resolveCommandOwner },
      { readCurrentConfigForPolicyCheck },
      { ensureCliPluginRegistryLoaded },
    ] = await Promise.all([
      import("../auto-reply/command-auth.js"),
      // Keep synchronous authority checks on the reader loaded at admission.
      import("../config/io.js"),
      import("../cli/plugin-registry-loader.js"),
    ]);
    const readCurrentConfig = () =>
      readCurrentConfigForPolicyCheck({
        env: authorityEnv,
        configPath: target.configPath,
      });
    await ensureCliPluginRegistryLoaded({
      scope: "configured-channels",
      routeLogsToStderr: true,
      config: readCurrentConfig(),
    });
    return Object.freeze({
      requester: admittedRequester,
      isCurrent: () =>
        resolveCommandOwner(readCurrentConfig(), admittedRequester, { env: authorityEnv }) ===
        authorizationSource,
    });
  } catch (error) {
    // Admission and worker startup precede run failure reporting. Surface failed
    // preparation at the authority check, inside the owning run's error boundary.
    return Object.freeze({
      requester: admittedRequester,
      isCurrent: () => {
        throw error;
      },
    });
  }
}

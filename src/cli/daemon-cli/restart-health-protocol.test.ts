import { expect, it } from "vitest";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../../packages/gateway-protocol/src/version.js";
import { resolveReadOnlyLocalGatewayAuth } from "../../gateway/call-device-auth.js";
import { callGateway } from "../../gateway/call.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withProtocolGateway } from "./restart-health-protocol.test-support.js";

// The old updater's transport must not decide whether the new Gateway is healthy.
const retainedProtocol = MIN_CLIENT_PROTOCOL_VERSION - 1;
it.each(["none", "token"] as const)(
  "old/current local readiness control with %s auth",
  async (mode) => {
    await withOpenClawTestState(
      { env: { OPENCLAW_GATEWAY_TOKEN: undefined, OPENCLAW_GATEWAY_PASSWORD: undefined } },
      async (state) =>
        withProtocolGateway(mode, async ({ port, config, observed, failures }) => {
          const controlAuth = await resolveReadOnlyLocalGatewayAuth({
            auth: config.gateway?.auth,
            authNone: mode === "none",
            env: state.env,
          });
          const probe = (protocol: number) =>
            callGateway({
              config,
              localPortOverride: port,
              ...controlAuth,
              method: "health",
              scopes: ["operator.read"],
              timeoutMs: 2_000,
              minProtocol: protocol,
              maxProtocol: protocol,
            });
          const previous = await probe(retainedProtocol).then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
          );
          expect(observed).toHaveLength(1);
          expect(observed[0]).toMatchObject({
            minProtocol: retainedProtocol,
            maxProtocol: retainedProtocol,
            client:
              mode === "none"
                ? { id: "gateway-client", mode: "backend" }
                : { id: "cli", mode: "cli" },
          });
          expect(previous).toMatchObject({
            error: expect.objectContaining({ message: expect.stringMatching(/protocol mismatch/) }),
          });
          await expect(probe(PROTOCOL_VERSION)).resolves.toMatchObject({ ok: true });
          expect(failures).toEqual(["protocol-mismatch"]);
          expect(observed.map((connect) => connect.client)).toEqual([
            expect.objectContaining(
              mode === "none"
                ? { id: "gateway-client", mode: "backend" }
                : { id: "cli", mode: "cli" },
            ),
            expect.objectContaining(
              mode === "none"
                ? { id: "gateway-client", mode: "backend" }
                : { id: "cli", mode: "cli" },
            ),
          ]);
        }),
    );
  },
);

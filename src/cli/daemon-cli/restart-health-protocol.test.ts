import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../../packages/gateway-protocol/src/version.js";
import { resolveReadOnlyLocalGatewayAuth } from "../../gateway/call-device-auth.js";
import { callGateway } from "../../gateway/call.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { withUpdateCommandExecutor } from "../update-cli/update-command-executor.js";
import { useExecutorFixture } from "../update-cli/update-command-executor.test-support.js";
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

const executorFixture = useExecutorFixture("readiness-connection-authority-");
it("sends no credentials when the admitted updater lease changes before challenge", async () => {
  const { root, control } = executorFixture();
  let revoked = false;
  await withOpenClawTestState(
    { env: { OPENCLAW_GATEWAY_TOKEN: undefined, OPENCLAW_GATEWAY_PASSWORD: undefined } },
    async (state) =>
      withProtocolGateway(
        "token",
        async ({ port, config, observed }) => {
          const controlAuth = await resolveReadOnlyLocalGatewayAuth({
            auth: config.gateway.auth,
            env: state.env,
          });
          let callError: unknown;
          const outcome = await withUpdateCommandExecutor(randomUUID(), async (owner) => {
            const fence = await owner.enter(root);
            const options = {
              config,
              localPortOverride: port,
              ...controlAuth,
              method: "health",
              scopes: ["operator.read"],
              timeoutMs: 2_000,
              assertConnectionCurrent: fence.assertCurrent,
              assertDispatchCurrent: fence.assertCurrent,
            };
            try {
              await callGateway(options);
            } catch (error) {
              callError = error;
              throw error;
            }
          }).then(
            () => ({ ok: true }),
            (error: unknown) => ({ error }),
          );
          expect(revoked).toBe(true);
          expect(callError).toBeInstanceOf(Error);
          expect(outcome).toHaveProperty("error");
          expect(observed).toEqual([]);
        },
        {
          beforeChallenge: async () => {
            // Reassign the real admitted lease while the live socket awaits its challenge.
            const db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
            try {
              const changed = db
                .prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?")
                .run("replacement", root);
              expect(changed.changes).toBe(1);
              revoked = true;
            } finally {
              db.close();
            }
          },
        },
      ),
  );
});

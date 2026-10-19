import { describe, expect, it } from "vitest";
import type { GatewayProbeResult } from "../../gateway/probe.js";
import { buildGatewayStatusWarnings } from "./output.js";
import type { GatewayStatusProbedTarget } from "./probe-run.js";
import { createUnreachableGatewayProbe } from "./test-support.js";

function createTarget(id: string, probe: GatewayProbeResult): GatewayStatusProbedTarget {
  return {
    target: {
      id,
      kind: "explicit",
      url: probe.url,
      active: true,
    },
    probe,
    configSummary: null,
    self: null,
    authDiagnostics: [],
  };
}

function createReachableTarget(
  id: string,
  self: GatewayStatusProbedTarget["self"],
  target?: Partial<GatewayStatusProbedTarget["target"]>,
): GatewayStatusProbedTarget {
  const probe: GatewayProbeResult = {
    ...createUnreachableGatewayProbe(target?.url ?? "ws://127.0.0.1:18789", ""),
    ok: true,
    connectLatencyMs: 20,
    error: null,
    auth: { role: "operator", scopes: ["operator.admin"], capability: "admin_capable" },
  };
  const base = createTarget(id, probe);
  return {
    ...base,
    target: {
      ...base.target,
      ...target,
    },
    self,
  };
}

const MULTIPLE_GATEWAYS_WARNING = {
  code: "multiple_gateways",
  message:
    "Unconventional setup: multiple reachable gateway identities detected. Usually one gateway per network is recommended unless you intentionally run isolated profiles, like a rescue bot (see docs: /gateway#multiple-gateways-same-host).",
};

const GATEWAY_SELF = {
  host: "gateway-host",
  ip: "192.0.2.10",
  version: "2026.5.22",
  platform: "linux",
  instanceId: "gateway-instance-1",
};

const GATEWAY_SELF_NO_PROCESS_ID = {
  ...GATEWAY_SELF,
  instanceId: undefined,
};

describe("gateway status output", () => {
  it("warns with diagnostic next steps when no probes or Bonjour discovery find a gateway", () => {
    const warnings = buildGatewayStatusWarnings({
      probed: [
        createTarget(
          "localLoopback",
          createUnreachableGatewayProbe("ws://127.0.0.1:18789", "connection refused"),
        ),
      ],
      sshTarget: null,
      sshTunnelStarted: false,
      sshTunnelError: null,
      discoveryCount: 0,
    });

    expect(warnings.find((entry) => entry.code === "no_gateway_reachable")).toStrictEqual({
      code: "no_gateway_reachable",
      message:
        "No gateway answered any check and Bonjour discovery returned no local gateways. Run `openclaw gateway status --deep --require-rpc` to inspect service state, config paths, listener owners, and logs; include `ss -ltnp` or `lsof -nP -iTCP:<port> -sTCP:LISTEN` for the configured port when filing a report.",
      targetIds: ["localLoopback"],
    });
  });

  it.each([
    {
      name: "suppresses warning for SSH tunnel and configured remote with the same self identity",
      probed: [
        createReachableTarget("sshTunnel", GATEWAY_SELF, {
          kind: "sshTunnel",
          url: "ws://127.0.0.1:18789",
          tunnel: {
            kind: "ssh",
            target: "user@gateway-host",
            localPort: 18789,
            remotePort: 18789,
            pid: 1234,
          },
        }),
        createReachableTarget(
          "configRemote",
          {
            ...GATEWAY_SELF,
            host: GATEWAY_SELF.host.toUpperCase(),
          },
          { kind: "configRemote", url: "ws://gateway-host:18789" },
        ),
      ],
      sshTarget: "user@gateway-host",
      expectedTargetIds: null,
    },
    {
      name: "suppresses warning for the same self identity on different transport ports",
      probed: [
        createReachableTarget("localLoopback", GATEWAY_SELF, {
          kind: "localLoopback",
          url: "ws://127.0.0.1:18789",
        }),
        createReachableTarget("explicit", GATEWAY_SELF, {
          kind: "explicit",
          url: "ws://gateway-host:28789",
        }),
      ],
      sshTarget: null,
      expectedTargetIds: null,
    },
    {
      name: "warns when same-host probes do not report process identity",
      probed: [
        createReachableTarget("localLoopback", GATEWAY_SELF_NO_PROCESS_ID, {
          kind: "localLoopback",
          url: "ws://127.0.0.1:18789",
        }),
        createReachableTarget("explicit", GATEWAY_SELF_NO_PROCESS_ID, {
          kind: "explicit",
          url: "ws://gateway-host:28789",
        }),
      ],
      sshTarget: null,
      expectedTargetIds: ["localLoopback", "explicit"],
    },
    {
      name: "warns when probes report distinct identities",
      probed: [
        createReachableTarget("sshTunnel", {
          ...GATEWAY_SELF,
          host: "gateway-a",
          instanceId: "gateway-instance-a",
        }),
        createReachableTarget("configRemote", {
          ...GATEWAY_SELF,
          host: "gateway-b",
          ip: "192.0.2.11",
          instanceId: "gateway-instance-b",
        }),
      ],
      sshTarget: "user@gateway-a",
      expectedTargetIds: ["sshTunnel", "configRemote"],
    },
    {
      name: "warns when probe identity is unknown",
      probed: [
        createReachableTarget("sshTunnel", null),
        createReachableTarget("configRemote", null),
      ],
      sshTarget: "user@gateway-host",
      expectedTargetIds: ["sshTunnel", "configRemote"],
    },
  ])("$name", ({ probed, sshTarget, expectedTargetIds }) => {
    const warnings = buildGatewayStatusWarnings({
      probed,
      sshTarget,
      sshTunnelStarted: sshTarget !== null,
      sshTunnelError: null,
      discoveryCount: 0,
    });
    const warning = warnings.find((entry) => entry.code === "multiple_gateways");

    if (expectedTargetIds === null) {
      expect(warning).toBeUndefined();
    } else {
      expect(warning).toStrictEqual({
        ...MULTIPLE_GATEWAYS_WARNING,
        targetIds: expectedTargetIds,
      });
    }
  });
});

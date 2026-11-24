// Same principal, same answer: every entry kind reaches one turn grant through admission.
// Real transport -> fresh admission (accepted input) -> saved-source replay admission.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TurnGrant } from "../agents/admitted-run-operator-authority.types.js";
import type { Mode, Row } from "./operator-admission.contracts.test-support.js";
import { createFixture, runCase } from "./operator-admission.fixture.test-support.js";
import type { AdmissionFixture } from "./operator-admission.table.test-support.js";

// Principals the real-Gateway harness authenticates. OWNER is the installation owner (shared
// secret, OpenClaw ID owner); PERSON is operator@example.test with role `operator`. The harness
// admits both with operator.read + operator.write, so both rows expect the same grant.
const WRITER_GRANT: TurnGrant = {
  owner: false,
  skillAuthoring: true,
  questionReplace: true,
  commands: "none",
};
const GRANTS = { OWNER: WRITER_GRANT, PERSON: WRITER_GRANT };
type Principal = keyof typeof GRANTS;

// Entry columns this harness drives. Telegram, cron runs, restart and durable exec wakes,
// subagent completion and HTTP enter in the PRs that move those entry kinds.
const cells: Array<[cell: string, mode: Mode, row: Row, principal: Principal]> = [
  ["OWNER x E1 Control UI token", "token", { credential: "token", ingress: "control-ui" }, "OWNER"],
  [
    "OWNER x E1 Control UI password",
    "password",
    { credential: "password", ingress: "control-ui" },
    "OWNER",
  ],
  [
    "OWNER x E1 Control UI OpenClaw ID owner",
    "token",
    { credential: "ocid-owner", ingress: "control-ui" },
    "OWNER",
  ],
  ["OWNER x E14 CLI via Gateway", "token", { credential: "token", ingress: "internal" }, "OWNER"],
  [
    "PERSON x E3 Control UI Tailscale",
    "token",
    { credential: "tailscale", ingress: "control-ui" },
    "PERSON",
  ],
  [
    "PERSON x E3 Control UI Tailscale paired device",
    "token",
    { credential: "tailscale-device", ingress: "control-ui" },
    "PERSON",
  ],
  [
    "PERSON x E4 Control UI trusted proxy",
    "trusted-proxy",
    { credential: "trusted-proxy", ingress: "control-ui" },
    "PERSON",
  ],
  [
    "PERSON x E5 Discord DM linked identity",
    "token",
    { credential: "channel", ingress: "channel" },
    "PERSON",
  ],
];

// Shrink only: a cell that diverges names its reason and the PR that fixes it.
// A listed cell that passes fails below, so fixed cells leave this set.
const KNOWN_DIVERGENT: Record<string, { reason: string; fixedBy: string }> = {
  "PERSON x E5 Discord DM linked identity": {
    reason:
      "A linked channel sender gets its role's scopes (operator.admin) while the same person over Tailscale gets gateway.auth.identityScopes; channel-operator-authority.ts decides scopes outside admission.",
    fixedBy: "OA2 PR 2 (channels)",
  },
};

describe.each(["token", "password", "trusted-proxy"] as const)("turn grant matrix: %s", (mode) => {
  let fixture: AdmissionFixture;
  beforeAll(async () => {
    fixture = await createFixture(mode);
  }, 90_000);
  afterAll(async () => {
    await fixture?.close();
  });
  it.for(cells.filter(([, cellMode]) => cellMode === mode))(
    "%s",
    { timeout: 90_000 },
    async ([cell, , row, principal], { signal }) => {
      const c = await runCase(fixture, row, "after-start", signal);
      const observed = { fresh: c.original?.operatorAuthority?.grant, replay: c.replayGrants };
      const expected = { fresh: GRANTS[principal], replay: [GRANTS[principal]] };
      if (KNOWN_DIVERGENT[cell]) {
        expect(observed, `${cell} now passes; remove it from KNOWN_DIVERGENT`).not.toEqual(
          expected,
        );
        return;
      }
      expect(observed).toEqual(expected);
    },
  );
});

it("only shrinks KNOWN_DIVERGENT", () => {
  // Lower this ceiling when a PR fixes a cell; never raise it.
  expect(Object.keys(KNOWN_DIVERGENT).length).toBeLessThanOrEqual(1);
});

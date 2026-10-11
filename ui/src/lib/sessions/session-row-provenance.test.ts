// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { createSessionRowProvenance } from "./session-row-provenance.ts";

describe("session row provenance", () => {
  it.each(["descriptor-first", "compact-first"] as const)(
    "retains detail facts across compact reads and lets full reads clear them (%s)",
    (order) => {
      const provenance = createSessionRowProvenance();
      const identity = {
        key: "agent:main:details",
        sessionId: "details",
        kind: "direct" as const,
      };
      const descriptor: GatewaySessionRow = {
        ...identity,
        updatedAt: 100,
        snapshotAt: 100,
        label: "Before",
        thinkingLevels: [{ id: "high", label: "High" }],
        toolOverrides: { webSearch: false },
      };
      const compact: GatewaySessionRow = {
        ...identity,
        rowMode: "compact",
        updatedAt: 200,
        snapshotAt: 200,
        label: "Current",
      };
      const reads: [GatewaySessionRow, GatewaySessionRow] =
        order === "descriptor-first" ? [descriptor, compact] : [compact, descriptor];
      provenance.observeReadRow(reads[0], 1);
      provenance.observeReadRow(reads[1], 2);
      const merged = provenance.mergeRow(reads[0], reads[1]);
      expect(merged).toMatchObject({
        label: "Current",
        thinkingLevels: [{ id: "high", label: "High" }],
        toolOverrides: { webSearch: false },
      });

      const cleared: GatewaySessionRow = {
        ...identity,
        updatedAt: 300,
        snapshotAt: 300,
        label: "Current",
      };
      provenance.observeReadRow(cleared, 3);
      const next = provenance.mergeRow(merged, cleared);
      expect(next.thinkingLevels).toBeUndefined();
      expect(next.toolOverrides).toBeUndefined();
      expect(next.rowMode).toBeUndefined();
    },
  );
});

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  createDockerChannelPromotionPlan,
  promoteDockerChannel,
} from "../../scripts/docker-channel-promote.mjs";

const images = ["ghcr.io/openclaw/openclaw", "docker.io/openclaw/openclaw"];
const digest = `sha256:${"1".repeat(64)}`;
const changedDigest = `sha256:${"2".repeat(64)}`;

function imageConfig(version: string): string {
  return JSON.stringify({
    config: { Labels: { "org.opencontainers.image.version": version } },
  });
}

function createDockerMock(
  params: {
    candidateVersion?: string;
    currentVersion?: string;
    sourceImageConfigs?: Record<string, string>;
    wrongTargetDigest?: string;
    inspectAlias?: (ref: string) => void;
    sourceDigest?: () => string;
    onCreate?: (args: string[]) => void;
  } = {},
) {
  const targetDigests = new Map<string, string>();
  return vi.fn((_command: string, args: string[]) => {
    if (args[2] === "inspect") {
      const ref = args[3]!;
      if (args.at(-1)?.includes(".Image")) {
        if (!ref.includes("@")) {
          params.inspectAlias?.(ref);
        }
        const platform = args.at(-1)?.includes("linux/arm64") ? "linux/arm64" : "linux/amd64";
        if (ref.includes("@") && params.sourceImageConfigs?.[platform] !== undefined) {
          return params.sourceImageConfigs[platform];
        }
        return imageConfig(
          (ref.includes("@") ? params.candidateVersion : params.currentVersion) ?? "2026.6.33",
        );
      }
      if (params.wrongTargetDigest && ref.includes(":extended-stable")) {
        return JSON.stringify({ digest: params.wrongTargetDigest });
      }
      return JSON.stringify({
        digest: targetDigests.get(ref) ?? params.sourceDigest?.() ?? digest,
      });
    }
    const sourceDigest = args.at(-1)!.split("@")[1]!;
    for (let index = 0; index < args.length; index += 1) {
      if (args[index] === "--tag") {
        targetDigests.set(args[index + 1]!, sourceDigest);
      }
    }
    params.onCreate?.(args);
    return "";
  });
}

function runPromotion(
  execFileSyncImpl: ReturnType<typeof createDockerMock>,
  options: Parameters<typeof promoteDockerChannel>[1] = {},
  params: Partial<Parameters<typeof promoteDockerChannel>[0]> = {},
) {
  return promoteDockerChannel(
    { version: "2026.6.33", images: images.slice(0, 1), ...params },
    { execFileSyncImpl, verifyAttestationsImpl: () => {}, ...options },
  );
}

function expectNoWrites(docker: ReturnType<typeof createDockerMock>) {
  expect(docker.mock.calls.some(([, args]) => args[2] === "create")).toBe(false);
}

function expectRejected(docker: ReturnType<typeof createDockerMock>, message: string) {
  expect(() => runPromotion(docker)).toThrow(message);
  expectNoWrites(docker);
}

type WorkflowJob = {
  concurrency?: { group?: string; "cancel-in-progress"?: boolean; queue?: string };
  environment?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  steps?: { uses?: string; with?: Record<string, boolean | string> }[];
};

describe("Docker channel promotion", () => {
  it("stops channel alias writes when authority is revoked between registries", () => {
    const writes: string[][] = [];
    let revoked = false;
    const docker = createDockerMock({
      candidateVersion: "2026.7.1",
      currentVersion: "2026.7.1",
      onCreate(args) {
        writes.push(args);
        revoked = writes.length === 3;
      },
    });

    expect(() =>
      runPromotion(
        docker,
        {
          revalidateAuthority: () => {
            if (revoked) {
              throw new Error("Publication authority revoked");
            }
          },
          log: () => {},
        },
        { version: "2026.7.1", images },
      ),
    ).toThrow("Publication authority revoked");
    expect(writes).toHaveLength(3);
  });

  it("rejects malformed rebuild suffixes", () => {
    expect(() =>
      createDockerChannelPromotionPlan({
        version: "2026.7.1",
        imageTagSuffix: "r20260820",
        images: images.slice(0, 1),
      }),
    ).toThrow("Invalid Docker image tag suffix");
  });

  it("fails without mutating when any version-specific source is missing", () => {
    const calls: string[][] = [];
    const docker = vi.fn((_command: string, args: string[]) => {
      calls.push(args);
      if (calls.length === 3) {
        throw new Error("missing manifest");
      }
      return JSON.stringify({ digest });
    });

    expect(() => runPromotion(docker, {}, { images })).toThrow("missing manifest");
    expect(calls.some((args) => args[2] === "create")).toBe(false);
  });

  it("fails when a promoted alias does not match its version-specific source", () => {
    const docker = createDockerMock({ wrongTargetDigest: changedDigest });

    expect(() => runPromotion(docker, {}, { images })).toThrow(
      `resolved to ${changedDigest}, expected ${digest}`,
    );
  });

  it.each([false, true])("requires explicit rollback approval: %s", (allowRollback) => {
    const docker = createDockerMock({ currentVersion: "2026.6.34" });
    if (allowRollback) {
      runPromotion(docker, { allowRollback });
      expect(docker.mock.calls.some(([, args]) => args[2] === "create")).toBe(true);
    } else {
      expect(() => runPromotion(docker, {}, { imageTagSuffix: "-r20260820" })).toThrow(
        "Refusing to move ghcr.io/openclaw/openclaw:extended-stable backward from 2026.6.34 to 2026.6.33",
      );
      expect(docker.mock.calls[0]?.[1]).toContain("ghcr.io/openclaw/openclaw:2026.6.33-r20260820");
      expectNoWrites(docker);
    }
  });

  it("allows a first promotion for no such manifest in buffered stderr", () => {
    let created = false;
    const docker = createDockerMock({
      onCreate() {
        created = true;
      },
      inspectAlias() {
        if (!created) {
          throw Object.assign(new Error("docker inspect failed"), {
            stderr: Buffer.from("no such manifest"),
          });
        }
      },
    });

    runPromotion(docker);

    expect(created).toBe(true);
  });

  it.each([
    ["unrelated executable lookup", () => "docker credential helper: not found"],
    ["longer image token", (ref: string) => `mirror-${ref}: not found`],
  ] as const)("fails closed on %s while inspecting an existing alias", (_name, stderr) => {
    const docker = createDockerMock({
      inspectAlias(ref) {
        throw Object.assign(new Error("docker inspect failed"), { stderr: stderr(ref) });
      },
    });

    expectRejected(docker, "docker inspect failed");
  });

  it("promotes the same digests whose attestations were verified", () => {
    let sourceDigest = digest;
    const docker = createDockerMock({ sourceDigest: () => sourceDigest });
    const verifiedRefs: string[] = [];

    runPromotion(docker, {
      verifyAttestationsImpl({ imageRefs }) {
        verifiedRefs.push(...imageRefs);
        sourceDigest = changedDigest;
      },
    });

    expect(verifiedRefs).toEqual(Array(3).fill(`ghcr.io/openclaw/openclaw@${digest}`));
    expect(
      docker.mock.calls.filter(([, args]) => args[2] === "create").map(([, args]) => args.at(-1)),
    ).toEqual(Array(3).fill(`ghcr.io/openclaw/openclaw@${digest}`));
  });

  it("rejects a custom-build source label at the requested-release comparison", () => {
    expectRejected(
      createDockerMock({ candidateVersion: "custom-build" }),
      `ghcr.io/openclaw/openclaw@${digest} reports version custom-build, expected 2026.6.33`,
    );
  });

  it("rejects a source whose platform version labels disagree", () => {
    expectRejected(
      createDockerMock({ sourceImageConfigs: { "linux/arm64": imageConfig("2026.6.34") } }),
      "inconsistent platform versions: linux/amd64=2026.6.33, linux/arm64=2026.6.34",
    );
  });

  it("rejects channels without moving aliases", () => {
    expect(() => createDockerChannelPromotionPlan({ version: "2026.7.2-beta.3", images })).toThrow(
      "no moving aliases",
    );
  });

  it("gates digest-bound publication and repairs on trusted checkout and approval", () => {
    const workflow = parse(
      readFileSync(".github/workflows/docker-channel-promote.yml", "utf8"),
    ) as {
      jobs: Record<string, WorkflowJob>;
    };
    const jobs = Object.entries(workflow.jobs);
    const approvals = jobs.filter(([, job]) => job.environment === "docker-release");
    const writers = jobs.filter(([, job]) => job.permissions?.packages === "write");
    expect(approvals).toHaveLength(1);
    expect(writers).toHaveLength(1);
    for (const [, job] of jobs) {
      expect(
        Object.entries(job.permissions ?? {})
          .filter(([, level]) => level === "write")
          .map(([scope]) => scope),
      ).toEqual(job.permissions?.packages === "write" ? ["packages"] : []);
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith("actions/checkout@")) {
          expect(step.with).toMatchObject({
            ref: "${{ github.sha }}",
            "persist-credentials": false,
          });
        }
      }
    }
    const writer = writers[0]![1];
    expect(writer.steps?.some((step) => step.uses?.startsWith("actions/checkout@"))).toBe(true);
    expect([writer.needs].flat()).toContain(approvals[0]![0]);
    expect(writer.concurrency).toEqual({
      group: "docker-release-publish",
      "cancel-in-progress": false,
      queue: "max",
    });
  });
});

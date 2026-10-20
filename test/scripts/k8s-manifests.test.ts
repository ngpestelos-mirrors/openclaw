import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

type Manifest = Record<string, unknown>;

function readManifest(name: string): Manifest {
  return assertRecord(parse(readFileSync(`scripts/k8s/manifests/${name}`, "utf8")), name);
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeTypeOf("object");
  expect(value, label).not.toBeNull();
  expect(Array.isArray(value), label).toBe(false);
  return value as Record<string, unknown>;
}

function asRecords(value: unknown, label: string): Record<string, unknown>[] {
  expect(Array.isArray(value), label).toBe(true);
  return value as Record<string, unknown>[];
}

function findNamed(records: Record<string, unknown>[], name: string): Record<string, unknown> {
  const record = records.find((entry) => entry.name === name);
  expect(record, name).toBeDefined();
  return record as Record<string, unknown>;
}

describe("k8s manifests", () => {
  it("keeps kustomization resources aligned with shipped manifests", () => {
    const kustomization = readManifest("kustomization.yaml");

    expect(kustomization).toMatchObject({
      apiVersion: "kustomize.config.k8s.io/v1beta1",
      kind: "Kustomization",
    });
    expect(kustomization.resources).toEqual(
      expect.arrayContaining(["configmap.yaml", "deployment.yaml", "pvc.yaml", "service.yaml"]),
    );
    expect(kustomization.resources).toHaveLength(4);
  });

  it("keeps gateway service selectors and ports aligned with deployment labels", () => {
    const deployment = readManifest("deployment.yaml");
    const service = readManifest("service.yaml");
    expect(deployment).toMatchObject({
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "openclaw" },
      spec: { template: { metadata: { labels: { app: "openclaw" } } } },
    });
    expect(deployment).toHaveProperty("spec.selector.matchLabels", { app: "openclaw" });
    expect(service).toHaveProperty("spec.selector", { app: "openclaw" });
    expect(service).toHaveProperty(
      "spec.ports",
      expect.arrayContaining([
        {
          name: "gateway",
          port: 18789,
          protocol: "TCP",
          targetPort: 18789,
        },
      ]),
    );
  });

  it("keeps deployment mounts, secrets, and security posture deployable", () => {
    const deployment = readManifest("deployment.yaml");
    const spec = assertRecord(deployment.spec, "deployment spec");
    const template = assertRecord(spec.template, "deployment template");
    const podSpec = assertRecord(template.spec, "pod spec");
    const containers = asRecords(podSpec.containers, "containers");
    const gateway = findNamed(containers, "gateway");
    const env = asRecords(gateway.env, "gateway env");
    const volumes = asRecords(podSpec.volumes, "pod volumes");
    expect(gateway).toMatchObject({
      command: ["node", "/app/dist/index.js", "gateway", "run"],
      securityContext: {
        allowPrivilegeEscalation: false,
        readOnlyRootFilesystem: true,
        runAsNonRoot: true,
      },
    });
    expect(findNamed(env, "HOME")).toMatchObject({ value: "/home/node" });
    expect(findNamed(env, "OPENCLAW_CONFIG_DIR")).toMatchObject({ value: "/home/node/.openclaw" });
    const mounts = asRecords(gateway.volumeMounts, "gateway volume mounts");
    const homeMount = findNamed(mounts, "openclaw-home");
    expect(homeMount).toMatchObject({ mountPath: "/home/node/.openclaw" });
    expect(homeMount.readOnly).not.toBe(true);
    expect(findNamed(env, "XDG_CACHE_HOME")).toMatchObject({
      value: "/home/node/.openclaw/.cache",
    });
    expect(findNamed(env, "OPENCLAW_GATEWAY_TOKEN")).toMatchObject({
      valueFrom: { secretKeyRef: { key: "OPENCLAW_GATEWAY_TOKEN", name: "openclaw-secrets" } },
    });
    expect(findNamed(volumes, "openclaw-home")).toMatchObject({
      persistentVolumeClaim: { claimName: "openclaw-home-pvc" },
    });
    expect(findNamed(volumes, "config")).toMatchObject({ configMap: { name: "openclaw-config" } });
  });

  it("keeps config and persistence manifests aligned with the gateway", () => {
    const configMap = readManifest("configmap.yaml");
    const pvc = readManifest("pvc.yaml");
    const data = assertRecord(configMap.data, "configmap data");

    expect(configMap).toMatchObject({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "openclaw-config" },
    });
    expect(JSON.parse(String(data["openclaw.json"]))).toMatchObject({
      gateway: { mode: "local", port: 18789, auth: { mode: "token" } },
      agents: { defaults: { workspace: "~/.openclaw/workspace" } },
    });
    expect(data["AGENTS.md"]).toContain("OpenClaw Assistant");
    expect(pvc).toMatchObject({
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: "openclaw-home-pvc" },
      spec: { resources: { requests: { storage: "10Gi" } } },
    });
  });
});

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deleteTestEnvValue } from "../test-utils/env.js";
import { invalidateConfigGetResponseCache } from "./config-get-response.js";
import {
  configRawPayload,
  configWithGatewayTokenSecretRef,
  makeRouteBinding,
  withConfigFileFixture,
} from "./server.config-patch.test-support.js";
import {
  getConfigHash,
  getCurrentConfigObject,
  installReadOnlyConfigGatewayHooks,
  requireClient,
  requireConfigObject,
  rpcReq,
  sendConfigApply,
  sendConfigSet,
  writeJsonFile,
} from "./server.config-rpc-gateway.test-support.js";

export function registerNoncommittingConfigRpcTests(secretRefRpcTimeoutMs: number) {
  describe("gateway noncommitting config RPCs", () => {
    installReadOnlyConfigGatewayHooks();

    describe("gateway config methods", () => {
      it("rejects the internal raw digest as a public config base hash", async () => {
        const { readConfigFileSnapshot } = await import("../config/config.js");
        const current = await getCurrentConfigObject();
        const internal = await readConfigFileSnapshot();
        expect(typeof internal.hash).toBe("string");

        const response = await sendConfigSet(configRawPayload(current.config, internal.hash));

        expect(response.ok).toBe(false);
        expect(response.error?.message).toContain("config changed since last load");
      });

      it("rejects config.set when SecretRef resolution fails", async () => {
        const missingEnvVar = `OPENCLAW_MISSING_SECRETREF_${Date.now()}`;
        deleteTestEnvValue(missingEnvVar);
        const current = await getCurrentConfigObject();
        const nextConfig = configWithGatewayTokenSecretRef(current.config, missingEnvVar);

        const res = await sendConfigSet(
          configRawPayload(nextConfig, current.hash),
          secretRefRpcTimeoutMs,
        );
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("active SecretRef resolution failed");
        const afterHash = await getConfigHash();
        expect(afterHash).toBe(current.hash);
      });

      it("rejects config.patch when merged SecretRefs cannot resolve", async () => {
        const missingEnvVar = `OPENCLAW_MISSING_SECRETREF_PATCH_${Date.now()}`;
        deleteTestEnvValue(missingEnvVar);
        const beforeHash = await getConfigHash();
        const res = await rpcReq(
          (requestOptions) =>
            requireClient().request<{ ok?: boolean; error?: { message?: string } }>(
              "config.patch",
              {
                raw: JSON.stringify({
                  gateway: {
                    auth: {
                      mode: "token",
                      token: {
                        source: "env",
                        provider: "default",
                        id: missingEnvVar,
                      },
                    },
                  },
                }),
                baseHash: beforeHash,
              },
              requestOptions,
            ),
          secretRefRpcTimeoutMs,
        );
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("active SecretRef resolution failed");
        const afterHash = await getConfigHash();
        expect(afterHash).toBe(beforeHash);
      });

      it("returns noop for config.patch when authored config is unchanged", async () => {
        const current = await getCurrentConfigObject();

        // Replaying runtime defaults would explicitly author them into the source config.
        const res = await rpcReq((requestOptions) =>
          requireClient().request<{
            ok?: boolean;
            noop?: boolean;
            config?: Record<string, unknown>;
          }>(
            "config.patch",
            {
              raw: JSON.stringify(current.config),
              baseHash: current.hash,
            },
            requestOptions,
          ),
        );

        expect(res.ok, res.error?.message).toBe(true);
        expect(res.payload?.noop).toBe(true);
        // Config hash should not change (no file write)
        const after = await rpcReq((requestOptions) =>
          requireClient().request<{ hash?: string }>("config.get", {}, requestOptions),
        );
        expect(after.payload?.hash).toBe(current.hash);
      });

      it("includes the active runtime config revision", async () => {
        const { readConfigFileSnapshot } = await import("../config/config.js");
        const { getRuntimeConfigAppliedHash, hashRuntimeConfigValue } =
          await import("../config/runtime-snapshot.js");
        const current = await rpcReq((requestOptions) =>
          requireClient().request<{
            hash?: string;
            configRevisionHash?: string;
            appliedConfigHash?: string | null;
          }>("config.get", {}, requestOptions),
        );

        expect(current.ok).toBe(true);
        expect(current.payload).toHaveProperty("configRevisionHash");
        expect(current.payload).toHaveProperty("appliedConfigHash");
        const internal = await readConfigFileSnapshot();
        expect(current.payload?.hash).not.toBe(internal.hash);
        expect(current.payload?.configRevisionHash).not.toBe(
          hashRuntimeConfigValue(internal.sourceConfig),
        );
        const internalAppliedHash = getRuntimeConfigAppliedHash();
        if (internalAppliedHash === null) {
          expect(current.payload?.appliedConfigHash).toBeNull();
        } else {
          expect(current.payload?.appliedConfigHash).not.toBe(internalAppliedHash);
        }
      });

      it("returns config.set validation details in the top-level error message", async () => {
        const gatewayClient = requireClient();
        const requestParams = {
          raw: JSON.stringify({ gateway: { bind: 123 } }),
          baseHash: await getConfigHash(),
        };
        const res = await rpcReq((requestOptions) =>
          gatewayClient.request<{
            ok?: boolean;
            error?: {
              message?: string;
            };
          }>("config.set", requestParams, requestOptions),
        );
        const error = res.error as
          | {
              message?: string;
              details?: {
                issues?: Array<{ path?: string; message?: string }>;
              };
            }
          | undefined;

        expect(res.ok).toBe(false);
        expect(error?.message ?? "").toContain("invalid config:");
        expect(error?.message ?? "").toContain("gateway.bind");
        expect(error?.message ?? "").toContain("allowed:");
        expect(error?.details?.issues?.[0]?.path).toBe("gateway.bind");
      });

      it("rejects config.patch when raw is null", async () => {
        const gatewayClient = requireClient();
        const requestParams = {
          raw: "null",
          baseHash: await getConfigHash(),
        };
        const res = await rpcReq((requestOptions) =>
          gatewayClient.request<{ ok?: boolean }>("config.patch", requestParams, requestOptions),
        );
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("raw must be an object");
      });

      it.each([
        { source: "a stale snapshot", legacyDuplicate: false },
        { source: "an invalid duplicate legacy roster", legacyDuplicate: true },
      ])(
        "rejects config.set when $source drops an agent entry without changing disk",
        async ({ legacyDuplicate }) => {
          const original = await getCurrentConfigObject();
          const includedGateway = { mode: "local", reload: { mode: "off" } };
          const includeRaw = `${JSON.stringify(includedGateway, null, 3)}\n`;
          let includePath: string | undefined;
          let rosterConfig = structuredClone(original.config);
          const agents = requireConfigObject(rosterConfig.agents ?? {}, "agents config");
          rosterConfig.agents = {
            ...agents,
            entries: {
              main: { default: true },
              worker: { workspace: "/srv/worker" },
            },
          };
          delete (rosterConfig.agents as Record<string, unknown>).list;

          await withConfigFileFixture(original.path, async () => {
            try {
              if (legacyDuplicate) {
                const configIo = await import("../config/io.js");
                const fixtureIncludePath = path.join(
                  path.dirname(original.path),
                  "retention-gateway.json",
                );
                await fs.writeFile(fixtureIncludePath, includeRaw, {
                  encoding: "utf-8",
                  flag: "wx",
                });
                includePath = fixtureIncludePath;
                rosterConfig = {
                  agents: {
                    list: [
                      { id: "Research", name: "First research agent" },
                      { id: "Research", name: "Second research agent" },
                    ],
                  },
                  gateway: { $include: path.basename(includePath) },
                  plugins: { enabled: false },
                };
                await writeJsonFile(original.path, rosterConfig);
                const snapshot = await configIo.readConfigFileSnapshot();
                expect(snapshot.valid).toBe(false);
                expect(snapshot.parsed).toEqual(rosterConfig);
                expect(snapshot.sourceConfig.gateway).toEqual(includedGateway);
              } else {
                await writeJsonFile(original.path, rosterConfig);
              }
              invalidateConfigGetResponseCache();
              const current = await getCurrentConfigObject();
              const staleConfig = legacyDuplicate
                ? {
                    agents: { entries: { research: { name: "First research agent" } } },
                    gateway: includedGateway,
                    plugins: { enabled: false },
                  }
                : structuredClone(current.config);
              if (legacyDuplicate) {
                expect(current.valid).toBe(false);
                expect(current.raw).toBeNull();
                expect(current.hash).not.toBe(original.hash);
              } else {
                const staleAgents = requireConfigObject(staleConfig.agents, "stale agents config");
                const staleEntries = requireConfigObject(
                  staleAgents.entries,
                  "stale agent entries",
                );
                delete staleEntries.worker;
              }
              const before = await fs.readFile(original.path, "utf-8");

              const res = await sendConfigSet(configRawPayload(staleConfig, current.hash));

              await expect(
                fs.readFile(original.path, "utf-8"),
                `config.set response ok=${String(res.ok)}`,
              ).resolves.toBe(before);
              if (includePath) {
                await expect(fs.readFile(includePath, "utf-8")).resolves.toBe(includeRaw);
              }

              expect(res.ok).toBe(false);
              if (legacyDuplicate) {
                expect(res.error?.message ?? "").toContain(
                  "Config write would drop agent roster entries without an explicit deletion: research-2.",
                );
              } else {
                expect(res.error?.code).toBe("INVALID_REQUEST");
                expect(res.error?.message ?? "").toContain("worker");
                expect(res.error?.message ?? "").toContain("agents.delete RPC");
                expect(res.error?.message ?? "").toContain("openclaw agents delete");
              }
            } finally {
              if (includePath) {
                await fs.rm(includePath, { force: true });
              }
            }
          });
        },
      );

      it("redacts browser cdpUrl credentials from config.get responses", async () => {
        const original = await getCurrentConfigObject();
        const configPath = original.path;
        await withConfigFileFixture(original.path, async () => {
          await writeJsonFile(configPath, {
            browser: {
              cdpUrl: "https://user:pass@chrome.browserless.io?token=supersecret123",
              profiles: {
                remote: {
                  cdpUrl: "https://alice:secret@chrome.remote.example.com?token=profile-secret",
                },
                local: {
                  cdpUrl: "ws://127.0.0.1:9222",
                },
              },
            },
          });
          invalidateConfigGetResponseCache();

          const after = await rpcReq((requestOptions) =>
            requireClient().request<{
              raw?: string | null;
              config?: {
                browser?: {
                  cdpUrl?: string;
                  profiles?: Record<string, { cdpUrl?: string }>;
                };
              };
            }>("config.get", {}, requestOptions),
          );
          expect(after.ok).toBe(true);
          expect(after.payload?.config?.browser?.cdpUrl).toBe("__OPENCLAW_REDACTED__");
          expect(after.payload?.config?.browser?.profiles?.remote?.cdpUrl).toBe(
            "__OPENCLAW_REDACTED__",
          );
          expect(after.payload?.config?.browser?.profiles?.local?.cdpUrl).toBe(
            "ws://127.0.0.1:9222",
          );
          if (typeof after.payload?.raw === "string") {
            expect(after.payload.raw).toContain("__OPENCLAW_REDACTED__");
            expect(after.payload.raw).not.toContain("supersecret123");
            expect(after.payload.raw).not.toContain("user:pass@");
            expect(after.payload.raw).not.toContain("profile-secret");
            expect(after.payload.raw).not.toContain("alice:secret@");
          }
        });
      });

      it("rejects config.patch that shrinks an existing array without replacePaths", async () => {
        const original = await getCurrentConfigObject();
        const bindings = [0, 1, 2].map(makeRouteBinding);
        const seededConfig = { ...original.config, bindings };

        await withConfigFileFixture(original.path, async () => {
          await writeJsonFile(original.path, seededConfig);
          invalidateConfigGetResponseCache();
          const before = await getCurrentConfigObject();
          const beforeRaw = await fs.readFile(original.path, "utf-8");
          const res = await rpcReq((requestOptions) =>
            requireClient().request<{ ok?: boolean }>(
              "config.patch",
              {
                raw: JSON.stringify({ bindings: [bindings[0]] }),
                baseHash: before.hash,
              },
              requestOptions,
            ),
          );

          expect(res.ok).toBe(false);
          expect(res.error?.message ?? "").toContain(
            "config.patch would remove entries from array path(s): bindings",
          );
          const after = await getCurrentConfigObject();
          expect(after.hash).toBe(before.hash);
          await expect(fs.readFile(original.path, "utf-8")).resolves.toBe(beforeRaw);
          expect(after.config.bindings).toEqual(bindings);
        });
      });

      it("rejects config.patch that removes existing array entries without shrinking length", async () => {
        const original = await getCurrentConfigObject();
        const bindings = [0, 1].map(makeRouteBinding);
        const seededConfig = { ...original.config, bindings };

        await withConfigFileFixture(original.path, async () => {
          await writeJsonFile(original.path, seededConfig);
          invalidateConfigGetResponseCache();
          const before = await getCurrentConfigObject();
          const beforeRaw = await fs.readFile(original.path, "utf-8");
          const res = await rpcReq((requestOptions) =>
            requireClient().request<{ ok?: boolean }>(
              "config.patch",
              {
                raw: JSON.stringify({ bindings: [bindings[1], makeRouteBinding(2)] }),
                baseHash: before.hash,
              },
              requestOptions,
            ),
          );

          expect(res.ok).toBe(false);
          expect(res.error?.message ?? "").toContain(
            "config.patch would remove entries from array path(s): bindings",
          );
          const after = await getCurrentConfigObject();
          expect(after.hash).toBe(before.hash);
          await expect(fs.readFile(original.path, "utf-8")).resolves.toBe(beforeRaw);
          expect(after.config.bindings).toEqual(bindings);
        });
      });

      it("rejects nested destructive array patches inside id-keyed arrays without replacePaths", async () => {
        const original = await getCurrentConfigObject();
        const agents = {
          ...(original.config.agents as Record<string, unknown> | undefined),
          ownership: "explicit",
          entries: {
            main: { skills: ["alpha", "beta"] },
            worker: { skills: ["gamma"] },
          },
        };

        await withConfigFileFixture(original.path, async () => {
          await writeJsonFile(original.path, { ...original.config, agents });
          invalidateConfigGetResponseCache();
          const before = await getCurrentConfigObject();
          const beforeRaw = await fs.readFile(original.path, "utf-8");
          const beforeEntries = (before.config.agents as { entries?: Record<string, unknown> })
            .entries;
          const res = await rpcReq((requestOptions) =>
            requireClient().request<{ ok?: boolean }>(
              "config.patch",
              {
                raw: JSON.stringify({ agents: { entries: { main: { skills: ["alpha"] } } } }),
                baseHash: before.hash,
              },
              requestOptions,
            ),
          );

          expect(res.ok).toBe(false);
          expect(res.error?.message ?? "").toContain(
            "config.patch would remove entries from array path(s): agents.entries.main.skills",
          );
          const after = await getCurrentConfigObject();
          expect(after.hash).toBe(before.hash);
          await expect(fs.readFile(original.path, "utf-8")).resolves.toBe(beforeRaw);
          expect((after.config.agents as { entries?: Record<string, unknown> }).entries).toEqual(
            beforeEntries,
          );
        });
      });

      it("rejects nested destructive array patches when replacePaths names only a parent object", async () => {
        const original = await getCurrentConfigObject();
        const agents = {
          ...(original.config.agents as Record<string, unknown> | undefined),
          ownership: "explicit",
          entries: {
            main: { skills: ["alpha", "beta"] },
            worker: { skills: ["gamma"] },
          },
        };

        await withConfigFileFixture(original.path, async () => {
          await writeJsonFile(original.path, { ...original.config, agents });
          invalidateConfigGetResponseCache();
          const before = await getCurrentConfigObject();
          const beforeRaw = await fs.readFile(original.path, "utf-8");
          const beforeEntries = (before.config.agents as { entries?: Record<string, unknown> })
            .entries;
          const res = await rpcReq((requestOptions) =>
            requireClient().request<{ ok?: boolean }>(
              "config.patch",
              {
                raw: JSON.stringify({ agents: { entries: { main: { skills: ["alpha"] } } } }),
                baseHash: before.hash,
                replacePaths: ["agents"],
              },
              requestOptions,
            ),
          );

          expect(res.ok).toBe(false);
          expect(res.error?.message ?? "").toContain(
            "config.patch would remove entries from array path(s): agents.entries.main.skills",
          );
          const after = await getCurrentConfigObject();
          expect(after.hash).toBe(before.hash);
          await expect(fs.readFile(original.path, "utf-8")).resolves.toBe(beforeRaw);
          expect((after.config.agents as { entries?: Record<string, unknown> }).entries).toEqual(
            beforeEntries,
          );
        });
      });

      it("rejects deleting a parent object that contains arrays without replacePaths", async () => {
        const original = await getCurrentConfigObject();
        const agents = {
          ...(original.config.agents as Record<string, unknown> | undefined),
          ownership: "explicit",
          entries: { main: { skills: ["alpha"] }, worker: {} },
        };

        await withConfigFileFixture(original.path, async () => {
          await writeJsonFile(original.path, { ...original.config, agents });
          invalidateConfigGetResponseCache();
          const before = await getCurrentConfigObject();
          const beforeRaw = await fs.readFile(original.path, "utf-8");
          const res = await rpcReq((requestOptions) =>
            requireClient().request<{ ok?: boolean }>(
              "config.patch",
              {
                raw: JSON.stringify({ agents: null }),
                baseHash: before.hash,
              },
              requestOptions,
            ),
          );

          expect(res.ok).toBe(false);
          expect(res.error?.message ?? "").toContain(
            "config.patch would remove entries from array path(s): agents.entries.main.skills",
          );
          const after = await getCurrentConfigObject();
          expect(after.hash).toBe(before.hash);
          await expect(fs.readFile(original.path, "utf-8")).resolves.toBe(beforeRaw);
        });
      });

      it("rejects deleting a nested parent object inside id-keyed arrays without replacePaths", async () => {
        const original = await getCurrentConfigObject();
        const agents = {
          ...(original.config.agents as Record<string, unknown> | undefined),
          ownership: "explicit",
          entries: {
            main: {
              subagents: { allowAgents: ["worker"] },
            },
            worker: {},
          },
        };

        await withConfigFileFixture(original.path, async () => {
          await writeJsonFile(original.path, { ...original.config, agents });
          invalidateConfigGetResponseCache();
          const before = await getCurrentConfigObject();
          const beforeRaw = await fs.readFile(original.path, "utf-8");
          const res = await rpcReq((requestOptions) =>
            requireClient().request<{ ok?: boolean }>(
              "config.patch",
              {
                raw: JSON.stringify({ agents: { entries: { main: { subagents: null } } } }),
                baseHash: before.hash,
              },
              requestOptions,
            ),
          );

          expect(res.ok).toBe(false);
          expect(res.error?.message ?? "").toContain(
            "config.patch would remove entries from array path(s): agents.entries.main.subagents.allowAgents",
          );
          const after = await getCurrentConfigObject();
          expect(after.hash).toBe(before.hash);
          await expect(fs.readFile(original.path, "utf-8")).resolves.toBe(beforeRaw);
        });
      });
    });

    describe("gateway config.apply", () => {
      it("rejects config.apply when SecretRef resolution fails", async () => {
        const missingEnvVar = `OPENCLAW_MISSING_SECRETREF_APPLY_${Date.now()}`;
        deleteTestEnvValue(missingEnvVar);
        const current = await getCurrentConfigObject();
        const nextConfig = configWithGatewayTokenSecretRef(current.config, missingEnvVar);

        const res = await sendConfigApply(
          configRawPayload(nextConfig, current.hash),
          secretRefRpcTimeoutMs,
        );
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("active SecretRef resolution failed");

        const after = await rpcReq((requestOptions) =>
          requireClient().request<{
            hash?: string;
            raw?: string | null;
          }>("config.get", {}, requestOptions),
        );
        expect(after.ok).toBe(true);
        expect(after.payload?.hash).toBe(current.hash);
        expect(after.payload?.raw).toBe(current.raw);
      });

      it("rejects invalid raw config", async () => {
        const currentHash = await getConfigHash();
        const res = await sendConfigApply({ raw: "{", baseHash: currentHash });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toMatch(/invalid|SyntaxError/i);
      });

      it("requires raw to be a string", async () => {
        const currentHash = await getConfigHash();
        const res = await sendConfigApply({
          raw: { gateway: { mode: "local" } },
          baseHash: currentHash,
        });
        expect(res.ok).toBe(false);
        expect(res.error?.message ?? "").toContain("raw");
      });
    });

    describe("gateway config schema lookup", () => {
      it("returns a path-scoped config schema lookup", async () => {
        const res = await rpcReq((requestOptions) =>
          requireClient().request<{
            path: string;
            hintPath?: string;
            children?: Array<{ key: string; path: string; required: boolean; hintPath?: string }>;
            schema?: { properties?: unknown };
          }>(
            "config.schema.lookup",
            {
              path: "gateway.auth",
            },
            requestOptions,
          ),
        );

        expect(res.ok, res.error?.message).toBe(true);
        expect(res.payload?.path).toBe("gateway.auth");
        expect(res.payload?.hintPath).toBe("gateway.auth");
        const tokenChild = res.payload?.children?.find((child) => child.key === "token");
        expect(tokenChild?.key).toBe("token");
        expect(tokenChild?.path).toBe("gateway.auth.token");
        expect(tokenChild?.hintPath).toBe("gateway.auth.token");
        expect(res.payload?.schema?.properties).toBeUndefined();
      });

      it("returns consistent help and reload metadata for plugin enablement", async () => {
        const res = await rpcReq((requestOptions) =>
          requireClient().request<{
            path: string;
            schema?: { description?: string };
            reloadKind?: string;
            hintPath?: string;
            hint?: { help?: string };
          }>(
            "config.schema.lookup",
            {
              path: "plugins.entries.sample-plugin.enabled",
            },
            requestOptions,
          ),
        );

        expect(res.ok, res.error?.message).toBe(true);
        expect(res.payload).toMatchObject({
          path: "plugins.entries.sample-plugin.enabled",
          reloadKind: "hot",
          hintPath: "plugins.entries.*.enabled",
        });
        const description = res.payload?.schema?.description;
        expect(description).toMatch(/default hybrid reload mode/i);
        expect(description).toMatch(/hot-reload the plugin runtime/i);
        expect(description).not.toMatch(/restart required/i);
        expect(res.payload?.hint?.help).toBe(description);
      });

      it("rejects config.schema.lookup when the path is missing", async () => {
        const res = await rpcReq((requestOptions) =>
          requireClient().request<{ ok?: boolean }>(
            "config.schema.lookup",
            {
              path: "gateway.notReal.path",
            },
            requestOptions,
          ),
        );

        expect(res.ok).toBe(false);
        expect(res.error?.message).toBe("config schema path not found");
      });

      it.each([
        { name: "rejects config.schema.lookup when the path is only whitespace", pathLocal: "   " },
        {
          name: "rejects config.schema.lookup when the path exceeds the protocol limit",
          pathLocal: `gateway.${"a".repeat(1020)}`,
        },
        {
          name: "rejects config.schema.lookup when the path contains invalid characters",
          pathLocal: "gateway.auth\nspoof",
        },
        {
          name: "rejects config.schema.lookup when the path is not a string",
          pathLocal: 42,
        },
      ])("$name", async ({ pathLocal }) => {
        const res = await rpcReq((requestOptions) =>
          requireClient().request("config.schema.lookup", { path: pathLocal }, requestOptions),
        );
        expect(res.ok).toBe(false);
        expect(res.error).toMatchObject({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("invalid config.schema.lookup params: at /path:"),
        });
      });

      it("rejects prototype-chain config.schema.lookup paths without reflecting them", async () => {
        const res = await rpcReq((requestOptions) =>
          requireClient().request<{ ok?: boolean }>(
            "config.schema.lookup",
            {
              path: "constructor",
            },
            requestOptions,
          ),
        );

        expect(res.ok).toBe(false);
        expect(res.error?.message).toBe("config schema path not found");
      });
    });
  });
}

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { prepareInstalledPackage } from "../../scripts/lib/gateway-bench-installed-package.ts";
import { verifyPackageMember } from "../../scripts/lib/windows-repair-package.mts";
import { packageRoot, prefix, readInput } from "./schtasks.installed-package.test-support.js";

const inputPath = process.argv[2];
assert.ok(inputPath);
const input = await readInput(inputPath);
const head = execFileSync("git", ["--no-optional-locks", "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
assert.equal(head, input.sourceSha);
assert.equal(head, input.toolingSha);
assert.equal(head, input.candidate.packageSourceSha);
execFileSync("git", ["--no-optional-locks", "diff", "--quiet", "HEAD", "--"]);
const selectedPrefix = prefix(input, "2026.9.4");
await prepareInstalledPackage({ ...input, installRoot: selectedPrefix });
const root = packageRoot(selectedPrefix);
const oldRoot = packageRoot(prefix(input, "2026.9.4-peer"));
const published = input.published.find((receipt) => receipt.version === "2026.9.4");
assert.ok(published);
const members = [
  "service-BzKA2MoQ.mjs",
  "service-CtaCtaGY.mjs",
  "update-command-service-maintenance-CT7mpZhp.mjs",
  "update-command-service-maintenance-Bc76z_xW.mjs",
  "schtasks-CELg2OWo.mjs",
  "stable-stringify-C8X7niaI.mjs",
  "update-command-service-plan-CPLT9k8F.mjs",
  "build-info.json",
];
const evidence = [];
for (const member of members) {
  evidence.push(
    await verifyPackageMember(oldRoot, published.tarball, path.join(oldRoot, "dist", member)),
  );
}
assert.equal(
  evidence[0]?.sha256,
  "7ebd13814abefa7561f2e559d0a23449ff2e8cc0b1a76d0b019a0a4718d102f7",
);
assert.equal(
  evidence[2]?.sha256,
  "456fbdf78533b773edc8cd84036125a975a65b4b62015deab913f029b0a743d1",
);
// These exact published facades have named exports; the generic ambiguity guard stays unchanged.
const oldService: Pick<
  typeof import("./service.js"),
  "readGatewayServiceState" | "resolveGatewayService"
> = await import(pathToFileURL(path.join(oldRoot, "dist", members[0]!)).href);
const oldMaintenance: Pick<
  typeof import("../cli/update-cli/update-command-service-maintenance.js"),
  "revalidateManagedGatewayServiceAfterUpdate"
> = await import(pathToFileURL(path.join(oldRoot, "dist", members[2]!)).href);
assert.equal(typeof oldService.readGatewayServiceState, "function");
assert.equal(typeof oldService.resolveGatewayService, "function");
assert.equal(typeof oldMaintenance.revalidateManagedGatewayServiceAfterUpdate, "function");
const candidateService = await import("./service.js");
const candidateMaintenance =
  await import("../cli/update-cli/update-command-service-maintenance.js");
const { resolveStartupEntryPaths } = await import("./schtasks-layout.js");
const args = { env: process.env, requireEffective: true, requireLoadedCommand: true };
const oldState = await oldService.readGatewayServiceState(oldService.resolveGatewayService(), args);
const candidateState = await candidateService.readGatewayServiceState(
  candidateService.resolveGatewayService(),
  args,
);
for (const state of [oldState, candidateState]) {
  assert.equal(state.installed, true);
  assert.equal(state.loadState.status, "loaded");
  assert.equal(state.running, false);
  assert.equal(state.runtime?.status, "stopped");
  assert.equal(state.runtime?.pid, undefined);
  assert.equal(state.definitionMutationCapability, undefined);
  assert.ok(state.command);
}
assert.ok(oldState.command && candidateState.command);
assert.equal(oldState.command.startupEntryPaths, undefined);
const { startupEntryPaths, ...candidateCommand } = candidateState.command;
assert.ok(startupEntryPaths && startupEntryPaths.length === 2);
assert.deepEqual(startupEntryPaths.toSorted(), resolveStartupEntryPaths(process.env).toSorted());
assert.deepEqual(candidateCommand, oldState.command);
const oldVerdict = await oldMaintenance.revalidateManagedGatewayServiceAfterUpdate({
  root,
  state: oldState,
});
assert.ok(oldVerdict.kind === "owned");
assert.equal(oldVerdict.refreshDefinition, true);
const candidateVerdict = await candidateMaintenance.revalidateManagedGatewayServiceAfterUpdate({
  root,
  state: candidateState,
  preManagedServiceStop: { serviceEnv: oldState.env, serviceUpdateVerdict: oldVerdict },
});
assert.ok(candidateVerdict.kind === "owned");
assert.equal(candidateVerdict.refreshDefinition, true);
// Writable revalidation can accept drift; equality independently proves the legacy fingerprint contract.
assert.equal(candidateVerdict.fingerprint, oldVerdict.fingerprint);
console.log(
  JSON.stringify({
    scope:
      "unchanged published 2026.9.4 helper × exact candidate source owner on real stopped Startup definition",
    sourceSha: head,
    publishedTarballSha256: published.sha256,
    evidence,
    oldFingerprint: oldVerdict.fingerprint,
    candidateFingerprint: candidateVerdict.fingerprint,
    selectedStartupEntries: startupEntryPaths,
    refreshDefinition: true,
    packagedCandidateFacadeProof: false,
    protectedAuthorityProof: false,
    fullUpgradeProof: false,
  }),
);

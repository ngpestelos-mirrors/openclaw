import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { requireDirectorySync, syncDirectory } from "./directory-durability.js";
import {
  readPackageActivationRecordStatus,
  resolvePackageActivationAnchor,
  resolvePackageActivationHelper,
  type PackageActivationJournal,
  type PackageActivationRecord,
  type PackageActivationPhase,
  type PackageActivationIntent,
} from "./package-update-activation-journal.js";
import {
  assertPackageReverseBinding,
  assertPackageReverseTarget,
  assertReverseLauncher,
  readPackageReverseGenerations,
} from "./package-update-activation-reverse-binding.js";
import {
  assertReverseParents,
  readPackageReverseImage,
  syncPackageReverseInputs,
} from "./package-update-activation-reverse-files.js";
import { readPackageReverseResourceCustody } from "./package-update-activation-reverse-resources.js";
import {
  packageActivationReverseBindingSchema,
  type PackageActivationReverseBinding,
  type PackageActivationReverseIntent,
  type PackageActivationReverseResource,
} from "./package-update-activation-reverse-schema.js";
import { renamePackageReverseResource } from "./package-update-activation-symlink.js";
import {
  capturePackageReverseExecutor,
  assertPackageReverseExecutor,
} from "./package-update-reverse-authority.js";
import type { UpdateRecoveryPublicationCompletion } from "./package-update-swap-contract.js";
import {
  assertUpdateRecoverySourceAttestationCurrent,
  assertUpdateRecoverySourceAttestationAdmission,
} from "./update-recovery-source-attestation.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

/** Live maintenance and selected-runtime validation are supplied by the existing
 * preservation owner. Neither serialized admission nor callback success proves
 * publication: every effect is independently reconciled against recorded inodes. */
export type PackageReverseAuthority = {
  assertCurrent: () => void;
  assertWritersSettled: () => void;
  /** Mandatory for first admission. The producer compares the immutable ref/body
   * with its original pre-snapshot capture under continuing stopped-C maintenance.
   * A schema pass, current re-stat, or a caller-authored object is not capture proof.
   * Resume uses the already authenticated durable binding, not a new capture. */
  assertCapturedSource?: (
    ref: Readonly<import("./update-recovery-source-schema.js").UpdateRecoverySourceRef>,
    source: Readonly<import("./update-recovery-source-schema.js").UpdateRecoverySourceAttestation>,
  ) => void;
  validateTarget: (binding: Readonly<PackageActivationReverseBinding>) => Promise<void>;
  /** Retire only the admitted prior state selection. Executor/maintenance ownership
   * remains live through publication, settlement and completion verification. */
  beforeStatePublication: (binding: Readonly<PackageActivationReverseBinding>) => void;
};
function captureAuthority(authority: PackageReverseAuthority): PackageReverseAuthority {
  return {
    assertCurrent: authority.assertCurrent.bind(authority),
    assertWritersSettled: authority.assertWritersSettled.bind(authority),
    assertCapturedSource: authority.assertCapturedSource?.bind(authority),
    validateTarget: authority.validateTarget.bind(authority),
    beforeStatePublication: authority.beforeStatePublication.bind(authority),
  };
}
export function packageReverseBindingDigest(binding: PackageActivationReverseBinding) {
  return createHash("sha256")
    .update(JSON.stringify(packageActivationReverseBindingSchema.parse(binding)))
    .digest("hex");
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
export async function observePackageReverseResources(record: PackageActivationRecord) {
  const binding = record.descriptor.reverse;
  if (!binding) {
    throw new Error("Reverse publication has no bound generation.");
  }
  assertPackageReverseBinding(binding, record.descriptor);
  const rows = [];
  for (const resource of binding.resources) {
    assertReverseParents(resource);
    const read = async (file: string) => {
      let logical: string | undefined;
      if (resource.role === "package" && fs.lstatSync(file, { throwIfNoEntry: false })) {
        const stat = fs.lstatSync(file, { bigint: true });
        const identity = `${stat.dev}:${stat.ino}`;
        logical =
          identity === record.descriptor.previous.identity
            ? record.descriptor.authority.installKey
            : record.descriptor.originalStageRoot;
      }
      return readPackageReverseImage(file, logical);
    };
    const live = await read(resource.live);
    if (!resource.move) {
      if (!isDeepStrictEqual(live, resource.after)) {
        throw new Error("Unchanged reverse resource was replaced.");
      }
      rows.push("unchanged" as const);
      continue;
    }
    const staged = await read(resource.move.staged);
    const displaced = await read(resource.move.displaced);
    const missing = { kind: "missing" };
    const equal = isDeepStrictEqual;
    const state =
      equal(live, resource.after) && equal(staged, missing) && equal(displaced, resource.before)
        ? "published"
        : equal(live, resource.before) && equal(staged, resource.after) && equal(displaced, missing)
          ? "initial"
          : equal(live, missing) &&
              equal(staged, resource.after) &&
              equal(displaced, resource.before)
            ? "displaced"
            : undefined;
    if (!state) {
      throw new Error(`Reverse publication lost exact resource custody: ${resource.live}`);
    }
    rows.push(state);
  }
  return rows;
}
function assertProgress(
  record: PackageActivationRecord,
  rows: Awaited<ReturnType<typeof observePackageReverseResources>>,
) {
  if (record.intent?.kind !== "reverse" || !record.descriptor.reverse) {
    throw new Error("Reverse progress is missing.");
  }
  const { completed, effect } = record.intent;
  if (completed > rows.length || (completed === rows.length && effect !== null)) {
    throw new Error("Reverse progress is invalid.");
  }
  rows.forEach((row, i) => {
    if (row === "unchanged") {
      return;
    }
    const resource = record.descriptor.reverse!.resources[i]!;
    const allowed =
      i < completed
        ? ["published"]
        : i > completed || effect === null
          ? ["initial"]
          : effect === "displace"
            ? ["initial", "displaced", ...(resource.after.kind === "missing" ? ["published"] : [])]
            : [
                "displaced",
                "published",
                ...(resource.before.kind === "missing" ? ["initial"] : []),
              ];
    if (!allowed.includes(row)) {
      throw new Error("Reverse filesystem effect has no durable progress intent.");
    }
  });
  if (record.phase === "reverse-complete" && completed !== rows.length) {
    throw new Error("Reverse completion is not exhaustive.");
  }
}
async function syncParents(resource: PackageActivationReverseResource) {
  if (!resource.move) {
    return;
  }
  for (const parent of new Set(
    [resource.live, resource.move.staged, resource.move.displaced].map((file) =>
      path.dirname(file),
    ),
  )) {
    requireDirectorySync(await syncDirectory(parent), "Reverse resource publication");
  }
}
async function inspectTargetAndLaunchers(
  record: PackageActivationRecord,
  rows: Awaited<ReturnType<typeof observePackageReverseResources>>,
) {
  const binding = record.descriptor.reverse!;
  const index = binding.resources.findIndex((r) => r.role === "package");
  const resource = binding.resources[index]!;
  await assertPackageReverseTarget(
    binding,
    record.descriptor,
    rows[index] === "published" ? resource.live : resource.move!.staged,
  );
  for (const entry of record.descriptor.launchers) {
    const r = binding.resources.find(
      (v) => v.live === path.join(record.descriptor.binDir, entry.name),
    )!;
    const state = rows[binding.resources.indexOf(r)];
    await assertReverseLauncher(
      state === "published" || !r.move ? r.live : r.move.staged,
      entry.previous,
    );
  }
}
export function createPackageActivationReverseOwner(params: {
  journal: PackageActivationJournal;
  current: () => PackageActivationRecord;
  transition: (
    phase: PackageActivationPhase,
    intent: PackageActivationIntent,
    publications?: PackageActivationRecord["publications"],
    reverse?: PackageActivationReverseBinding,
    assertExecutor?: () => void,
  ) => void;
  assertCurrent: (assertExecutor?: () => void) => void;
  verifyClosure: (assertExecutor?: () => void) => Promise<void>;
  verifyForward: (assertExecutor?: () => void) => Promise<void>;
  executor?: ReturnType<typeof capturePackageReverseExecutor>;
  fence?: UpdateRecoveryFence;
  resuming?: boolean;
}) {
  const originalRunId = params.current().descriptor.originalRunId;
  const executor = Object.hasOwn(params, "executor")
    ? params.executor
    : params.fence && originalRunId
      ? capturePackageReverseExecutor(params.fence, originalRunId, params.resuming === true)
      : undefined;
  const assertExecutor = () => {
    if (!executor || !originalRunId) {
      throw new Error("Reverse publication requires a live registered executor.");
    }
    return assertPackageReverseExecutor(executor, originalRunId, params.resuming === true);
  };
  const assertReverseCurrent = () => {
    assertExecutor();
    params.assertCurrent(assertExecutor);
  };
  const transition: typeof params.transition = (phase, intent, publications, reverse) =>
    params.transition(phase, intent, publications, reverse, assertExecutor);
  const assertAuthority = (
    binding: Pick<PackageActivationReverseBinding, "runId">,
    guard: Pick<PackageReverseAuthority, "assertCurrent" | "assertWritersSettled">,
  ) => {
    const authority = assertExecutor();
    if (binding.runId !== originalRunId) {
      throw new Error("Reverse publication changed its captured original run.");
    }
    const original = params.current().descriptor.authority;
    if (params.resuming) {
      const { owner: _owner, ...current } = authority;
      const { owner: _originalOwner, ...expected } = original;
      if (!isDeepStrictEqual(current, expected) || !params.current().descriptor.reverse) {
        throw new Error("Reverse continuation changed original authority.");
      }
    } else if (!isDeepStrictEqual(authority, original)) {
      throw new Error("Reverse admission requires the original operation owner.");
    }
    guard.assertCurrent();
    guard.assertWritersSettled();
    assertReverseCurrent();
  };
  const verifyCapturedSource = async (
    binding: PackageActivationReverseBinding,
    guard: PackageReverseAuthority,
  ) => {
    assertAuthority(binding, guard);
    const { candidate, sourceAttestation } = assertPackageReverseBinding(
      binding,
      params.current().descriptor,
    );
    const assertCurrent = () => assertAuthority(binding, guard);
    let assertOriginalCapture: (() => void) | undefined;
    if (params.resuming) {
      await assertUpdateRecoverySourceAttestationCurrent(
        sourceAttestation,
        candidate.entries,
        assertCurrent,
      );
    } else {
      assertOriginalCapture = await assertUpdateRecoverySourceAttestationAdmission(
        sourceAttestation,
        candidate.entries,
        {
          assertCurrent,
          assertCapturedSource: guard.assertCapturedSource,
          sourceAttestation: binding.sourceAttestation,
        },
      );
    }
    assertAuthority(binding, guard);
    return assertOriginalCapture;
  };
  const inspect = async (guard: PackageReverseAuthority) => {
    const record = params.current();
    const binding = record.descriptor.reverse;
    if (!binding) {
      throw new Error("Reverse binding is missing.");
    }
    assertAuthority(binding, guard);
    await params.verifyClosure(assertExecutor);
    const rows = await observePackageReverseResources(record);
    assertProgress(record, rows);
    await inspectTargetAndLaunchers(record, rows);
    assertAuthority(binding, guard);
    return rows;
  };
  const publish = async (guard: PackageReverseAuthority) => {
    const binding = params.current().descriptor.reverse!;
    if (!["reverse-in-progress", "reverse-complete"].includes(params.current().phase)) {
      throw new Error("Operation is not a restartable reverse publication.");
    }
    assertAuthority(binding, guard);
    await guard.validateTarget(freeze(packageActivationReverseBindingSchema.parse(binding)));
    const initialRows = await inspect(guard);
    let assertOriginalCapture: (() => void) | undefined;
    if (initialRows.every((row) => row === "initial" || row === "unchanged")) {
      assertOriginalCapture = await verifyCapturedSource(binding, guard);
    }
    // A resumed partial publication has already retired the prior selection. Its
    // recorded images, not a fresh admission of the old live inode, govern resume.
    let statePublicationStarted = binding.resources.some(
      (resource, index) =>
        resource.role === "state" && resource.move && initialRows[index] !== "initial",
    );
    const beforeEffect = (resource: PackageActivationReverseResource) => {
      assertAuthority(binding, guard);
      // The last inspection awaited closure and image reads. Proof can be
      // independently revoked there; check the retained admission at the effect.
      assertOriginalCapture?.();
      if (resource.role === "state" && !statePublicationStarted) {
        guard.beforeStatePublication(binding);
        statePublicationStarted = true;
        assertAuthority(binding, guard);
      }
      assertOriginalCapture?.();
      // Once an effect is issued, durable intent/images govern partial resume.
      // Never demand a fresh capture of the now-displaced C source.
      assertOriginalCapture = undefined;
    };
    while (params.current().phase !== "reverse-complete") {
      // SAFETY: inspect validated reverse intent; exclusive transitions preserve its kind.
      const progress = params.current().intent as PackageActivationReverseIntent;
      const resource = binding.resources[progress.completed];
      if (!resource) {
        transition("reverse-complete", { ...progress, effect: null });
        break;
      }
      if (resource.move) {
        if (progress.effect === null) {
          transition("reverse-in-progress", { ...progress, effect: "displace" });
        }
        let rows = await inspect(guard);
        if (rows[progress.completed] === "initial" && resource.before.kind !== "missing") {
          beforeEffect(resource);
          await renamePackageReverseResource(resource.live, resource.move.displaced);
          await syncParents(resource);
        }
        await inspect(guard);
        await syncParents(resource);
        assertAuthority(binding, guard);
        transition("reverse-in-progress", { ...progress, effect: "publish" });
        rows = await inspect(guard);
        if (rows[progress.completed] !== "published" && resource.after.kind !== "missing") {
          beforeEffect(resource);
          await renamePackageReverseResource(resource.move.staged, resource.live);
        }
        // Also sync observed lost acknowledgements before advancing the journal.
        await syncParents(resource);
        rows = await inspect(guard);
        if (rows[progress.completed] !== "published") {
          throw new Error("Reverse publication postimage is incomplete.");
        }
      }
      assertAuthority(binding, guard);
      transition("reverse-in-progress", {
        kind: "reverse",
        direction: "reverse",
        completed: progress.completed + 1,
        effect: null,
      });
    }
    await inspect(guard);
    return readPackageActivationRecordStatus(params.current());
  };
  let active = false;
  const exclusively = async <T>(run: () => Promise<T>) => {
    if (active) {
      throw new Error("Reverse publication is already in flight.");
    }
    active = true;
    try {
      return await run();
    } finally {
      active = false;
    }
  };
  return {
    assertReverseCurrent,
    resourceCustody: (
      authority: Pick<PackageReverseAuthority, "assertCurrent" | "assertWritersSettled">,
    ) => {
      // Capture callbacks before the first await; this is resource inspection,
      // not startup admission and never calls validateTarget.
      const guard = {
        assertCurrent: authority.assertCurrent.bind(authority),
        assertWritersSettled: authority.assertWritersSettled.bind(authority),
      };
      return exclusively(async () => {
        const record = params.current();
        const runId = record.descriptor.originalRunId;
        if (
          !runId ||
          params.resuming ||
          record.phase !== "publication-complete" ||
          record.descriptor.reverse
        ) {
          throw new Error("Resource custody requires the untouched original publication.");
        }
        const assertCurrent = () => {
          assertAuthority({ runId }, guard);
          params.journal.assertCurrent(record);
        };
        assertCurrent();
        await params.verifyForward(assertExecutor);
        assertCurrent();
        const result = await readPackageReverseResourceCustody(record, assertCurrent);
        assertCurrent();
        return freeze(result);
      });
    },
    reverse: (bindingInput: PackageActivationReverseBinding, authority: PackageReverseAuthority) =>
      exclusively(async () => {
        const guard = captureAuthority(authority);
        const binding = freeze(packageActivationReverseBindingSchema.parse(bindingInput));
        const record = params.current();
        if (
          record.phase !== "publication-complete" ||
          record.descriptor.reverse ||
          params.resuming
        ) {
          throw new Error(
            "Reverse admission requires an untouched original completed publication.",
          );
        }
        assertAuthority(binding, guard);
        const generations = assertPackageReverseBinding(binding, record.descriptor);
        await verifyCapturedSource(binding, guard);
        await params.verifyForward(assertExecutor);
        const provisional = {
          ...record,
          phase: "reverse-in-progress" as const,
          descriptor: { ...record.descriptor, reverse: binding },
          intent: {
            kind: "reverse" as const,
            direction: "reverse" as const,
            completed: 0,
            effect: null,
          },
        };
        const rows = await observePackageReverseResources(provisional);
        assertProgress(provisional, rows);
        await inspectTargetAndLaunchers(provisional, rows);
        await guard.validateTarget(binding);
        await syncPackageReverseInputs(
          binding.resources,
          () => assertAuthority(binding, guard),
          (["baseline", "candidate", "prepared"] as const).map((kind) => ({
            directory: binding[kind].directory,
            files: [
              binding[kind].manifestPath,
              ...generations[kind].entries.flatMap((entry) =>
                entry.kind === "file"
                  ? [path.join(binding[kind].directory, entry.archivePath)]
                  : [],
              ),
            ],
          })),
          [
            resolvePackageActivationHelper(
              resolvePackageActivationAnchor(record.descriptor.authority.installKey),
            ),
            binding.sourceAttestation.path,
            binding.target.nodePath,
            record.descriptor.authority.databasePath,
          ],
        );
        await params.verifyClosure(assertExecutor);
        assertProgress(provisional, await observePackageReverseResources(provisional));
        await inspectTargetAndLaunchers(provisional, rows);
        assertAuthority(binding, guard);
        const assertPinCapture = await verifyCapturedSource(binding, guard);
        assertPinCapture?.();
        // The immutable binding and reverse direction commit in the SAME journal
        // transaction before any live package, launcher or state effect.
        transition("reverse-in-progress", provisional.intent, undefined, binding);
        return publish(guard);
      }),
    // Completion proof belongs to the still-held, pre-first-writer maintenance
    // scope. It is not a permanent assertion that serving state must equal T.
    verifyCompletion: (
      bindingInput: Readonly<PackageActivationReverseBinding>,
      guard: PackageReverseAuthority,
    ) =>
      exclusively(async () => {
        const binding = freeze(packageActivationReverseBindingSchema.parse(bindingInput));
        const record = params.current();
        if (
          params.resuming ||
          record.phase !== "rolled-back" ||
          record.intent?.kind !== "reverse" ||
          record.intent.completed !== binding.resources.length ||
          record.intent.effect !== null ||
          !isDeepStrictEqual(record.descriptor.reverse, binding)
        ) {
          throw new Error("Reverse completion requires the exact settled original binding.");
        }
        assertAuthority(binding, guard);
        params.journal.assertCurrent(record);
        await guard.validateTarget(binding);
        const rows = await inspect(guard);
        if (rows.some((row) => row !== "published" && row !== "unchanged")) {
          throw new Error("Reverse completion is not exhaustively published.");
        }
        assertAuthority(binding, guard);
        // Another owner operation may have advanced the record during an await.
        // Checking only the owner's latest record would accept that revision.
        params.journal.assertCurrent(record);
        const { prepared } = readPackageReverseGenerations(
          binding,
          binding.runId,
          record.descriptor.authority.installKey,
        );
        const globalOwners =
          prepared.databases?.filter((database) => database.role === "global") ?? [];
        const states = binding.resources.filter(
          (resource) => resource.role === "state" && resource.live === globalOwners[0]?.path,
        );
        const state = states[0];
        if (
          globalOwners.length !== 1 ||
          states.length !== 1 ||
          !state ||
          state.after.kind !== "file"
        ) {
          throw new Error(
            "Reverse completion requires exactly one recorded global state database.",
          );
        }
        return freeze({
          ...readPackageActivationRecordStatus(record),
          publishedState: {
            operationId: binding.operationId,
            runId: binding.runId,
            baseline: binding.baseline,
            candidate: binding.candidate,
            prepared: binding.prepared,
            target: binding.target,
            bindingDigest: packageReverseBindingDigest(binding),
            state: {
              databasePath: state.live,
              databaseIdentity: state.after.identity,
              parentIdentity: state.parentIdentity,
            },
          },
        }) satisfies UpdateRecoveryPublicationCompletion;
      }),
    resumeReverse: (authority: PackageReverseAuthority) =>
      exclusively(() => publish(captureAuthority(authority))),
    settleReverse: (guard: PackageReverseAuthority) =>
      exclusively(async () => {
        if (params.current().phase !== "reverse-complete") {
          throw new Error("Incomplete reverse publication cannot settle or release evidence.");
        }
        await inspect(guard);
        const binding = params.current().descriptor.reverse!;
        const publications = binding.resources
          .filter((r) => r.role === "launcher" && r.after.kind !== "missing")
          .map((r) => ({
            name: path.basename(r.live),
            // SAFETY: the preceding filter excludes missing postimages.
            identity: (r.after as Exclude<typeof r.after, { kind: "missing" }>).identity,
          }));
        assertAuthority(binding, guard);
        transition("rolled-back", params.current().intent, publications);
        return readPackageActivationRecordStatus(params.current());
      }),
  };
}

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  getOpenClawDatabaseMaintenanceScope,
  type OpenClawDatabaseMaintenanceScope,
} from "../state/openclaw-state-db-async-lifecycle.js";
import {
  packageActivationReverseBindingSchema,
  type PackageActivationReverseBinding,
} from "./package-update-activation-reverse-schema.js";
import type {
  PackageUpdateTransaction,
  PackageReversePublication,
} from "./package-update-swap-contract.js";
import { admitUpdateInitialStores } from "./update-initial-store-admission.js";

type Admission = ReturnType<typeof admitUpdateInitialStores>;
type Authority = Omit<
  Parameters<PackageReversePublication["publish"]>[1],
  "beforeStatePublication"
>;

function refuse(reason: string): never {
  throw new Error(`Update recovery generation admission refused: ${reason}`);
}

/** Consume completion in the ORIGINAL transaction/maintenance lifetime. The caller
 * still owns both scopes and must retain the returned admission through its own
 * readers/writers. This neither acquires owners nor starts/restarts a Gateway.
 * Startup admission alone is not accepted here as a publication receipt. */
export async function publishUpdateRecoveryGeneration(params: {
  binding: PackageActivationReverseBinding;
  transaction: PackageUpdateTransaction;
  maintenance: OpenClawDatabaseMaintenanceScope;
  authority: Authority;
  initialStores: Admission;
}) {
  const publication = params.transaction.reversePublication;
  if (!publication) {
    refuse("original reverse transaction is unavailable");
  }
  const binding = packageActivationReverseBindingSchema.parse(params.binding);
  const freeze = (value: object): void => {
    for (const child of Object.values(value)) {
      if (child && typeof child === "object") {
        freeze(child);
      }
    }
    Object.freeze(value);
  };
  freeze(binding);
  // Same canonical schema serialization as packageReverseBindingDigest. Do not
  // hash a caller-mutated request after an await or restat a published generation.
  const digest = createHash("sha256").update(JSON.stringify(binding)).digest("hex");
  const initial = params.initialStores;
  const selection = initial.selection;
  const originalAssert = params.authority.assertCurrent.bind(params.authority);
  const originalWriters = params.authority.assertWritersSettled.bind(params.authority);
  const maintenance = params.maintenance;
  const originalMaintenance = maintenance.assertAdmission.bind(maintenance);
  const validateTarget = params.authority.validateTarget.bind(params.authority);
  const assertCapturedSource = params.authority.assertCapturedSource?.bind(params.authority);
  const publish = publication.publish.bind(publication);
  const settle = publication.settle.bind(publication);
  const verify = publication.verifyCompletion.bind(publication);
  const assertHeld = () => {
    if (getOpenClawDatabaseMaintenanceScope() !== maintenance) {
      refuse("original maintenance scope is not active");
    }
    originalAssert();
    originalMaintenance();
    originalWriters();
  };
  assertHeld();
  initial.assertCurrent();
  const selected = publication.selection();
  if (selected.operationId !== binding.operationId || selected.originalRunId !== binding.runId) {
    refuse("binding changed original operation or run");
  }
  const states = binding.resources.filter(
    (resource) => resource.role === "state" && resource.live === selection.state.databasePath,
  );
  const state = states[0];
  if (
    states.length !== 1 ||
    !state ||
    state.before.kind !== "file" ||
    state.after.kind !== "file" ||
    state.before.identity !== selection.state.databaseIdentity ||
    state.parentIdentity !== selection.state.parentIdentity
  ) {
    refuse("binding does not preserve the selected global state path and parent");
  }
  const packages = binding.resources.filter((resource) => resource.role === "package");
  const installation = packages[0];
  if (
    packages.length !== 1 ||
    !installation ||
    installation.live !== selection.installation.path ||
    installation.before.kind !== "package" ||
    installation.after.kind !== "package" ||
    installation.before.identity !== selection.installation.identity
  ) {
    refuse("package binding does not match the selected installation");
  }
  let retired = false;
  const retire = (selectedBinding: Readonly<PackageActivationReverseBinding>) => {
    assertHeld();
    if (retired || !isDeepStrictEqual(selectedBinding, binding)) {
      refuse("publication retirement changed the selected binding or was repeated");
    }
    initial.assertCurrent();
    initial.close();
    retired = true;
  };
  const authority: Parameters<PackageReversePublication["publish"]>[1] = {
    assertCurrent: assertHeld,
    assertWritersSettled: originalWriters,
    validateTarget,
    assertCapturedSource,
    beforeStatePublication: retire,
  };
  // The provider callback precedes the first state effect. If all state is
  // unchanged, retire here before a package-only inode transition can occur.
  if (!binding.resources.some((resource) => resource.role === "state" && resource.move)) {
    retire(binding);
  }
  await publish(binding, authority);
  assertHeld();
  await settle(authority);
  assertHeld();
  const completion = await verify(binding, authority);
  assertHeld();
  const generation = completion.publishedState;
  if (
    completion.phase !== "rolled-back" ||
    completion.operationId !== binding.operationId ||
    completion.installKey !== selection.installation.path ||
    !generation ||
    !isDeepStrictEqual(
      {
        operationId: generation.operationId,
        runId: generation.runId,
        baseline: generation.baseline,
        candidate: generation.candidate,
        prepared: generation.prepared,
        target: generation.target,
        bindingDigest: generation.bindingDigest,
        state: generation.state,
      },
      {
        operationId: binding.operationId,
        runId: binding.runId,
        baseline: binding.baseline,
        candidate: binding.candidate,
        prepared: binding.prepared,
        target: binding.target,
        bindingDigest: digest,
        state: {
          databasePath: state.live,
          databaseIdentity: state.after.identity,
          parentIdentity: state.parentIdentity,
        },
      },
    )
  ) {
    refuse("completion does not match the recorded operation/run/B/C/T/target/state");
  }
  if (!retired) {
    // No state effect is possible only when every state resource is unchanged.
    if (binding.resources.some((resource) => resource.role === "state" && resource.move)) {
      refuse("publication did not retire the prior selection before state effects");
    }
    initial.assertCurrent();
    initial.close();
  }
  const admission = admitUpdateInitialStores({
    privateRoot: selection.privateRoot,
    // verifyCompletion authenticates the full binding (including this unique
    // package after-image) against the original journal. Never adopt a restat.
    installation: {
      path: selection.installation.path,
      identity: installation.after.identity,
    },
    handoff: selection.handoff,
    state: generation.state,
  });
  try {
    assertHeld();
    admission.assertCurrent();
    return { completion, admission };
  } catch (error) {
    admission.close();
    throw error;
  }
}

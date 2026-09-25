import path from "node:path";
import { z } from "zod";
import { updateRecoverySourceRefSchema } from "./update-recovery-source-schema.js";

const absolute = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => !v.includes("\0") && path.resolve(v) === v);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const identity = z.string().regex(/^\d+:\d+$/u);
const metadata = {
  identity,
  uid: z.string().regex(/^\d+$/u),
  gid: z.string().regex(/^\d+$/u),
  mode: z.number().int().min(0).max(0o7777),
};
const reverseImageSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("missing") }),
  z.strictObject({ kind: z.literal("directory"), ...metadata }),
  z.strictObject({
    kind: z.literal("file"),
    ...metadata,
    sha256: digest,
    size: z.number().int().nonnegative(),
  }),
  z.strictObject({ kind: z.literal("symlink"), ...metadata, target: z.string().max(4096) }),
  z.strictObject({
    kind: z.literal("package"),
    ...metadata,
    digest,
    version: z.string().min(1).max(256),
  }),
]);
const ref = z.strictObject({ directory: absolute, manifestPath: absolute, manifestSha256: digest });
export const packageActivationPreviousRuntimeSchema = z.strictObject({
  packageManifestSha256: digest,
  buildInfoSha256: digest.nullable(),
  buildId: z.string().min(1).max(512).nullable(),
  sourceCommit: z
    .string()
    .regex(/^[a-f0-9]{40}$/u)
    .nullable(),
  inventoryDigest: digest,
  nodeVersion: z.string().min(1).max(256),
  nodePath: absolute,
  node: z.strictObject({
    kind: z.literal("file"),
    ...metadata,
    sha256: digest,
    size: z.number().int().nonnegative(),
  }),
  entrypoint: z
    .string()
    .min(1)
    .max(4096)
    .refine(
      (v) =>
        !path.isAbsolute(v) &&
        !v.includes("\\") &&
        !v.includes("\0") &&
        v.split("/").every((p) => p !== ".." && p !== "." && p !== ""),
    )
    .nullable(),
  entrypointSha256: digest.nullable(),
});

export const packageActivationReverseBindingSchema = z.strictObject({
  protocol: z.literal("package-state-reverse-v1"),
  operationId: z.uuid(),
  runId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/u),
  baseline: ref,
  candidate: ref,
  prepared: ref,
  // Sealed with the reverse direction in the original journal transaction.
  sourceAttestation: updateRecoverySourceRefSchema,
  target: packageActivationPreviousRuntimeSchema.extend({
    buildInfoSha256: digest,
    buildId: z.string().min(1).max(512),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
    entrypoint: packageActivationPreviousRuntimeSchema.shape.entrypoint.unwrap(),
    entrypointSha256: digest,
    admissionSha256: digest,
    startupProtocol: z.literal("package-state-reverse-v1"),
  }),
  resources: z
    .array(
      z.strictObject({
        role: z.enum(["state", "package", "launcher"]),
        live: absolute,
        parentIdentity: identity,
        before: reverseImageSchema,
        after: reverseImageSchema,
        // Null means an unchanged resource. Moving resources retain both original
        // inodes; immutable B/C/T payloads are never used as rename sources.
        move: z
          .strictObject({
            staged: absolute,
            stagedParentIdentity: identity,
            displaced: absolute,
            displacedParentIdentity: identity,
          })
          .nullable(),
      }),
    )
    .min(1),
});
export type PackageActivationReverseBinding = z.infer<typeof packageActivationReverseBindingSchema>;
export type PackageActivationReverseImage = z.infer<typeof reverseImageSchema>;
export type PackageActivationReverseResource = PackageActivationReverseBinding["resources"][number];
export const packageActivationReverseIntentSchema = z.strictObject({
  kind: z.literal("reverse"),
  direction: z.literal("reverse"),
  completed: z.number().int().nonnegative(),
  effect: z.enum(["displace", "publish"]).nullable(),
});
export type PackageActivationReverseIntent = z.infer<typeof packageActivationReverseIntentSchema>;

import { isErrno } from "./errors.js";
import type {
  StagedPackageSwapParams,
  StagedPackageSwapResult,
} from "./package-update-swap-contract.js";
import { createUpdateFailureFact } from "./update-failure-facts.js";
import type { NpmGlobalPrefixLayout } from "./update-npm-prefix.js";
import type { UpdateStepResult } from "./update-runner-types.js";

/** Result reporting shares warnings with the swap owner but never performs recovery effects. */
export function createPackageSwapResults(
  params: StagedPackageSwapParams,
  targetLayout: Pick<NpmGlobalPrefixLayout, "globalRoot"> | null,
  targetPackageRoot: string | null,
  startedAt: number,
) {
  const warnings: string[] = [];
  const step = (
    exitCode: number,
    stdoutTail: string | null,
    stderrTail: string | null,
    code = "swap-failed",
  ): UpdateStepResult => ({
    name: "package-swap",
    command: `swap ${params.stage.packageRoot} -> ${targetPackageRoot ?? "unknown root"}`,
    cwd: targetLayout?.globalRoot ?? params.stage.prefix,
    durationMs: Date.now() - startedAt,
    exitCode,
    stdoutTail,
    stderrTail,
    ...(exitCode !== 0
      ? {
          failureFacts: [
            createUpdateFailureFact({
              check: "package-swap",
              code,
              message: stderrTail ?? undefined,
            }),
          ],
        }
      : {}),
    ...(exitCode === 0 && warnings.length > 0
      ? {
          advisory: {
            kind: "recoverable-maintenance" as const,
            message: warnings.join("\n"),
          },
          warnings: [...warnings],
        }
      : {}),
  });
  return {
    warnings,
    step,
    verificationFailed(
      activePackageRoot: string | null,
      packageRollbackVerified: boolean,
      rollbackMessages: string[],
      postVerifyStep: UpdateStepResult,
    ): StagedPackageSwapResult {
      return {
        status: "failed",
        activePackageRoot,
        step: packageRollbackVerified
          ? step(
              0,
              [
                `restored previous ${params.packageName} package and affected launchers after verification failed`,
                "Update Doctor may have changed persistent state; managed Gateway remains stopped",
                ...rollbackMessages,
              ]
                .filter(Boolean)
                .join("; "),
              null,
            )
          : step(1, null, rollbackMessages.join("\n")),
        postVerifyStep,
        packageRollbackVerified,
      };
    },
    committed(
      activePackageRoot: string | null,
      hadPackage: boolean,
      cleanup: (string | null)[],
      postVerifyStep: UpdateStepResult | null,
    ): StagedPackageSwapResult {
      return {
        status: "committed",
        activePackageRoot,
        step: step(
          0,
          [
            hadPackage ? `replaced ${params.packageName}` : `installed ${params.packageName}`,
            ...cleanup,
          ]
            .filter(Boolean)
            .join("; "),
          null,
        ),
        postVerifyStep,
      };
    },
    failed(
      activePackageRoot: string | null,
      error: unknown,
      errors: string[],
      packageRollbackVerified: boolean,
    ): StagedPackageSwapResult {
      return {
        status: "failed",
        activePackageRoot,
        step: step(
          1,
          null,
          errors.join("\n"),
          isErrno(error) && typeof error.code === "string"
            ? error.code
            : error instanceof Error
              ? error.name
              : "swap-failed",
        ),
        postVerifyStep: null,
        packageRollbackVerified,
      };
    },
  };
}

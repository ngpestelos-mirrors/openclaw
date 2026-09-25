import { z } from "zod";
import { updateRecoveryCaptureStateSchema } from "./update-recovery-receipt-schema.js";
type UpdateRecoveryCaptureState = z.infer<typeof updateRecoveryCaptureStateSchema>;
export type UpdateRecoveryConfigWrite = UpdateRecoveryCaptureState["configWrites"][number];
export const updateRecoveryBackupRefSchema = z
  .object({
    directory: z.string().min(1),
    manifestPath: z.string().min(1),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export type UpdateRecoveryBackupRef = z.infer<typeof updateRecoveryBackupRefSchema>;

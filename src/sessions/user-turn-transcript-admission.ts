import type { SessionInputActorBinding } from "../config/sessions/session-input-actor.js";
import type { SessionPendingInputReceipt } from "../config/sessions/session-pending-input-receipt.types.js";
import type {
  PersistedUserTurnMessage,
  UserTurnTranscriptAdmissionReceipt,
  UserTurnTranscriptRecorder,
} from "./user-turn-transcript.types.js";

type AdmissionOwner = {
  bindInputActor: (binding: SessionInputActorBinding) => void;
  pendingInput: () => SessionPendingInputReceipt | undefined;
  withdrawnInputId: () => string | undefined;
  receipt: () => UserTurnTranscriptAdmissionReceipt | undefined;
  message: () => PersistedUserTurnMessage | undefined;
  blocked: () => boolean;
  sentToProvider: () => boolean;
  refresh: (
    admission: UserTurnTranscriptAdmissionReceipt,
    message: PersistedUserTurnMessage,
  ) => void;
};

// Only the recorder factory registers an owner; copied SDK values cannot bind one.
const admissionOwners = new WeakMap<UserTurnTranscriptRecorder, AdmissionOwner>();

/** Internal handoff only: the released recorder shape does not grant actor authority. */
export function bindUserTurnInputActor(
  recorder: UserTurnTranscriptRecorder,
  binding: SessionInputActorBinding,
): void {
  const owner = admissionOwners.get(recorder);
  if (!owner) {
    throw new Error("Input actor requires a factory-owned transcript recorder");
  }
  owner.bindInputActor(binding);
}

export function registerUserTurnTranscriptAdmissionOwner(
  recorder: UserTurnTranscriptRecorder,
  owner: AdmissionOwner,
): void {
  admissionOwners.set(recorder, owner);
}

export function getUserTurnTranscriptAdmissionOwner(
  recorder: UserTurnTranscriptRecorder,
): AdmissionOwner | undefined {
  return admissionOwners.get(recorder);
}

export function readWithdrawnUserTurnInputId(
  recorder: UserTurnTranscriptRecorder | undefined,
): string | undefined {
  return recorder && admissionOwners.get(recorder)?.withdrawnInputId();
}

/** Snapshot only the factory-owned input that has not crossed its foreground model boundary. */
export function readPendingUserTurnTranscriptAdmission(
  recorder: UserTurnTranscriptRecorder | undefined,
): UserTurnTranscriptAdmissionReceipt | undefined {
  const owner = recorder ? admissionOwners.get(recorder) : undefined;
  if (!owner || owner.blocked() || owner.sentToProvider()) {
    return undefined;
  }
  const receipt = owner.receipt();
  return receipt ? { ...receipt } : undefined;
}

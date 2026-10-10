import type { SessionTreeEntry } from "@openclaw/agent-core";
import type { Selectable } from "kysely";
import type { DB } from "../../state/openclaw-agent-db.generated.js";
import type { ResolvedSessionEntryRow } from "./session-accessor.sqlite-entry-read.js";
import type { SessionPendingInputRow } from "./session-accessor.sqlite-pending-inputs.js";
import type { SessionActorHotState } from "./session-actor-contract.js";
import type { SessionColdArchive } from "./session-cold-storage-state.js";
import type { SessionTranscriptProjectionState } from "./session-transcript-index.js";

export type SessionActorStoredState = {
  agentId: string;
  path: string;
  hot: SessionActorHotState;
  /** Lookup siblings were admitted in the same hydration statement. */
  entryRows: Map<string, ResolvedSessionEntryRow | undefined>;
  window: Selectable<DB["session_windows"]> | undefined;
  hasBoard: boolean;
  pendingInputs: Map<string, SessionPendingInputRow>;
  completions: Map<string, Selectable<DB["session_input_completions"]>>;
  transcript: {
    coldArchive: Omit<SessionColdArchive, "archive_blob"> | undefined;
    projection: (SessionTranscriptProjectionState & { hasUnclassifiedEvents: boolean }) | undefined;
    identities: Map<string, Selectable<DB["transcript_event_identities"]>>;
    active: Map<number, Selectable<DB["session_transcript_active_events"]>>;
    navigation: Array<SessionTreeEntry & { seq: number }>;
    /** Only payloads acquired by this residency are retained; older bodies remain bounded reads. */
    payloads: Map<number, unknown>;
  };
};

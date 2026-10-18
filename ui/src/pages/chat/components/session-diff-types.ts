import type { JSX } from "@solidjs/web";
import type {
  SessionDiffFile,
  SessionsDiffResult,
} from "../../../../../packages/gateway-protocol/src/index.js";
import type { ParsedFilePatch } from "../../../lib/chat/session-diff.ts";
import type { DiffLine } from "../../../lib/chat/tool-call-diff.ts";
import type { SessionWorkspacePreview } from "./chat-session-workspace-types.ts";
import type { SessionDiffScope } from "./session-diff-menus.tsx";

export type SessionDiffLoader = (params: SessionDiffScope) => Promise<SessionsDiffResult>;
export type SessionDiffFileTextLoader = (path: string) => Promise<string | null>;
export type SessionDiffOwner = { agentId: string; sessionKey: string };
export type SessionDiffFileView = "reading" | "highlighted" | "plain" | "edit";
export type SessionDiffMobilePageRequest = {
  key: "session-diff-sync";
  title: string;
  /** Invoke in the native page outlet; dispose on Back, retain only while hidden. */
  render: () => JSX.Element;
};
export type SessionDiffProps = {
  /** Native host presentation, not the width of the panel. Unknown retains the native UI. */
  mobile?: boolean | null;
  active?: boolean;
  /** A new object requests a scope on the same native checkout, including on a retained tab. */
  scopeRequest?: { owner: SessionDiffOwner; scope: SessionDiffScope } | null;
  onResult?:
    | ((value: {
        owner: SessionDiffOwner | null;
        scope: SessionDiffScope;
        result: SessionsDiffResult;
      }) => void)
    | null;
  owner: SessionDiffOwner | null;
  execNode: string | null;
  loader: SessionDiffLoader | null;
  loadFileText: SessionDiffFileTextLoader | null;
  openFile: ((path: string) => void | Promise<SessionWorkspacePreview | undefined>) | null;
  revealFile: ((path: string) => void) | null;
  openFileView?: ((path: string, view: SessionDiffFileView) => void) | null;
  onOpenMobilePage?: ((page: SessionDiffMobilePageRequest, source: HTMLElement) => void) | null;
};
export type FileSource = {
  parsed: ParsedFilePatch | null;
  expandedGaps?: Map<DiffLine, Set<DiffLine>>;
};
export type FileView = { file: SessionDiffFile; source: FileSource };
export type DiffValue = {
  owner: SessionDiffOwner | null;
  scope: SessionDiffScope;
  result: SessionsDiffResult;
  views: FileView[];
};

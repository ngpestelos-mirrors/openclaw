import type { GitHubOAuthTokenPair } from "../agents/github-oauth-client.js";
import type {
  UserGitHubConnection,
  UserGitHubConnectionAuthority,
  UserGitHubDevice,
} from "./user-github-connections.kernel.js";

export type UserGitHubConnectionMutation =
  | { kind: "start"; requestId: string; createdAtMs: number; expiresAtMs: number }
  | { kind: "device"; generation: string; requestId: string; device: UserGitHubDevice }
  | {
      kind: "poll";
      generation: string;
      requestId: string;
      deviceCode: string;
      result:
        | { kind: "terminal" }
        | { kind: "candidate"; candidate: NonNullable<UserGitHubDevice["candidate"]> }
        | { kind: "pending"; pollIntervalMs: number; nextPollAtMs: number };
    }
  | {
      kind: "connect";
      generation: string;
      requestId: string;
      profileId: string;
      accountId: number;
      login: string;
    }
  | { kind: "cancel"; requestId: string }
  | { kind: "expire"; nowMs: number }
  | { kind: "beginRefresh"; generation: string; profileId: string; operationId: string }
  | { kind: "disconnect" };

export type UserGitHubRefreshMutation = {
  owner: string;
  profileId: string;
  operationId: string;
  result:
    | { kind: "rotated"; tokens: GitHubOAuthTokenPair; receivedAtMs: number }
    | { kind: "materialized"; login: string }
    | { kind: "failed"; failure: "failed" | "expired" };
};

export type UserGitHubConnectionCommit = {
  kind: "user-github-connection";
  changes: Array<{ owner: string; connection: UserGitHubConnectionAuthority | null }>;
  retiredProfileIds: string[];
};

export type UserGitHubConnectionEntry = { owner: string; connection: UserGitHubConnection };

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import type { WorkshopChange } from "./changes.kernel.js";
import type { WorkshopMutationContext } from "./library.js";
import {
  undoWorkshopReview,
  WorkshopReviewNotFoundError,
  workshopReviewRunId,
} from "./review-undo.js";

// The change feed lives in the shared SQLite broker; an in-memory feed keeps this a unit test.
const feed: WorkshopChange[] = [];
const mocks = vi.hoisted(() => ({
  enqueueSystemEvent: vi.fn(() => true),
  listWorkshopChanges: vi.fn(),
  listWorkshopSkills: vi.fn(),
  restoreWorkshopSkill: vi.fn(),
  archiveWorkshopSkill: vi.fn(),
}));
vi.mock("../../infra/system-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/system-events.js")>()),
  enqueueSystemEvent: mocks.enqueueSystemEvent,
}));
vi.mock("./library.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./library.js")>()),
  listWorkshopChanges: mocks.listWorkshopChanges,
  listWorkshopSkills: mocks.listWorkshopSkills,
  restoreWorkshopSkill: mocks.restoreWorkshopSkill,
  archiveWorkshopSkill: mocks.archiveWorkshopSkill,
}));

const REVIEW_ID = "0b6a4a52-1f43-4f0e-9d55-3c1d8e1f7a10";
const REVIEW_RUN_ID = workshopReviewRunId(REVIEW_ID);
const REVIEWED_SESSION = "agent:main:telegram:direct:42";
const user: WorkshopMutationContext = { config: {}, agentId: "main", actor: "user" };

function record(
  ctx: WorkshopMutationContext,
  change: Pick<WorkshopChange, "skillName" | "action"> & Partial<WorkshopChange>,
): WorkshopChange {
  const recorded: WorkshopChange = {
    id: `c${feed.length + 1}`,
    agentId: ctx.agentId,
    actor: ctx.actor,
    summary: change.action,
    createdAtMs: feed.length + 1,
    ...(ctx.sessionKey ? { sessionKey: ctx.sessionKey } : {}),
    ...(ctx.runId ? { runId: ctx.runId } : {}),
    ...change,
  };
  feed.push(recorded);
  return recorded;
}

beforeEach(() => {
  vi.clearAllMocks();
  feed.length = 0;
  mocks.listWorkshopChanges.mockImplementation(
    async (agentId: string, options: { runId?: string }) =>
      feed
        .filter((change) => change.agentId === agentId && change.runId === options.runId)
        .toReversed(),
  );
  // Live skills are those whose newest change did not archive them.
  mocks.listWorkshopSkills.mockImplementation(async () => {
    const latest = new Map(feed.map((change) => [change.skillName, change.action]));
    return [...latest].filter(([, action]) => action !== "archive").map(([name]) => ({ name }));
  });
  mocks.restoreWorkshopSkill.mockImplementation(
    async (ctx: WorkshopMutationContext, params: { name: string }) =>
      record(ctx, { skillName: params.name, action: "restore" }),
  );
  mocks.archiveWorkshopSkill.mockImplementation(
    async (ctx: WorkshopMutationContext, params: { name: string }) =>
      record(ctx, { skillName: params.name, action: "archive" }),
  );
  // A background review edits an existing skill twice and creates another.
  const review = { ...user, actor: "review" as const, sessionKey: REVIEWED_SESSION };
  const reviewCtx = { ...review, runId: REVIEW_RUN_ID };
  record(reviewCtx, { skillName: "deploy", action: "patch", versionId: "v-before-review" });
  record(reviewCtx, { skillName: "release", action: "create" });
  record(reviewCtx, { skillName: "deploy", action: "patch", versionId: "v-after-first-patch" });
});

describe("undoWorkshopReview", () => {
  it("restores edited skills, archives created ones, and tells the reviewed session", async () => {
    const result = await undoWorkshopReview(user, { runId: REVIEW_RUN_ID });

    const undoCtx = { ...user, runId: `skill-workshop-undo:${REVIEW_ID}` };
    expect(mocks.restoreWorkshopSkill).toHaveBeenCalledExactlyOnceWith(undoCtx, {
      name: "deploy",
      versionId: "v-before-review",
      summary: "undid background review",
    });
    expect(mocks.archiveWorkshopSkill).toHaveBeenCalledExactlyOnceWith(undoCtx, {
      name: "release",
      reason: "undo",
    });
    expect(result.status).toBe("undone");
    expect(
      result.changes.map(({ skillName, action, actor }) => [skillName, action, actor]),
    ).toEqual([
      ["deploy", "restore", "user"],
      ["release", "archive", "user"],
    ]);
    expect(mocks.enqueueSystemEvent).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("do not revert it again"),
      { sessionKey: resolveSystemEventQueueKey(REVIEWED_SESSION, "main") },
    );
  });

  it("reports a repeated undo as already undone without changing anything", async () => {
    await undoWorkshopReview(user, { runId: REVIEW_RUN_ID });
    const recorded = feed.length;
    vi.clearAllMocks();

    const again = await undoWorkshopReview(user, { runId: REVIEW_RUN_ID });

    expect(again).toEqual({ status: "already-undone", changes: [] });
    expect(feed).toHaveLength(recorded);
    expect(mocks.restoreWorkshopSkill).not.toHaveBeenCalled();
    expect(mocks.archiveWorkshopSkill).not.toHaveBeenCalled();
    expect(mocks.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("lets a concurrent second press find the review already undone", async () => {
    const [first, second] = await Promise.all([
      undoWorkshopReview(user, { runId: REVIEW_RUN_ID }),
      undoWorkshopReview(user, { runId: REVIEW_RUN_ID }),
    ]);

    expect([first.status, second.status]).toEqual(["undone", "already-undone"]);
    expect(mocks.archiveWorkshopSkill).toHaveBeenCalledTimes(1);
  });

  it("does not archive a created skill the agent already archived after a chat undo", async () => {
    record({ ...user, runId: "agent-turn" }, { skillName: "release", action: "archive" });

    const result = await undoWorkshopReview(user, { runId: REVIEW_RUN_ID });

    expect(mocks.archiveWorkshopSkill).not.toHaveBeenCalled();
    expect(result.changes.map(({ skillName }) => skillName)).toEqual(["deploy"]);
  });

  it("refuses a review id with no recorded changes", async () => {
    const runId = workshopReviewRunId("6f1d2c3b-0000-4000-8000-000000000000");

    await expect(undoWorkshopReview(user, { runId })).rejects.toThrow(
      new WorkshopReviewNotFoundError(`No skill changes recorded for review ${runId}.`),
    );
    await expect(undoWorkshopReview(user, { runId: "foreground-run" })).rejects.toBeInstanceOf(
      WorkshopReviewNotFoundError,
    );
    expect(mocks.restoreWorkshopSkill).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { createWorkspaceMemoryFileClient } from "./workspace-memory-client.js";

const note = "/gateway/memory/note.md";
const remoteNote = "/harness/memory/note.md";

function fixture() {
  const controller = new AbortController();
  const request = vi.fn(async (_request: string, _signal: AbortSignal) => "{}");
  const subscribe = vi.fn(
    async (_request: string, _onLine: (line: string) => void, _signal: AbortSignal) => {},
  );
  const files = createWorkspaceMemoryFileClient({
    workspaceDir: "/gateway",
    remoteWorkspaceDir: "/harness",
    signal: controller.signal,
    request,
    subscribe,
  });
  return {
    controller,
    request,
    subscribe,
    files,
    reply: (result: unknown) => request.mockResolvedValue(JSON.stringify({ result })),
    sent: (index: number) => JSON.parse(request.mock.calls[index]![0]),
  };
}

describe("workspace Memory file client", () => {
  it("maps workspace paths while preserving configured external Memory roots", async () => {
    const f = fixture();
    f.reply({ files: [remoteNote, "/archive/note.md"], skipped: ["/harness/memory/skip.md"] });
    const skipped = vi.fn();
    expect(
      await f.files.listFiles(
        "/gateway",
        ["notes", "/gateway/extra", "/archive"],
        undefined,
        skipped,
      ),
    ).toEqual([note, "/archive/note.md"]);
    expect(skipped).toHaveBeenCalledWith("/gateway/memory/skip.md");
    expect(f.sent(0)).toMatchObject({
      operation: "list",
      extraPaths: ["notes", "/harness/extra", "/archive"],
    });
    f.reply(remoteNote);
    expect(await f.files.maintenance!.resolveWritePath(note)).toBe(note);
    expect(f.sent(1)).toMatchObject({
      operation: "maintenance",
      method: "resolveWritePath",
      args: [remoteNote],
    });
  });

  it.each([
    { failure: "disconnect", reply: undefined },
    { failure: "truncated reply", reply: '{"result":' },
    {
      failure: "conflict",
      error: { message: "content changed", name: "MemoryWriteConflictError", code: "CONFLICT" },
    },
    {
      failure: "committed write",
      error: {
        message: "directory sync failed",
        name: "MemoryAtomicPublicationError",
        publication: "committed",
      },
    },
  ])("preserves the write outcome after $failure", async (outcome) => {
    const f = fixture();
    const error = "error" in outcome ? outcome.error : undefined;
    const reply = error ? JSON.stringify({ error }) : outcome.reply;
    if (reply === undefined) {
      f.request.mockRejectedValue(new Error("transport disconnected"));
    } else {
      f.request.mockResolvedValue(reply);
    }
    await expect(
      f.files.maintenance!.commitContent({
        filePath: note,
        tempPrefix: "note",
        content: "update",
        expectedHash: error ? undefined : "old",
      }),
    ).rejects.toMatchObject(error ?? { publication: "uncertain" });
  });

  it("does not return stale reads or start new requests after its lifetime ends", async () => {
    const f = fixture();
    f.request.mockImplementation(async () => {
      f.controller.abort(new Error("workspace stopped"));
      return JSON.stringify({ result: { content: "obsolete" } });
    });
    await expect(f.files.readForIndexing(note)).rejects.toThrow("workspace stopped");
    await expect(f.files.readForIndexing(note)).rejects.toThrow("workspace stopped");
    expect(f.request).toHaveBeenCalledOnce();
  });

  it("sends only file-watch settings and reports a lost subscription", async () => {
    const f = fixture();
    const settings = {
      extraPaths: ["/gateway/notes"],
      multimodal: { enabled: false, modalities: [], maxFileBytes: 1024 },
      sync: { watchDebounceMs: 10 },
      provider: { apiKey: "synthetic-not-a-credential" },
    };
    f.subscribe.mockImplementation(async (_request, onLine) => {
      onLine('"change"');
    });
    const onChange = vi.fn();
    await f.files.watch({ agentId: "main", settings }, onChange, new AbortController().signal);
    expect(JSON.parse(f.subscribe.mock.calls[0]![0])).toEqual({
      agentId: "main",
      settings: {
        extraPaths: ["/harness/notes"],
        multimodal: settings.multimodal,
        sync: { watchDebounceMs: 10 },
      },
    });
    expect(onChange.mock.calls).toEqual([["change"], ["unavailable"]]);
  });
});

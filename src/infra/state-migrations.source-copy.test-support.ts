// Inject the shared post-unlink durability failure through real migration entrypoints.
import fs from "node:fs";
import fsp from "node:fs/promises";
import { vi } from "vitest";
import * as durability from "./directory-durability.js";

export function holdLegacyCopyAfterSourceDeletion(sourcePath: string): () => void {
  const link = vi
    .spyOn(fsp, "link")
    .mockRejectedValue(Object.assign(new Error("link denied"), { code: "EPERM", syscall: "link" }));
  const requireSync = durability.requireDirectorySync;
  const sync = vi.spyOn(durability, "requireDirectorySync").mockImplementation((outcome, label) => {
    if (label === "Legacy migration source directory" && !fs.existsSync(sourcePath)) {
      throw new Error("post-delete parent sync failed");
    }
    requireSync(outcome, label);
  });
  return () => {
    sync.mockRestore();
    link.mockRestore();
  };
}

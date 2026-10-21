import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { GatewayOperatorRolesConfig } from "../../config/types.gateway.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { linkEmail, setUserProfileRole } from "../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { SkillLibraryError } from "../skill-library-error.js";
import { prepareSkillLibraryBundle, skillLibraryRevisionDir } from "./bundle.js";
import { uploadSkillLibrary } from "./import.js";
import {
  listSkillLibrary,
  mutateSkillLibrary,
  readSkillLibrary,
  saveSkillLibrary,
} from "./service.js";
import { beginZipUpload, content, draft, useSkillLibraryFixture } from "./service.test-support.js";
import type { SkillLibraryAuthority } from "./store.js";

const { fixture } = useSkillLibraryFixture();

async function zipBytes() {
  const { default: JSZip } = await import("jszip");
  return new JSZip().file("SKILL.md", content).generateAsync({ type: "nodebuffer" });
}

async function duringPublication(change: () => void, check: () => PromiseLike<unknown>) {
  const rename = fs.rename;
  let changed = false;
  const barrier = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    await rename(source, destination);
    if (String(source).includes(".staging-") && !changed) {
      changed = true;
      change();
    }
  });
  try {
    await check();
    expect(changed).toBe(true);
  } finally {
    barrier.mockRestore();
  }
}

describe("skill library worker mutation boundary", () => {
  it("saves, mutates, and settles an upload without caller-thread SQL", async () => {
    const { alice, options } = fixture();
    const bytes = await zipBytes();
    await openOpenClawStateDatabase(options).walMaintenance.stop();
    const sql = observeHostDataSql();
    try {
      const { skillId, revision } = (await saveSkillLibrary(alice, draft(), options)).entry;
      await expect(
        mutateSkillLibrary(
          alice,
          { action: "disable", skillId, expectedRevision: revision },
          options,
        ),
      ).resolves.toMatchObject({ entry: { enabled: false } });
      const { uploadId } = await beginZipUpload(alice, bytes, "uploaded", options);
      const chunks = await Promise.allSettled(
        [0, 1].map(() =>
          uploadSkillLibrary(
            alice,
            { action: "chunk", uploadId, offset: 0, data: bytes.toString("base64") },
            options,
          ),
        ),
      );
      expect(chunks.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = chunks.find((result) => result.status === "rejected");
      expect(rejected).toMatchObject({ reason: expect.any(SkillLibraryError) });
      expect(rejected).toMatchObject({ reason: { code: "CONFLICT" } });
      const receipt = await uploadSkillLibrary(alice, { action: "commit", uploadId }, options);
      expect(receipt).toMatchObject({ state: "published", entry: { slug: "uploaded" } });
      await expect(
        uploadSkillLibrary(alice, { action: "commit", uploadId }, options),
      ).resolves.toMatchObject({ ...receipt, state: "unchanged" });
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
  });

  it("publishes immutable files before SQL and retains them when the transaction fails", async () => {
    const { alice, options } = fixture();
    const { skillId, revision } = (await saveSkillLibrary(alice, draft(), options)).entry;
    const nextContent = `${content}\nUncommitted revision`;
    const bundle = prepareSkillLibraryBundle([
      { path: "SKILL.md", content: nextContent },
      ...draft().files,
    ]);
    const directory = skillLibraryRevisionDir(skillId, bundle.revision, options.env);
    openOpenClawStateDatabase(options).db.exec(`
      CREATE TRIGGER reject_library_revision BEFORE INSERT ON skill_library_revisions
      BEGIN SELECT RAISE(ABORT, 'publication transaction refused'); END;
    `);
    await expect(
      saveSkillLibrary(
        alice,
        { ...draft(), content: nextContent, skillId, expectedRevision: revision },
        options,
      ),
    ).rejects.toThrow("publication transaction refused");
    expect(await fs.readFile(path.join(directory, "SKILL.md"), "utf8")).toBe(nextContent);
    expect(await fs.readdir(path.dirname(directory))).not.toContainEqual(
      expect.stringMatching(/^\.staging-/),
    );
    expect(await readSkillLibrary(alice, skillId, undefined, options)).toMatchObject({
      content,
      entry: { revision },
      revisions: [{ revision }],
    });
  });

  it.each(["role", "alias"] as const)(
    "rechecks live %s authority after files publish and before SQL",
    async (change) => {
      const { alice, options } = fixture();
      const blocked = ensureProfileForEmail("blocked@example.test", options);
      setUserProfileRole(blocked.id, "blocked", options);
      const roles: GatewayOperatorRolesConfig = {
        default: "writer",
        definitions: {
          writer: {
            sessions: { others: "none" },
            agents: "*",
            scopes: ["operator.read", "operator.write"],
          },
          blocked: { sessions: { others: "none" }, agents: [], scopes: [] },
        },
      };
      const authority: SkillLibraryAuthority = {
        ...alice,
        getConfig: () => ({ gateway: { roles } }),
      };
      await duringPublication(
        () => {
          if (change === "role") {
            setUserProfileRole(alice.profileId!, "blocked", options);
          } else {
            linkEmail("alice@example.test", blocked.id, options);
          }
        },
        () =>
          expect(saveSkillLibrary(authority, draft(), options)).rejects.toMatchObject({
            code: expect.stringMatching(/^(AUTHORITY_EXPIRED|FORBIDDEN)$/),
          }),
      );
      expect((await listSkillLibrary(alice, {}, options)).entries).toEqual([]);
    },
  );

  it("rejects an upload that expires during publication without installing its SQL pointer", async () => {
    const { alice, options } = fixture();
    const bytes = await zipBytes();
    const { uploadId } = await beginZipUpload(alice, bytes, "expiring", options);
    await uploadSkillLibrary(
      alice,
      { action: "chunk", uploadId, offset: 0, data: bytes.toString("base64") },
      options,
    );
    await duringPublication(
      () => {
        openOpenClawStateDatabase(options)
          .db.prepare("UPDATE skill_library_uploads SET expires_at = 1 WHERE upload_id = ?")
          .run(uploadId);
      },
      () =>
        expect(
          uploadSkillLibrary(alice, { action: "commit", uploadId }, options),
        ).rejects.toMatchObject({
          code: "NOT_FOUND",
        }),
    );
    expect((await listSkillLibrary(alice, {}, options)).entries).toEqual([]);
  });
});

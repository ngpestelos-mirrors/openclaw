import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import photon from "@silvia-odwyer/photon-node";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.ts";
import { compareCaptures, hash, type Capture } from "./report.ts";

const temporary = useAutoCleanupTempDirTracker(afterEach);
async function fixture(red: number, width = 1) {
  const directory = temporary.make("parity-report-");
  const image = new photon.PhotonImage(
    new Uint8Array(Array.from({ length: width }, () => [red, 0, 0, 255]).flat()),
    width,
    1,
  );
  let png: Uint8Array;
  try {
    png = image.get_bytes();
  } finally {
    image.free();
  }
  const contract = { expectedShots: ["scene--profile"], fixtures: hash("same-fixture") };
  const manifest: Capture = {
    version: 1,
    source: { head: "synthetic", dirty: [] },
    browser: "test",
    platform: "test",
    contract,
    catalog: hash(JSON.stringify(contract)),
    options: {},
    complete: true,
    failures: [],
    shots: [
      {
        id: "scene--profile",
        file: "scene--profile.png",
        scene: "scene",
        profile: "profile",
        label: "Synthetic",
        sha256: hash(png),
        width,
        height: 1,
      },
    ],
  };
  await writeFile(path.join(directory, "scene--profile.png"), png);
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  return { directory, manifest };
}

it("compares decoded pixels and reports the exact changed-pixel count", async () => {
  const a = await fixture(0),
    b = await fixture(0),
    c = await fixture(1);
  const output = temporary.make("parity-output-");
  expect(await compareCaptures(a.directory, b.directory, output)).toBe(0);
  expect(await compareCaptures(a.directory, c.directory, output)).toBe(1);
  const { readdir } = await import("node:fs/promises");
  const reports = await Promise.all(
    (await readdir(output)).map(async (name) =>
      JSON.parse(await readFile(path.join(output, name, "report.json"), "utf8")),
    ),
  );
  expect(reports.map((report) => report.results[0].changedPixels).toSorted()).toEqual([0, 1]);
});

it("reports changed image dimensions without attempting a mismatched pixel comparison", async () => {
  const a = await fixture(0),
    b = await fixture(0, 2);
  expect(await compareCaptures(a.directory, b.directory, temporary.make("parity-output-"))).toBe(1);
});

it.each(["metadata", "missing-shot", "incomplete", "duplicate", "unsafe-path", "checksum"])(
  "rejects %s evidence",
  async (defect) => {
    const a = await fixture(0),
      b = await fixture(0);
    const manifest = b.manifest;
    if (defect === "metadata") {
      manifest.browser = "";
    }
    if (defect === "missing-shot") {
      manifest.contract.expectedShots.push("other--profile");
      manifest.catalog = hash(JSON.stringify(manifest.contract));
    }
    if (defect === "incomplete") {
      manifest.complete = false;
    }
    if (defect === "duplicate") {
      manifest.shots.push(manifest.shots[0]!);
    }
    if (defect === "unsafe-path") {
      manifest.shots[0]!.file = "../outside.png";
    }
    if (defect === "checksum") {
      manifest.shots[0]!.sha256 = hash("changed-file");
    }
    await writeFile(path.join(b.directory, "manifest.json"), JSON.stringify(manifest));
    await expect(
      compareCaptures(a.directory, b.directory, temporary.make("parity-output-")),
    ).rejects.toThrow();
  },
);

it("rejects incompatible browser metadata even with identical images", async () => {
  const a = await fixture(0),
    b = await fixture(0);
  b.manifest.browser = "another-browser";
  await writeFile(path.join(b.directory, "manifest.json"), JSON.stringify(b.manifest));
  expect(await compareCaptures(a.directory, b.directory, temporary.make("parity-output-"))).toBe(1);
});

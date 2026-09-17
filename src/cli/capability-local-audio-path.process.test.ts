import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createWhisperExecutable } from "../media-understanding/local-audio.test-support.js";
import { createSafeAudioFixtureBuffer } from "../media-understanding/runner.test-utils.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// The synthetic executable uses /bin/sh; Windows suffix lookup has owner coverage.
describe.skipIf(process.platform === "win32")("infer local audio executable selection", () => {
  it.each([
    ["a literal home-relative PATH", "home", false],
    ["a home-relative PATH before a later decoy", "home", true],
    ["an absolute PATH", "absolute", false],
    ["a quoted PATH", "quoted", false],
    ["a home path containing the PATH delimiter", "home-delimiter", false],
    ["an absolute symlink/.. PATH", "symlink", true],
    ["a home-relative symlink/.. PATH", "home-symlink", true],
    ["empty PATH entries with a cwd executable", "empty", false],
  ] as const)("preserves executable selection from %s", async (_name, form, decoy) => {
    const parent = tempDirs.make("openclaw-infer-local-audio-");
    const root = form === "home-delimiter" ? path.join(parent, "audio:home") : parent;
    await fs.mkdir(root, { recursive: true });
    const binDir = path.join(root, "qa-stt-bin");
    const decoyDir = path.join(root, "decoy-bin");
    const tmp = path.join(root, "tmp");
    const workspace = path.join(root, "workspace");
    await Promise.all([binDir, decoyDir, tmp, workspace].map((dir) => fs.mkdir(dir)));
    const transcript = "preferred synthetic transcript";
    await createWhisperExecutable(binDir, transcript);
    if (decoy) {
      await createWhisperExecutable(decoyDir, "wrong executable transcript");
    }
    if (form === "symlink" || form === "home-symlink") {
      const nestedDir = path.join(binDir, "nested");
      await fs.mkdir(nestedDir);
      await fs.symlink(nestedDir, path.join(root, "audio-link"));
      await createWhisperExecutable(root, "lexically normalized decoy transcript");
    }
    if (form === "empty") {
      await createWhisperExecutable(root, "cwd executable must not run");
    }
    const mediaPath = path.join(root, "input.wav");
    await fs.writeFile(mediaPath, createSafeAudioFixtureBuffer(2048, 0x52));
    const configPath = path.join(root, "openclaw.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({
        agents: { defaults: { workspace }, entries: { main: {} } },
        plugins: { enabled: false },
        tools: { media: { audio: { enabled: true } } },
        logging: { level: "silent", consoleLevel: "silent" },
      }),
    );
    const firstEntry = {
      home: "~/qa-stt-bin",
      "home-delimiter": "~/qa-stt-bin",
      absolute: binDir,
      quoted: `"${binDir}"`,
      symlink: `${root}/audio-link/..`,
      "home-symlink": "~/audio-link/..",
      empty: path.delimiter,
    }[form];
    const searchPath = [firstEntry, ...(decoy ? [decoyDir] : [])];
    const result = await runCliProcessChild({
      nodeArgs: [
        ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli)),
        "infer",
        "audio",
        "transcribe",
        "--file",
        mediaPath,
        "--json",
      ],
      cwd: root,
      env: {
        PATH: searchPath.join(path.delimiter),
        ESBUILD_WORKER_THREADS: process.env.ESBUILD_WORKER_THREADS,
        HOME: root,
        USERPROFILE: root,
        TMPDIR: tmp,
        TMP: tmp,
        TEMP: tmp,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        // Keep startup from appending host audio tools to this isolated PATH.
        OPENCLAW_PATH_BOOTSTRAPPED: "1",
        OPENCLAW_NO_RESPAWN: "1",
        NODE_DISABLE_COMPILE_CACHE: "1",
        NO_COLOR: "1",
      },
    });
    expect(result.signal, result.stderr).toBeNull();
    if (form === "empty") {
      expect(result.code, result.stderr).toBe(1);
      expect(result.stderr).toContain("No audio transcription provider is configured or ready");
      return;
    }
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      capability: "audio.transcribe",
      transport: "local",
      provider: "whisper",
      outputs: [{ path: mediaPath, text: transcript, kind: "audio.transcription" }],
    });
  });
});

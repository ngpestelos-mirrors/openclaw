#!/usr/bin/env node
// Disposable hosted feasibility probe. This is not production registration or login proof.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [expectedSha, output] = process.argv.slice(2);
assert.match(expectedSha ?? "", /^[a-f0-9]{40}$/u);
assert(output && path.isAbsolute(output), "absolute receipt output required");
const receipt = { candidate: expectedSha, verdict: "UNPROVED", controls: {}, cleanup: false };
let root;
let mount;
let attached = false;
let target;
const pids = new Set();
function run(binary, argv) {
  const result = spawnSync(binary, argv, { encoding: "utf8", timeout: 120000, maxBuffer: 1048576 });
  assert(
    !result.error && !result.signal && result.status !== null,
    "native child must settle: " + binary,
  );
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}
function checked(binary, argv) {
  const result = run(binary, argv);
  assert.equal(result.code, 0, result.stderr || result.stdout || binary);
  return result.stdout.trim();
}
function absent(result) {
  return (
    result.code !== 0 &&
    /not found|could not find service|no such process/iu.test(result.stdout + result.stderr)
  );
}
async function runningPid() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const state = run("/bin/launchctl", ["print", target]);
    const pid = Number(/\bpid = (\d+)/u.exec(state.stdout)?.[1]);
    if (state.code === 0 && pid) {
      pids.add(pid);
      return pid;
    }
    await delay(100);
  }
  throw new Error("no running owner observed");
}
async function stop() {
  const before = run("/bin/launchctl", ["print", target]);
  assert(before.code === 0 || absent(before), "cannot inspect probe owner");
  const pid = Number(/\bpid = (\d+)/u.exec(before.stdout)?.[1]);
  if (pid) {
    pids.add(pid);
  }
  const stopped = run("/bin/launchctl", ["bootout", target]);
  assert(stopped.code === 0 || absent(stopped), "bootout did not settle");
  const deadline = Date.now() + 15000;
  for (;;) {
    const state = run("/bin/launchctl", ["print", target]);
    const remaining = [...pids].filter((candidate) => {
      try {
        process.kill(candidate, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") {
          return false;
        }
        throw error;
      }
    });
    if (absent(state) && remaining.length === 0) {
      return;
    }
    assert(Date.now() < deadline, "probe owner or process remains");
    await delay(100);
  }
}
try {
  assert.equal(process.platform, "darwin");
  assert(
    process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_OS === "macOS" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted",
    "genuine disposable GitHub-hosted macOS required",
  );
  assert.equal(checked("git", ["rev-parse", "HEAD"]), expectedSha);
  assert.equal(checked("git", ["status", "--porcelain", "--untracked-files=no"]), "");
  receipt.runner = {
    runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    hardware: checked("/usr/sbin/sysctl", ["-n", "hw.model"]),
  };
  const domain = "gui/" + process.getuid();
  checked("/bin/launchctl", ["print", domain]);
  root = await fs.mkdtemp(path.join(process.env.RUNNER_TEMP, "pr133215-registration-"));
  assert.equal(
    (await fs.stat(root)).dev,
    (await fs.stat("/")).dev,
    "target must be on boot volume",
  );
  mount = path.join(root, "external");
  await fs.mkdir(mount);
  const image = path.join(root, "external.dmg");
  checked("/usr/bin/hdiutil", [
    "create",
    "-size",
    "128m",
    "-fs",
    "APFS",
    "-volname",
    "OpenClawRegistrationProbe",
    image,
  ]);
  checked("/usr/bin/hdiutil", ["attach", "-nobrowse", "-mountpoint", mount, image]);
  attached = true;
  assert.notEqual((await fs.stat(mount)).dev, (await fs.stat(root)).dev);
  const label = "ai.openclaw.registration-probe-" + randomUUID();
  target = domain + "/" + label;
  const canonical = path.join(root, label + ".plist");
  const directory = path.join(mount, "home", "Library", "LaunchAgents");
  const alias = path.join(directory, label + ".plist");
  const definition = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>/bin/sleep</string><string>300</string></array>
<key>RunAtLoad</key><true/></dict></plist>`;
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(canonical, definition, { mode: 0o644 });
  checked("/bin/launchctl", ["bootstrap", domain, canonical]);
  receipt.controls.bootBaselinePid = await runningPid();
  await stop();
  await fs.symlink(canonical, alias);
  assert.equal(await fs.realpath(alias), await fs.realpath(canonical));
  const scan = run("/bin/launchctl", ["bootstrap", domain, directory]);
  receipt.controls.externalDirectoryScan = scan;
  if (scan.code !== 0) {
    receipt.verdict = "INVALIDATED";
  } else {
    receipt.controls.aliasPid = await runningPid();
    await stop();
    await fs.unlink(canonical);
    const dangling = run("/bin/launchctl", ["bootstrap", domain, directory]);
    const state = run("/bin/launchctl", ["print", target]);
    receipt.controls.dangling = { result: dangling, ownerAbsent: absent(state) };
    assert(absent(state), "dangling target acquired an owner");
    await fs.writeFile(canonical, definition, { mode: 0o644 });
    checked("/bin/launchctl", ["bootstrap", domain, directory]);
    receipt.controls.repairedPid = await runningPid();
    receipt.verdict = "VALIDATED";
  }
  assert.equal(checked("git", ["rev-parse", "HEAD"]), expectedSha);
  assert.equal(checked("git", ["status", "--porcelain", "--untracked-files=no"]), "");
} catch (error) {
  receipt.error = String(error);
} finally {
  try {
    if (target) {
      await stop();
    }
    if (attached) {
      checked("/usr/bin/hdiutil", ["detach", mount]);
    }
    if (root) {
      await fs.rm(root, { recursive: true });
    }
    receipt.cleanup = true;
  } catch (error) {
    receipt.cleanupError = String(error);
    receipt.retainedRoot = root;
  }
  receipt.limits = [
    "directory-discovery feasibility only",
    "no real logout/login",
    "no account-home or operator-service mutation",
    "no production alias installation",
    "no product imports or handoff database opens",
  ];
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(receipt, null, 2) + "\n");
  process.exitCode = receipt.verdict === "VALIDATED" && receipt.cleanup && !receipt.error ? 0 : 1;
}

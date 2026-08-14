import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { truncate } from "./util";

export function isGitTrackedWorkspace(rootPath?: string): boolean {
  if (!rootPath) return false;
  const result = spawnSync(
    "git",
    ["-C", rootPath, "rev-parse", "--is-inside-work-tree"],
    {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    },
  );
  return result.status === 0 && result.stdout.trim() === "true";
}

function runGit(
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {},
  input?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      const output = Buffer.concat(stdout).toString();
      if (code === 0) resolve(output);
      else
        reject(
          new Error(
            Buffer.concat(stderr).toString().trim() ||
              `git ${args[0]} exited with code ${code}`,
          ),
        );
    });
    child.stdin.end(input);
  });
}

export async function captureGitTree(rootPath: string): Promise<string> {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "opencodex-git-"),
  );
  const env = { GIT_INDEX_FILE: path.join(temporaryDirectory, "index") };
  try {
    try {
      await runGit(["read-tree", "HEAD"], rootPath, env);
    } catch {
      await runGit(["read-tree", "--empty"], rootPath, env);
    }
    await runGit(["add", "-A", "--", "."], rootPath, env);
    const tree = (await runGit(["write-tree"], rootPath, env)).trim();
    if (!/^[0-9a-f]{40,64}$/i.test(tree))
      throw new Error("Git did not produce a valid restore tree.");
    await runGit(
      ["update-ref", `refs/opencodex/checkpoints/${tree}`, tree],
      rootPath,
    );
    return tree;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function restoreGitTree(
  rootPath: string,
  targetTree: string,
): Promise<void> {
  const currentTree = await captureGitTree(rootPath);
  if (currentTree === targetTree) return;
  const patch = await runGit(
    ["diff", "--binary", "--full-index", currentTree, targetTree, "--", "."],
    rootPath,
  );
  if (!patch) return;
  await runGit(
    ["apply", "--binary", "--whitespace=nowarn", "-"],
    rootPath,
    {},
    patch,
  );
}

export function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      windowsHide: true,
    });
    let output = "";
    const append = (chunk: Buffer) => {
      output = truncate(output + chunk.toString());
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(
        new Error(`Command timed out after ${timeoutMs / 1000}s.\n${output}`),
      );
    }, timeoutMs);
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      code === 0
        ? resolve(output || "(command completed with no output)")
        : reject(new Error(`Command exited with code ${code}.\n${output}`));
    });
  });
}

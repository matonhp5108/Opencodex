import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import * as path from "node:path";

export const WORKTREE_ROOT = ".opencodex/worktrees";

export interface GitWorktree {
  name: string;
  path: string;
  branch: string;
  commit: string;
  isMain: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

export interface WorktreeStatus {
  name: string;
  path: string;
  branch: string;
  commit: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  untracked: number;
  branchExists: boolean;
}

export interface DiffStat {
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
}

export type MergeStrategy = "merge" | "squash" | "rebase";

export class WorktreeError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "WorktreeError";
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

function runGit(
  args: string[],
  cwd: string,
  options: { input?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    const timer = options.timeoutMs
      ? setTimeout(() => child.kill("SIGTERM"), options.timeoutMs)
      : undefined;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: code ?? 0,
      });
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function git(args: string[], cwd: string): Promise<string> {
  const result = await runGit(args, cwd);
  if (result.code !== 0)
    throw new WorktreeError(
      result.stderr.trim() || `git ${args[0]} failed`,
      `git_${args[0]}`,
    );
  return result.stdout;
}

export function isGitRepository(repoPath: string): Promise<boolean> {
  return runGit(["rev-parse", "--is-inside-work-tree"], repoPath)
    .then((r) => r.code === 0 && r.stdout.trim() === "true")
    .catch(() => false);
}

function realRepo(repoPath: string): string {
  try {
    return realpathSync(repoPath);
  } catch {
    return path.resolve(repoPath);
  }
}

export function worktreeDir(repoPath: string, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new WorktreeError("Invalid worktree name", "bad_name");
  return path.join(realRepo(repoPath), WORKTREE_ROOT, safe);
}

function parseWorktreeList(porcelain: string, base: string): GitWorktree[] {
  const trees: GitWorktree[] = [];
  const blocks = porcelain.split("\n\n").filter(Boolean);
  for (const block of blocks) {
    const lines = block.split("\n");
    let p: string | undefined;
    let branch: string | undefined;
    let commit = "";
    let isMain = false;
    let bare = false;
    let locked = false;
    let prunable = false;
    for (const line of lines) {
      if (line.startsWith("worktree "))
        p = path.resolve(base, line.slice("worktree ".length).trim());
      else if (line.startsWith("branch "))
        branch = line.slice("branch ".length).trim();
      else if (line.startsWith("HEAD "))
        commit = line.slice("HEAD ".length).trim();
      else if (line === "bare") bare = true;
      else if (line === "detached") branch = undefined;
      else if (line === "locked") locked = true;
      else if (line.startsWith("locked ")) locked = true;
      else if (line === "prunable") prunable = true;
    }
    if (!p) continue;
    isMain = !p.includes(WORKTREE_ROOT);
    trees.push({
      name: isMain ? "(main)" : path.basename(p),
      path: p,
      branch: branch ?? "(detached)",
      commit,
      isMain,
      bare,
      locked,
      prunable,
    });
  }
  return trees;
}

export async function listWorktrees(repoPath: string): Promise<GitWorktree[]> {
  const out = await git(["worktree", "list", "--porcelain"], repoPath);
  return parseWorktreeList(out, realRepo(repoPath));
}

export interface CreateWorktreeOptions {
  name: string;
  branch?: string;
  base?: string;
  detached?: boolean;
}

export async function createWorktree(
  repoPath: string,
  options: CreateWorktreeOptions,
): Promise<GitWorktree> {
  const target = worktreeDir(repoPath, options.name);
  const branch =
    options.branch || `${WORKTREE_ROOT.replace(/\//g, "-")}-${options.name}`;
  const args = ["worktree", "add", "--force"];
  if (options.detached) args.push("--detach");
  else args.push("-b", branch);
  args.push(target);
  args.push(options.base || "HEAD");
  try {
    await git(args, repoPath);
  } catch (error) {
    if (
      error instanceof WorktreeError &&
      /already exists/i.test(error.message)
    ) {
      await git(["worktree", "add", "--force", target, branch], repoPath).catch(
        () => {
          throw error;
        },
      );
    } else throw error;
  }
  const trees = await listWorktrees(repoPath);
  const created = trees.find((t) => t.path === target);
  if (!created)
    throw new WorktreeError(
      `Worktree ${options.name} was not registered`,
      "not_created",
    );
  return created;
}

export async function removeWorktree(
  repoPath: string,
  name: string,
  force = false,
): Promise<void> {
  const target = worktreeDir(repoPath, name);
  const tree = (await listWorktrees(repoPath)).find(
    (item) => item.path === target,
  );
  const args = ["worktree", "remove", force ? "--force" : "", target].filter(
    Boolean,
  ) as string[];
  await git(args, repoPath);
  if (tree && tree.branch !== "(detached)") {
    await git(["branch", "-D", branchName(tree.branch)], repoPath).catch(
      () => undefined,
    );
  }
}

function branchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

export async function statusOfWorktree(
  repoPath: string,
  name: string,
): Promise<WorktreeStatus> {
  const trees = await listWorktrees(repoPath);
  const tree = trees.find((t) => t.name === name);
  if (!tree) throw new WorktreeError(`Unknown worktree ${name}`, "not_found");
  const wtPath = tree.path;
  const statusOut = await git(["status", "--porcelain"], wtPath);
  let dirty = false;
  let untracked = 0;
  for (const line of statusOut.split("\n").filter(Boolean)) {
    if (line.trim()) dirty = true;
    if (line.startsWith("??")) untracked++;
  }
  const branchRef = tree.branch;
  let ahead = 0;
  let behind = 0;
  let branchExists = branchRef !== "(detached)";
  if (branchExists) {
    const name = branchName(branchRef);
    const up = await git(
      ["rev-list", "--left-right", "--count", `origin/${name}...${name}`],
      wtPath,
    ).catch(() => "");
    const m = /^(\d+)\s+(\d+)/.exec(up.trim());
    if (m) {
      behind = Number(m[1]);
      ahead = Number(m[2]);
    }
  }
  return {
    name: tree.name,
    path: wtPath,
    branch: branchRef,
    commit: tree.commit,
    ahead,
    behind,
    dirty,
    untracked,
    branchExists,
  };
}

function parseDiffStat(out: string): DiffStat {
  const files: string[] = [];
  let insertions = 0;
  let deletions = 0;
  for (const line of out.split("\n")) {
    const m = /^(\d+) files? changed/.exec(line.trim());
    if (m) {
      const filesChanged = Number(m[1]);
      const ins = /(\d+) insertions?\(\+\)/.exec(line);
      const del = /(\d+) deletions?\(-\)/.exec(line);
      insertions = ins ? Number(ins[1]) : 0;
      deletions = del ? Number(del[1]) : 0;
      return { filesChanged, insertions, deletions, files };
    }
  }
  return { filesChanged: 0, insertions, deletions, files };
}

export async function compareWorktrees(
  repoPath: string,
  fromName: string,
  toName: string,
): Promise<DiffStat> {
  const trees = await listWorktrees(repoPath);
  const from = trees.find((t) => t.name === fromName);
  const to = trees.find((t) => t.name === toName);
  if (!from || !to)
    throw new WorktreeError(
      "Both worktrees must exist to compare",
      "not_found",
    );
  const out = await git(
    ["diff", "--stat", `${to.commit}..${from.commit}`],
    repoPath,
  );
  return parseDiffStat(out);
}

export interface MergeResult {
  strategy: MergeStrategy;
  conflicts: string[];
  merged: boolean;
}

export async function mergeWorktree(
  repoPath: string,
  sourceName: string,
  intoName = "(main)",
  strategy: MergeStrategy = "merge",
): Promise<MergeResult> {
  const trees = await listWorktrees(repoPath);
  const source = trees.find((t) => t.name === sourceName);
  const target = trees.find((t) => t.name === intoName);
  if (!source || !target)
    throw new WorktreeError("Both worktrees must exist to merge", "not_found");
  if (source.branch === "(detached)" || target.branch === "(detached)")
    throw new WorktreeError("Detached worktrees cannot be merged", "detached");
  const srcBranch = branchName(source.branch);
  const tgtBranch = branchName(target.branch);
  await git(["checkout", tgtBranch], target.path);
  if (strategy === "rebase") {
    try {
      await git(["rebase", srcBranch], target.path);
    } catch {
      await git(["rebase", "--abort"], target.path).catch(() => undefined);
      const conflicts = await collectConflicts(target.path);
      return { strategy, conflicts, merged: false };
    }
    const conflicts = await collectConflicts(target.path);
    return { strategy, conflicts, merged: conflicts.length === 0 };
  }
  const mergeArgs = ["merge", "--no-edit"];
  if (strategy === "squash") mergeArgs.push("--squash");
  try {
    await git([...mergeArgs, srcBranch], target.path);
  } catch {
    await git(["merge", "--abort"], target.path).catch(() => undefined);
    const conflicts = await collectConflicts(target.path);
    return { strategy, conflicts, merged: false };
  }
  const conflicts = await collectConflicts(target.path);
  return { strategy, conflicts, merged: conflicts.length === 0 };
}

async function collectConflicts(worktreePath: string): Promise<string[]> {
  const out = await git(
    ["diff", "--name-only", "--diff-filter=U"],
    worktreePath,
  );
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function pruneWorktrees(repoPath: string): Promise<void> {
  await git(["worktree", "prune"], repoPath);
}

export function runInWorktree(
  repoPath: string,
  name: string,
  command: string,
  timeoutMs = 120_000,
): Promise<RunResult> {
  const trees = listWorktrees(repoPath);
  return trees.then(async (list) => {
    const tree = list.find((t) => t.name === name);
    if (!tree) throw new WorktreeError(`Unknown worktree ${name}`, "not_found");
    return runGit(["bash", "-lc", command], tree.path, { timeoutMs });
  });
}

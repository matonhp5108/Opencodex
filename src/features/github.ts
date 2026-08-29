import { spawn } from "node:child_process";

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  url: string;
  assignees: string[];
}

export interface GitHubCheck {
  name: string;
  status:
    | "queued"
    | "in_progress"
    | "completed"
    | "failure"
    | "success"
    | "neutral"
    | "unknown";
  conclusion: string;
  url?: string;
}

export interface ReviewComment {
  id: number;
  author: string;
  body: string;
  path?: string;
  line?: number;
  state: string;
  url: string;
}

export interface PrReference {
  number: number;
  url: string;
  title: string;
  state: string;
  headRefName: string;
  baseRefName: string;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

function run(
  command: string,
  args: string[],
  cwd: string,
  options: { input?: string; timeoutMs?: number } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (c) => stdout.push(Buffer.from(c)));
    child.stderr.on("data", (c) => stderr.push(Buffer.from(c)));
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

async function gh(args: string[], cwd: string): Promise<string> {
  const result = await run("gh", args, cwd);
  if (result.code !== 0)
    throw new GitHubError(
      result.stderr.trim() || `gh ${args[0]} failed`,
      "Install the GitHub CLI and run `gh auth login`.",
    );
  return result.stdout;
}

export async function detectGhCli(): Promise<boolean> {
  const r = await run("gh", ["--version"], process.cwd(), {
    timeoutMs: 5_000,
  });
  return r.code === 0 && /cli/i.test(r.stdout + r.stderr);
}

export async function repoSlug(repoPath: string): Promise<string> {
  const r = await run("git", ["remote", "get-url", "origin"], repoPath, {
    timeoutMs: 10_000,
  });
  if (r.code !== 0) throw new GitHubError("No origin remote configured.");
  let url = r.stdout.trim();
  url = url.replace(/\.git$/, "");
  url = url.replace(/^git@github\.com:/, "https://github.com/");
  url = url.replace(/^ssh:\/\/git@github\.com\//, "https://github.com/");
  const m = /\/([^/]+)\/([^/]+)$/.exec(url);
  if (!m)
    throw new GitHubError("Could not parse GitHub repository from origin.");
  return `${m[1]}/${m[2]}`;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

export function branchForIssue(issueNumber: number, title: string): string {
  return `fix/${issueNumber}-${slugify(title)}`;
}

export function parseIssues(json: string): GitHubIssue[] {
  const raw = JSON.parse(json) as any[];
  return (Array.isArray(raw) ? raw : []).map((item) => ({
    number: Number(item.number),
    title: String(item.title ?? ""),
    body: String(item.body ?? ""),
    state: String(item.state ?? ""),
    labels: Array.isArray(item.labels)
      ? item.labels.map((l: any) => String(l?.name ?? l))
      : [],
    url: String(item.url ?? ""),
    assignees: Array.isArray(item.assignees)
      ? item.assignees.map((a: any) => String(a?.login ?? a))
      : [],
  }));
}

export function parseChecks(text: string): GitHubCheck[] {
  const checks: GitHubCheck[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t").map((p) => p.trim());
    if (parts.length < 2) continue;
    const status = (
      parts[1] || "unknown"
    ).toLowerCase() as GitHubCheck["status"];
    checks.push({
      name: parts[0] ?? "unknown",
      status,
      conclusion: parts[2] || "",
      url: parts[3] || undefined,
    });
  }
  return checks;
}

export function parseReviewComments(json: string): ReviewComment[] {
  const raw = JSON.parse(json) as any[];
  return (Array.isArray(raw) ? raw : []).map((item) => ({
    id: Number(item.id),
    author: String(item.user?.login ?? item.author ?? ""),
    body: String(item.body ?? ""),
    path: item.path ? String(item.path) : undefined,
    line: typeof item.line === "number" ? item.line : undefined,
    state: String(item.state ?? "COMMENTED"),
    url: String(item.html_url ?? item.url ?? ""),
  }));
}

export function buildPrBody(
  issueNumber: number,
  summary: string,
  checklist: string[] = [],
): string {
  const boxes = checklist.map((item) => `- [ ] ${item}`).join("\n");
  return `## Summary\n\n${summary}\n\nCloses #${issueNumber}\n\n### Checklist\n${boxes}`;
}

export async function listIssues(
  repoPath: string,
  state: "open" | "closed" | "all" = "open",
): Promise<GitHubIssue[]> {
  const slug = await repoSlug(repoPath);
  const out = await gh(
    [
      "issue",
      "list",
      "--repo",
      slug,
      "--state",
      state,
      "--json",
      "number,title,body,state,labels,url,assignees",
    ],
    repoPath,
  );
  return parseIssues(out);
}

export async function getIssue(
  repoPath: string,
  issueNumber: number,
): Promise<GitHubIssue> {
  const slug = await repoSlug(repoPath);
  const out = await gh(
    [
      "issue",
      "view",
      String(issueNumber),
      "--repo",
      slug,
      "--json",
      "number,title,body,state,labels,url,assignees",
    ],
    repoPath,
  );
  const issues = parseIssues(out);
  if (!issues.length) throw new GitHubError(`Issue #${issueNumber} not found.`);
  return issues[0]!;
}

export async function createBranchForIssue(
  repoPath: string,
  issueNumber: number,
  title: string,
  base = "main",
): Promise<string> {
  const branch = branchForIssue(issueNumber, title);
  await run("git", ["checkout", base], repoPath, { timeoutMs: 30_000 });
  await run("git", ["pull", "--ff-only"], repoPath, {
    timeoutMs: 60_000,
  }).catch(() => undefined);
  await run("git", ["checkout", "-b", branch], repoPath, { timeoutMs: 30_000 });
  return branch;
}

export async function commitChanges(
  repoPath: string,
  message: string,
  files: string[] = [],
): Promise<void> {
  if (files.length) await run("git", ["add", ...files], repoPath);
  else await run("git", ["add", "-A"], repoPath);
  const r = await run("git", ["commit", "-m", message], repoPath);
  if (r.code !== 0)
    throw new GitHubError(
      r.stderr.trim() || "Commit failed (nothing to commit?)",
    );
}

export async function createPullRequest(
  repoPath: string,
  options: {
    branch: string;
    base?: string;
    title: string;
    body: string;
    draft?: boolean;
  },
): Promise<PrReference> {
  const slug = await repoSlug(repoPath);
  await run("git", ["push", "-u", "origin", options.branch], repoPath, {
    timeoutMs: 120_000,
  }).catch((e) => {
    throw new GitHubError(
      `Push failed: ${e instanceof Error ? e.message : String(e)}`,
      "Check that `gh auth login` granted push access.",
    );
  });
  const args = [
    "pr",
    "create",
    "--repo",
    slug,
    "--head",
    options.branch,
    "--title",
    options.title,
    "--body",
    options.body,
  ];
  if (options.base) args.push("--base", options.base);
  if (options.draft) args.push("--draft");
  const out = await gh(args, repoPath);
  const m = /(https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+)/.exec(out);
  const number = /(\d+)/.exec(out);
  return {
    number: number ? Number(number[1]) : 0,
    url: m?.[1] ?? out.trim(),
    title: options.title,
    state: options.draft ? "DRAFT" : "OPEN",
    headRefName: options.branch,
    baseRefName: options.base ?? "main",
  };
}

export async function getPr(
  repoPath: string,
  prNumber?: number,
): Promise<PrReference> {
  const slug = await repoSlug(repoPath);
  const selector = prNumber ? [String(prNumber)] : [];
  const out = await gh(
    [
      "pr",
      "view",
      ...selector,
      "--repo",
      slug,
      "--json",
      "number,url,title,state,headRefName,baseRefName",
    ],
    repoPath,
  );
  const data = JSON.parse(out);
  return {
    number: Number(data.number),
    url: String(data.url),
    title: String(data.title),
    state: String(data.state),
    headRefName: String(data.headRefName),
    baseRefName: String(data.baseRefName),
  };
}

export async function monitorChecks(
  repoPath: string,
  prNumber?: number,
): Promise<GitHubCheck[]> {
  const slug = await repoSlug(repoPath);
  const selector = prNumber ? [String(prNumber)] : [];
  const out = await gh(
    ["pr", "checks", ...selector, "--repo", slug],
    repoPath,
  ).catch(() => "");
  return parseChecks(out);
}

export async function getReviewComments(
  repoPath: string,
  prNumber: number,
): Promise<ReviewComment[]> {
  const slug = await repoSlug(repoPath);
  const out = await gh(
    ["api", `repos/${slug}/pulls/${prNumber}/comments`],
    repoPath,
  );
  return parseReviewComments(out);
}

export async function addPrComment(
  repoPath: string,
  prNumber: number,
  body: string,
): Promise<void> {
  const slug = await repoSlug(repoPath);
  await gh(
    ["pr", "comment", String(prNumber), "--repo", slug, "--body", body],
    repoPath,
  );
}

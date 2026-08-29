import * as vscode from "vscode";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { tool } from "ai";
import { z } from "zod";
import { BrowserController, type ViewportName } from "./browser";
import {
  createWorktree,
  listWorktrees,
  mergeWorktree,
  removeWorktree,
  runInWorktree,
  statusOfWorktree,
} from "./worktrees";
import {
  listIssues,
  createBranchForIssue,
  getPr,
  monitorChecks,
  createPullRequest,
  buildPrBody,
} from "./github";
import {
  RepoIndex,
  SourceCitedMemory,
  hashContent,
  loadMemoryJson,
  saveMemoryJson,
  scanWorkspace,
} from "./repository-index";
import {
  normalizeAgentConfig,
  routeAgent,
  toolAllowed,
  type CustomAgentConfig,
} from "./agents";
import {
  dueTasks,
  evaluateHooks,
  nextRunAt,
  type HookContext,
  type HookRule,
  type ScheduledTask,
} from "./hooks";

type AutomationFile = { tasks: ScheduledTask[]; hooks: HookRule[] };
type TaskRunner = (prompt: string, agentId?: string) => Promise<void>;
type Approve = (
  kind: "edit" | "command",
  title: string,
  detail: string,
  destructive?: boolean,
) => Promise<void>;
export interface BrowserPreview {
  dataUrl: string;
  cursor?: { x: number; y: number; action: "click" | "type" };
}

const AGENTS_FILE = ".opencodex/agents.json";
const AUTOMATIONS_FILE = ".opencodex/automations.json";
const MUTATING_TOOLS = new Set([
  "write_file",
  "replace_text",
  "delete_file",
  "run_command",
  "terminal_start",
  "terminal_write",
  "terminal_stop",
  "worktree_create",
  "worktree_merge",
  "worktree_remove",
  "github_create_pr",
]);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class FeatureRuntime implements vscode.Disposable {
  private readonly output = vscode.window.createOutputChannel(
    "Opencodex",
  );
  private readonly browser = new BrowserController();
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private taskRunner: TaskRunner | undefined;
  private readonly repoIndexes = new Map<string, RepoIndex>();
  private browserPreview: BrowserPreview | undefined;
  private browserPreviewSink: ((preview?: BrowserPreview) => void) | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.registerCommands();
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    watcher.onDidCreate((uri) => void this.updateIndex(uri));
    watcher.onDidChange((uri) => void this.updateIndex(uri));
    watcher.onDidDelete((uri) => this.removeFromIndex(uri));
    this.disposables.push(watcher);
    this.timer = setInterval(() => void this.runDueTasks(), 30_000);
    void this.runDueTasks();
  }

  setTaskRunner(runner: TaskRunner): void {
    this.taskRunner = runner;
  }

  setBrowserPreviewSink(sink: (preview?: BrowserPreview) => void): void {
    this.browserPreviewSink = sink;
    sink(this.browserPreview);
  }

  replayBrowserPreview(): void {
    this.browserPreviewSink?.(this.browserPreview);
  }

  private async refreshBrowserPreview(
    cursor?: BrowserPreview["cursor"],
  ): Promise<void> {
    if (!this.browser.active) return;
    this.browserPreview = {
      dataUrl: await this.browser.previewDataUrl(),
      cursor,
    };
    this.browserPreviewSink?.(this.browserPreview);
  }

  private clearBrowserPreview(): void {
    this.browserPreview = undefined;
    this.browserPreviewSink?.();
  }

  private root(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private requireRoot(): string {
    const root = this.root();
    if (!root) throw new Error("Open a folder or workspace first.");
    return root;
  }

  private register(command: string, action: () => Promise<void> | void): void {
    this.disposables.push(
      vscode.commands.registerCommand(command, async () => {
        try {
          await action();
        } catch (error) {
          void vscode.window.showErrorMessage(`Opencodex: ${message(error)}`);
        }
      }),
    );
  }

  private registerCommands(): void {
    this.register("opencodex.worktrees", () => this.openWorktrees());
    this.register("opencodex.browserTests", () => this.openBrowserTesting());
    this.register("opencodex.github", () => this.openGitHub());
    this.register("opencodex.index", () => this.openIndex());
    this.register("opencodex.agents", () => this.openAgents());
    this.register("opencodex.tasks", () => this.openAutomations());
  }

  private async openWorktrees(): Promise<void> {
    const root = this.requireRoot();
    const trees = await listWorktrees(root);
    const picked = await vscode.window.showQuickPick(
      [
        { label: "$(add) Create isolated worktree", name: "__new" },
        ...trees.map((tree) => ({
          label: `${tree.isMain ? "$(home)" : "$(git-branch)"} ${tree.name}`,
          description: tree.branch.replace(/^refs\/heads\//, ""),
          detail: tree.path,
          name: tree.name,
        })),
      ],
      {
        title: "Parallel worktrees",
        placeHolder: "Create or manage an isolated task workspace",
      },
    );
    if (!picked) return;
    if (picked.name === "__new") {
      const name = await vscode.window.showInputBox({
        title: "Create isolated worktree",
        prompt: "Short task name",
        validateInput: (value) => (value.trim() ? undefined : "Enter a name"),
      });
      if (!name) return;
      const created = await createWorktree(root, { name: name.trim() });
      const open = await vscode.window.showInformationMessage(
        `Created ${created.name} on ${created.branch.replace(/^refs\/heads\//, "")}.`,
        "Open in New Window",
      );
      if (open)
        await vscode.commands.executeCommand(
          "vscode.openFolder",
          vscode.Uri.file(created.path),
          true,
        );
      return;
    }
    const tree = trees.find((item) => item.name === picked.name);
    if (!tree) return;
    const status = await statusOfWorktree(root, tree.name);
    const action = await vscode.window.showQuickPick(
      [
        { label: "$(link-external) Open in new window", id: "open" },
        ...(!tree.isMain
          ? [
              { label: "$(git-compare) Merge into main", id: "merge" },
              { label: "$(trash) Discard worktree", id: "remove" },
            ]
          : []),
      ],
      {
        title: tree.name,
        placeHolder: `${status.dirty ? "Uncommitted changes" : "Clean"}, ${status.ahead} ahead, ${status.behind} behind`,
      },
    );
    if (!action) return;
    if (action.id === "open")
      await vscode.commands.executeCommand(
        "vscode.openFolder",
        vscode.Uri.file(tree.path),
        true,
      );
    if (action.id === "merge") {
      const result = await mergeWorktree(root, tree.name);
      if (!result.merged)
        throw new Error(
          `Merge stopped with conflicts: ${result.conflicts.join(", ")}`,
        );
      void vscode.window.showInformationMessage(
        `Merged ${tree.name} into the main worktree.`,
      );
    }
    if (action.id === "remove") {
      const confirm = await vscode.window.showWarningMessage(
        `Discard worktree ${tree.name}? Uncommitted changes in it will be lost.`,
        { modal: true },
        "Discard",
      );
      if (confirm === "Discard") await removeWorktree(root, tree.name, true);
    }
  }

  private async openBrowserTesting(): Promise<void> {
    const root = this.requireRoot();
    const url = await vscode.window.showInputBox({
      title: "Browser testing",
      prompt: "Local or remote URL to inspect",
      value: "http://localhost:3000",
    });
    if (!url) return;
    const viewport = (await vscode.window.showQuickPick(
      ["mobile", "tablet", "laptop", "desktop"],
      { title: "Viewport", placeHolder: "Choose a viewport" },
    )) as ViewportName | undefined;
    if (!viewport) return;
    await this.browser.close();
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Opencodex is testing the page",
      },
      async () =>
        this.browser.launch({ url, viewport, waitUntil: "networkidle" }),
    );
    await this.refreshBrowserPreview();
    const snapshotData = await this.browser.snapshot();
    const geometry = await this.browser.collectGeometry(viewport);
    const screenshotPath = path.join(
      root,
      ".opencodex",
      "browser",
      `${Date.now()}-${viewport}.png`,
    );
    await this.browser.screenshot(screenshotPath);
    this.output.clear();
    this.output.appendLine(
      `Browser test: ${snapshotData.title} (${snapshotData.url})`,
    );
    this.output.appendLine(
      `Viewport: ${viewport} ${geometry.viewport.width}x${geometry.viewport.height}`,
    );
    this.output.appendLine(
      `Horizontal overflow: ${geometry.horizontalOverflow ? "yes" : "no"}`,
    );
    this.output.appendLine(
      `Off-screen sampled elements: ${geometry.offscreen.join(", ") || "none"}`,
    );
    this.output.appendLine(
      `Console errors: ${snapshotData.console.filter((entry) => entry.type === "error").length}`,
    );
    this.output.appendLine(
      `Failed requests: ${snapshotData.network.filter((entry) => entry.failed || entry.status >= 400).length}`,
    );
    this.output.appendLine(`Screenshot: ${screenshotPath}`);
    this.output.show(true);
    await vscode.commands.executeCommand(
      "vscode.open",
      vscode.Uri.file(screenshotPath),
    );
  }

  private async openGitHub(): Promise<void> {
    const root = this.requireRoot();
    const action = await vscode.window.showQuickPick(
      [
        { label: "$(issues) Browse issues", id: "issues" },
        {
          label: "$(git-pull-request) Show current pull request and CI",
          id: "pr",
        },
      ],
      { title: "GitHub workflows" },
    );
    if (!action) return;
    if (action.id === "issues") {
      const issues = await listIssues(root);
      const issue = await vscode.window.showQuickPick(
        issues.map((item) => ({
          label: `#${item.number} ${item.title}`,
          description: item.labels.join(", "),
          detail: item.body.slice(0, 240),
          issue: item,
        })),
        { title: "Open GitHub issues" },
      );
      if (!issue) return;
      const next = await vscode.window.showQuickPick([
        { label: "$(git-branch) Create implementation branch", id: "branch" },
        { label: "$(link-external) Open on GitHub", id: "open" },
      ]);
      if (next?.id === "branch") {
        const branch = await createBranchForIssue(
          root,
          issue.issue.number,
          issue.issue.title,
        );
        void vscode.window.showInformationMessage(
          `Created and checked out ${branch}.`,
        );
      } else if (next?.id === "open")
        await vscode.env.openExternal(vscode.Uri.parse(issue.issue.url));
    } else {
      const pr = await getPr(root);
      const checks = await monitorChecks(root, pr.number);
      this.output.clear();
      this.output.appendLine(`#${pr.number} ${pr.title}`);
      this.output.appendLine(
        `${pr.state} ${pr.headRefName} -> ${pr.baseRefName}`,
      );
      this.output.appendLine("");
      for (const check of checks)
        this.output.appendLine(
          `${check.name}: ${check.conclusion || check.status}`,
        );
      this.output.show(true);
      const open = await vscode.window.showInformationMessage(
        `PR #${pr.number}: ${checks.length} checks`,
        "Open on GitHub",
      );
      if (open) await vscode.env.openExternal(vscode.Uri.parse(pr.url));
    }
  }

  private async openIndex(): Promise<void> {
    const root = this.requireRoot();
    const query = await vscode.window.showInputBox({
      title: "Repository index",
      prompt: "Search concepts or symbols",
    });
    if (!query) return;
    const index = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: "Indexing repository",
      },
      async () => this.repoIndex(root),
    );
    index.indexSymbols();
    const results = [
      ...index.symbolSearch(query, 15).map((entry) => ({
        label: `$(symbol-method) ${entry.name}`,
        description: `${entry.path}:${entry.line}`,
        detail: entry.kind,
        path: entry.path,
        line: entry.line,
      })),
      ...index.semanticSearch(query, 15).map((entry) => ({
        label: `$(file) ${entry.path}`,
        description: `score ${entry.score}`,
        detail: entry.snippet,
        path: entry.path,
        line: 1,
      })),
    ];
    const picked = await vscode.window.showQuickPick(results, {
      title: `Results for “${query}”`,
    });
    if (!picked) return;
    const document = await vscode.workspace.openTextDocument(
      path.join(root, picked.path),
    );
    const editor = await vscode.window.showTextDocument(document);
    const position = new vscode.Position(Math.max(0, picked.line - 1), 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position));
  }

  private repoIndex(root: string): RepoIndex {
    let index = this.repoIndexes.get(root);
    if (!index) {
      index = new RepoIndex(scanWorkspace(root));
      this.repoIndexes.set(root, index);
    }
    return index;
  }

  private async updateIndex(uri: vscode.Uri): Promise<void> {
    const root = this.root();
    const index = root ? this.repoIndexes.get(root) : undefined;
    if (!root || !index || !uri.fsPath.startsWith(`${root}${path.sep}`)) return;
    const relative = path.relative(root, uri.fsPath);
    if (
      relative
        .split(path.sep)
        .some((part) =>
          ["node_modules", ".git", "dist", "build", ".opencodex"].includes(
            part,
          ),
        )
    )
      return;
    try {
      const stat = await fs.stat(uri.fsPath);
      if (!stat.isFile() || stat.size > 250_000) return;
      index.upsert({
        path: relative,
        content: await fs.readFile(uri.fsPath, "utf8"),
      });
    } catch {
      index.remove(relative);
    }
  }

  private removeFromIndex(uri: vscode.Uri): void {
    const root = this.root();
    const index = root ? this.repoIndexes.get(root) : undefined;
    if (root && index && uri.fsPath.startsWith(`${root}${path.sep}`))
      index.remove(path.relative(root, uri.fsPath));
  }

  private async ensureJsonFile(
    relative: string,
    initial: unknown,
  ): Promise<vscode.Uri> {
    const root = this.requireRoot();
    const file = vscode.Uri.file(path.join(root, relative));
    try {
      await vscode.workspace.fs.stat(file);
    } catch {
      await fs.mkdir(path.dirname(file.fsPath), { recursive: true });
      await fs.writeFile(
        file.fsPath,
        `${JSON.stringify(initial, null, 2)}\n`,
        "utf8",
      );
    }
    return file;
  }

  private async openAgents(): Promise<void> {
    const file = await this.ensureJsonFile(AGENTS_FILE, [
      {
        name: "Reviewer",
        description: "Read-only code reviewer",
        systemPrompt:
          "Review for correctness, regressions, security, and missing tests.",
        toolMode: "allowlist",
        allowedTools: [
          "list_files",
          "read_file",
          "search_files",
          "get_diagnostics",
        ],
        routing: { mode: "keyword", triggers: ["review", "audit"] },
        enabled: true,
      },
    ]);
    await vscode.window.showTextDocument(file);
  }

  private async openAutomations(): Promise<void> {
    const file = await this.ensureJsonFile(AUTOMATIONS_FILE, {
      tasks: [
        {
          id: "example-nightly-review",
          name: "Nightly review example",
          prompt: "Review the latest changes and report any regressions.",
          schedule: { kind: "cron", cron: "0 2 * * *" },
          enabled: false,
          createdAt: Date.now(),
        },
      ],
      hooks: [
        {
          id: "example-protect-env",
          name: "Protect environment files",
          event: "beforeTool",
          matcher: { pathGlob: "**/.env*" },
          action: "block",
          message: "Environment files are protected by repository policy.",
          enabled: false,
        },
      ],
    });
    await vscode.window.showTextDocument(file);
  }

  private async readJson<T>(relative: string, fallback: T): Promise<T> {
    const root = this.root();
    if (!root) return fallback;
    try {
      return JSON.parse(
        await fs.readFile(path.join(root, relative), "utf8"),
      ) as T;
    } catch {
      return fallback;
    }
  }

  async routedAgent(prompt: string): Promise<CustomAgentConfig | undefined> {
    const stored = await this.readJson<unknown[]>(AGENTS_FILE, []);
    const agents = (Array.isArray(stored) ? stored : []).flatMap((entry) => {
      try {
        const raw = entry as Partial<CustomAgentConfig> & {
          name: string;
          description: string;
          systemPrompt: string;
        };
        if (!raw?.name || typeof raw.systemPrompt !== "string") return [];
        return [
          normalizeAgentConfig({ ...raw, description: raw.description ?? "" }),
        ];
      } catch {
        return [];
      }
    });
    const explicit = /^@opencodex-agent\(([^)]+)\)/.exec(prompt)?.[1];
    return (
      (explicit ? agents.find((agent) => agent.id === explicit) : undefined) ??
      routeAgent(prompt, agents)?.agent
    );
  }

  async beforeTool(context: HookContext): Promise<void> {
    const config = await this.readJson<AutomationFile>(AUTOMATIONS_FILE, {
      tasks: [],
      hooks: [],
    });
    const decision = evaluateHooks(config.hooks ?? [], context);
    if (decision.action === "block")
      throw new Error(`Blocked by hook: ${decision.message}`);
    if (decision.action === "warn")
      void vscode.window.showWarningMessage(decision.message);
    if (decision.action === "requireApproval") {
      const answer = await vscode.window.showWarningMessage(
        decision.message || "A hook requires approval.",
        { modal: true },
        "Allow",
      );
      if (answer !== "Allow") throw new Error("Blocked by lifecycle hook.");
    }
    if (decision.action === "log")
      this.output.appendLine(`[hook] ${decision.message}`);
  }

  restrictTools(
    tools: Record<string, any>,
    agent?: CustomAgentConfig,
  ): Record<string, any> {
    if (!agent) return tools;
    const allowedServers = new Set(
      agent.mcpServers.map((name) =>
        name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      ),
    );
    return Object.fromEntries(
      Object.entries(tools).filter(([name]) => {
        if (!toolAllowed(agent, name)) return false;
        if (!name.startsWith("mcp_") || !allowedServers.size) return true;
        return [...allowedServers].some((server) =>
          name.startsWith(`mcp_${server}_`),
        );
      }),
    );
  }

  agentTools(root: string, approve: Approve): Record<string, any> {
    return {
      browser_launch: tool({
        description:
          "Launch a headless browser at a URL. Works with text-only models; use browser_snapshot for DOM, accessibility, console, network, and responsive geometry evidence.",
        inputSchema: z.object({
          url: z.string().url(),
          viewport: z
            .enum(["mobile", "tablet", "laptop", "desktop"])
            .default("laptop"),
        }),
        execute: async ({ url, viewport }) => {
          await this.browser.close();
          await this.browser.launch({
            url,
            viewport,
            waitUntil: "networkidle",
          });
          await this.refreshBrowserPreview();
          return `Browser opened ${url} at ${viewport} viewport.`;
        },
      }),
      browser_navigate: tool({
        description: "Navigate the active browser session to another URL.",
        inputSchema: z.object({ url: z.string().url() }),
        execute: async ({ url }) => {
          await this.browser.navigate(url);
          await this.refreshBrowserPreview();
          return `Navigated to ${url}.`;
        },
      }),
      browser_click: tool({
        description:
          "Click an element in the active browser using a CSS selector.",
        inputSchema: z.object({ selector: z.string().min(1) }),
        execute: async ({ selector }) => {
          const point = await this.browser.cursorPoint(selector);
          await this.browser.click(selector);
          await this.refreshBrowserPreview(
            point ? { ...point, action: "click" } : undefined,
          );
          return `Clicked ${selector}.`;
        },
      }),
      browser_type: tool({
        description:
          "Type into a form control through real sequential keyboard events, so keydown/input/keyup handlers run as they would for a person.",
        inputSchema: z.object({
          selector: z.string().min(1),
          text: z.string(),
          clear: z.boolean().default(true),
          delayMs: z.number().int().min(0).max(250).default(24),
        }),
        execute: async ({ selector, text, clear, delayMs }) => {
          const point = await this.browser.cursorPoint(selector);
          await this.browser.type(selector, text, { clear, delayMs });
          await this.refreshBrowserPreview(
            point ? { ...point, action: "type" } : undefined,
          );
          return `Typed ${text.length} characters into ${selector}.`;
        },
      }),
      browser_press: tool({
        description:
          "Press a keyboard key or shortcut in the browser, such as Enter, Tab, Escape, ArrowDown, Meta+Enter, or Control+K. Optionally focus a CSS selector first.",
        inputSchema: z.object({
          key: z.string().min(1),
          selector: z.string().min(1).optional(),
        }),
        execute: async ({ key, selector }) => {
          const point = selector
            ? await this.browser.cursorPoint(selector)
            : undefined;
          await this.browser.press(key, selector);
          await this.refreshBrowserPreview(
            point ? { ...point, action: "type" } : this.browserPreview?.cursor,
          );
          return `Pressed ${key}${selector ? ` on ${selector}` : ""}.`;
        },
      }),
      browser_snapshot: tool({
        description:
          "Inspect the active page as structured text: DOM, accessibility tree, console and network errors, and responsive geometry. This is the primary verification tool for models without vision.",
        inputSchema: z.object({
          viewport: z
            .enum(["mobile", "tablet", "laptop", "desktop"])
            .default("laptop"),
        }),
        execute: async ({ viewport }) => {
          const page = await this.browser.snapshot();
          const geometry = await this.browser.collectGeometry(viewport);
          await this.refreshBrowserPreview(this.browserPreview?.cursor);
          return JSON.stringify(
            {
              url: page.url,
              title: page.title,
              accessibility: page.accessibility,
              dom: page.dom.slice(0, 40_000),
              consoleErrors: page.console.filter(
                (entry) => entry.type === "error",
              ),
              networkErrors: page.network.filter(
                (entry) => entry.failed || entry.status >= 400,
              ),
              geometry,
            },
            null,
            2,
          );
        },
      }),
      browser_screenshot: tool({
        description:
          "Save a full-page screenshot for the user. Text-only models must not claim subjective visual correctness from it.",
        inputSchema: z.object({ name: z.string().default("page") }),
        execute: async ({ name }) => {
          const safe =
            name.replace(/[^a-z0-9._-]/gi, "-").replace(/^-+|-+$/g, "") ||
            "page";
          const target = path.join(
            root,
            ".opencodex",
            "browser",
            `${Date.now()}-${safe}.png`,
          );
          return this.browser.screenshot(target);
        },
      }),
      browser_close: tool({
        description:
          "Close the active browser session and remove its read-only sidebar preview.",
        inputSchema: z.object({}),
        execute: async () => {
          await this.browser.close();
          this.clearBrowserPreview();
          return "Browser session closed.";
        },
      }),
      worktree_list: tool({
        description: "List isolated Git worktrees and their branches.",
        inputSchema: z.object({}),
        execute: async () => JSON.stringify(await listWorktrees(root), null, 2),
      }),
      worktree_create: tool({
        description:
          "Create an isolated Git worktree and task branch under .opencodex/worktrees.",
        inputSchema: z.object({
          name: z.string().min(1),
          base: z.string().optional(),
        }),
        execute: async ({ name, base }) => {
          await approve(
            "command",
            `Create worktree ${name}?`,
            "Creates a branch and isolated checkout.",
          );
          return JSON.stringify(
            await createWorktree(root, { name, base }),
            null,
            2,
          );
        },
      }),
      worktree_run: tool({
        description:
          "Run a non-interactive command inside an isolated worktree.",
        inputSchema: z.object({
          name: z.string(),
          command: z.string(),
          timeoutMs: z.number().int().min(1000).max(600000).default(120000),
        }),
        execute: async ({ name, command, timeoutMs }) => {
          await approve("command", `Run command in ${name}?`, command);
          return JSON.stringify(
            await runInWorktree(root, name, command, timeoutMs),
            null,
            2,
          );
        },
      }),
      worktree_merge: tool({
        description:
          "Merge an isolated worktree branch into the main worktree.",
        inputSchema: z.object({
          name: z.string(),
          strategy: z.enum(["merge", "squash", "rebase"]).default("merge"),
        }),
        execute: async ({ name, strategy }) => {
          await approve(
            "command",
            `Merge ${name} into main?`,
            `Strategy: ${strategy}`,
            true,
          );
          return JSON.stringify(
            await mergeWorktree(root, name, "(main)", strategy),
            null,
            2,
          );
        },
      }),
      worktree_remove: tool({
        description:
          "Discard an isolated worktree. Requires approval because uncommitted work may be lost.",
        inputSchema: z.object({ name: z.string() }),
        execute: async ({ name }) => {
          await approve(
            "command",
            `Discard worktree ${name}?`,
            "Uncommitted files in the worktree will be deleted.",
            true,
          );
          await removeWorktree(root, name, true);
          return `Removed worktree ${name}.`;
        },
      }),
      repo_search: tool({
        description:
          "Search the incremental repository intelligence index by symbol and semantic relevance.",
        inputSchema: z.object({
          query: z.string().min(1),
          limit: z.number().int().min(1).max(50).default(15),
        }),
        execute: async ({ query, limit }) => {
          const index = this.repoIndex(root);
          index.indexSymbols();
          return JSON.stringify(
            {
              symbols: index.symbolSearch(query, limit),
              semantic: index.semanticSearch(query, limit),
            },
            null,
            2,
          );
        },
      }),
      repo_architecture: tool({
        description:
          "Build a source-level architecture map of repository files, imports, and external packages.",
        inputSchema: z.object({}),
        execute: async () =>
          JSON.stringify(this.repoIndex(root).architectureMap(), null, 2),
      }),
      repo_memory_list: tool({
        description:
          "List source-cited repository memory facts and invalidate any whose cited file content has changed.",
        inputSchema: z.object({}),
        execute: async () => {
          const memory = new SourceCitedMemory();
          memory.load(loadMemoryJson(root) ?? "[]");
          const files = scanWorkspace(root);
          memory.invalidate(
            files.map((entry) => ({
              path: entry.path,
              hash: hashContent(entry.content),
            })),
          );
          saveMemoryJson(root, memory.toJSON());
          return JSON.stringify(memory.all, null, 2);
        },
      }),
      repo_memory_record: tool({
        description:
          "Record a durable repository fact with a source file citation. The fact becomes stale automatically if the source changes.",
        inputSchema: z.object({
          text: z.string().min(1),
          source: z.string().min(1),
          line: z.number().int().positive().optional(),
        }),
        execute: async ({ text, source, line }) => {
          const resolved = path.resolve(root, source);
          if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
            throw new Error("Memory source must be inside the workspace.");
          const content = await fs.readFile(resolved, "utf8");
          const memory = new SourceCitedMemory();
          memory.load(loadMemoryJson(root) ?? "[]");
          const fact = memory.record({
            text,
            source,
            line,
            sourceHash: hashContent(content),
          });
          saveMemoryJson(root, memory.toJSON());
          return JSON.stringify(fact, null, 2);
        },
      }),
      github_list_issues: tool({
        description:
          "List GitHub issues for the current repository using the authenticated GitHub CLI.",
        inputSchema: z.object({
          state: z.enum(["open", "closed", "all"]).default("open"),
        }),
        execute: async ({ state }) =>
          JSON.stringify(await listIssues(root, state), null, 2),
      }),
      github_create_pr: tool({
        description:
          "Push a branch and create a GitHub pull request. Requires approval before the external action.",
        inputSchema: z.object({
          issue: z.number().int().positive(),
          branch: z.string(),
          title: z.string(),
          summary: z.string(),
          base: z.string().default("main"),
          draft: z.boolean().default(false),
        }),
        execute: async ({ issue, branch, title, summary, base, draft }) => {
          await approve(
            "command",
            `Create pull request “${title}”?`,
            `Push ${branch} and create a PR on GitHub.`,
            true,
          );
          return JSON.stringify(
            await createPullRequest(root, {
              branch,
              base,
              title,
              body: buildPrBody(issue, summary),
              draft,
            }),
            null,
            2,
          );
        },
      }),
    };
  }

  decorateTools(tools: Record<string, any>, root: string): Record<string, any> {
    for (const [name, definition] of Object.entries(tools)) {
      const execute = definition?.execute;
      if (typeof execute !== "function") continue;
      definition.execute = async (input: any, options: any) => {
        const pathValue =
          typeof input?.path === "string" ? input.path : undefined;
        const textValue =
          typeof input?.command === "string"
            ? input.command
            : JSON.stringify(input ?? {});
        await this.beforeTool({
          event: "beforeTool",
          tool: name,
          path: pathValue,
          text: textValue,
        });
        if (name === "run_command" || name.startsWith("terminal_"))
          await this.beforeTool({
            event: "onCommand",
            tool: name,
            path: pathValue,
            text: textValue,
          });
        else if (MUTATING_TOOLS.has(name))
          await this.beforeTool({
            event: "onEdit",
            tool: name,
            path: pathValue,
            text: textValue,
          });
        const result = await execute(input, options);
        await this.beforeTool({
          event: "afterTool",
          tool: name,
          path: pathValue,
          text: textValue,
        });
        return result;
      };
    }
    return tools;
  }

  private async runDueTasks(): Promise<void> {
    if (!this.taskRunner) return;
    const root = this.root();
    if (!root) return;
    const config = await this.readJson<AutomationFile>(AUTOMATIONS_FILE, {
      tasks: [],
      hooks: [],
    });
    let changed = false;
    for (const task of dueTasks(config.tasks ?? [], Date.now())) {
      task.lastRunAt = Date.now();
      task.nextRunAt = nextRunAt(task.schedule, task.lastRunAt);
      if (task.schedule.kind === "once") task.enabled = false;
      changed = true;
      await this.taskRunner(task.prompt, task.agentId).catch((error) => {
        this.output.appendLine(
          `Scheduled task ${task.name} failed: ${message(error)}`,
        );
      });
    }
    if (changed)
      await fs.writeFile(
        path.join(root, AUTOMATIONS_FILE),
        `${JSON.stringify(config, null, 2)}\n`,
        "utf8",
      );
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    void this.browser.close();
    this.clearBrowserPreview();
    this.output.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }
}

import * as vscode from 'vscode';
import * as path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { ToolLoopAgent, isLoopFinished, isStepCount } from 'ai';
import { captureGitTree, isGitTrackedWorkspace, restoreGitTree } from './git';
import { fetchProviderModels, getProvider, listProviders, type Provider } from './providers';
import { installSkillFromRepository, listInstalledSkills, listRepositorySkills, readSkillMarkdown, resolveInstallPath, sanitizeSkillName, searchSkills, skillsPromptBlock, uninstallSkill, SKILL_FILE_NAMES, SKILLS_SUBDIR } from './skills';
import { buildTools } from './tools';
import type { AppConfig, ComposerContext, Conversation, Project, ProviderModelGroup, TranscriptItem, WebMessage, WorkItem } from './types';
import { MAX_FILE_BYTES, MAX_PERSISTED_REASONING } from './types';
import { conversationTitle, createTranscriptItem, errorMessage, friendlyError, humanToolName, isSecret, normalizeApprovalMode, normalizeTranscriptItem, pathInside, providerErrorMessage, shouldAutoContinue, toolTask, truncate } from './util';
import { getWebviewHtml } from './webview';
import { systemNotify } from './notifications';
import { aggregateUsage, loadUsage, markFirstUse, maybePromptForStar, recordUsage } from './usage';
import { connectMcpServers, parseMcpServers, type McpConnection } from './mcp';
import { TerminalManager } from './terminal';
import { MEMORY_RELATIVE_PATH, openProjectMemory, readProjectMemory, writeProjectMemory } from './memory';

type PlanState = {
  title: string;
  steps: string[];
  active: number;
  done: Set<number>;
  manual: boolean;
  interrupted: boolean;
};

const MAX_CONCURRENT_RUNS = 3;

function userOsName(): string {
  switch (process.platform) {
    case 'darwin': return 'macOS (darwin)';
    case 'win32': return 'Windows (win32)';
    case 'linux': return 'Linux (linux)';
    default: return process.platform;
  }
}

function notificationSummary(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > 140 ? `${clean.slice(0, 139)}…` : clean;
}

type ActiveRun = {
  conversationId: string;
  controller: AbortController;
  steering: boolean;
};

type ProjectMetaEntry = { id?: unknown; name?: unknown; path?: unknown; createdAt?: unknown; updatedAt?: unknown };

function isProjectMeta(entry: unknown): entry is ProjectMetaEntry & { id: string; name: string; path: string } {
  const meta = entry as ProjectMetaEntry | undefined;
  return Boolean(meta && typeof meta.id === 'string' && typeof meta.name === 'string' && typeof meta.path === 'string');
}

export class AgentViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private projects: Project[] = [];
  private activeProjectId = '';
  private loaded = false;
  private runs = new Map<string, ActiveRun>();
  private queue: { text: string; conversationId: string; context?: ComposerContext; promptContext?: string }[] = [];
  private apiKeys: Record<string, string> = {};
  private persistChain: Promise<void> = Promise.resolve();
  private notifySeq = 0;
  private pendingNotifies = new Map<number, (choice: 'ok' | 'secondary' | 'cancel') => void>();
  private readonly terminals = new TerminalManager();

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.onWorkspaceFoldersChanged()),
      vscode.window.onDidChangeActiveTextEditor(() => this.sendEditorContext()),
      vscode.window.onDidChangeTextEditorSelection(() => this.sendEditorContext()),
    );
  }

  private onWorkspaceFoldersChanged(): void {
    if (!this.loaded) return;
    this.reanchorToWorkspace();
  }

  private reanchorToWorkspace(): void {
    const previous = this.activeProjectId;
    const root = this.workspaceRoot()?.fsPath;
    if (root) {
      let project = this.projects.find(item => item.path === root);
      if (!project) {
        project = this.createProject(root);
        this.projects.unshift(project);
        this.migrateLegacyWorkspaceState(project);
      }
      this.activeProjectId = project.id;
    } else {
      this.activeProjectId = this.projects[0]?.id ?? '';
    }
    if (this.activeProjectId !== previous || root) {
      this.sortProjects();
      void this.persistProjects();
      this.syncConversations();
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = getWebviewHtml(view.webview, this.context.extensionUri, this.workspaceRoot()?.fsPath);
    view.webview.onDidReceiveMessage((message: WebMessage) => this.onMessage(message));
    view.onDidDispose(() => this.disposePendingNotifies());
    this.loaded = true;
    this.loadProjects();
    this.syncConversations();
    void this.loadApiKeys().then(() => {
      if (this.view !== view) return;
      this.post({ type: 'config', model: this.config().model, provider: this.config().provider, approvalMode: this.config().approvalMode });
      void this.refreshModels();
      void this.maybeShowFirstLaunchSettings();
    });
  }

  private apiKeysLoaded?: Promise<void>;
  private loadApiKeys(): Promise<void> {
    this.apiKeysLoaded ??= this.loadApiKeysOnce();
    return this.apiKeysLoaded;
  }

  private async loadApiKeysOnce(): Promise<void> {
    const keys: Record<string, string> = {};
    for (const provider of listProviders()) {
      try {
        keys[provider.id] = (await this.context.secrets.get(`opencodex.apiKey.${provider.id}`)) ?? '';
      } catch {
        keys[provider.id] = '';
      }
    }
    this.apiKeys = keys;
    try {
      await this.context.secrets.delete('opencodex.apiKey');
      await this.context.secrets.delete('opencodex.apiKey.opencode');
      this.apiKeys.opencode = '';
    } catch {}
  }

  async openSettings(): Promise<void> { return this.showSettings(); }

  openUsage(): void {
    this.view?.show?.(true);
    this.post({ type: 'showUsage' });
    this.sendUsage();
  }

  async openMemory(): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) {
      void vscode.window.showInformationMessage('Open a folder or workspace first.');
      return;
    }
    await openProjectMemory(root);
  }

  private sendUsage(): void {
    this.post({ type: 'usage', ...aggregateUsage(loadUsage(this.context)) });
  }

  private maybePromptForStar(): void {
    maybePromptForStar(this.context);
  }

  openMarketplace(): void {
    this.view?.show?.(true);
    this.post({ type: 'showMarketplace' });
    this.sendMarketplaceInstalled();
  }

  private skillsRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, 'skills');
  }

  private globalSkillsReady?: Promise<void>;
  private ensureGlobalSkills(): Promise<void> {
    this.globalSkillsReady ??= this.ensureGlobalSkillsOnce();
    return this.globalSkillsReady;
  }

  private async ensureGlobalSkillsOnce(): Promise<void> {
    try {
      if (this.context.globalState.get<boolean>('opencodex.skillsMigrated', false)) return;
      const root = this.workspaceRoot();
      if (!root) { this.markSkillsMigrated(); return; }
      const legacy = vscode.Uri.joinPath(root, ...SKILLS_SUBDIR.split('/'));
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(legacy);
      } catch {
        this.markSkillsMigrated();
        return;
      }
      const skillFolders = entries.filter(([, type]) => (type & vscode.FileType.Directory) !== 0);
      if (!skillFolders.length) { this.markSkillsMigrated(); return; }
      const target = this.skillsRoot();
      let existing: [string, vscode.FileType][] = [];
      try { existing = await vscode.workspace.fs.readDirectory(target); } catch {}
      const present = new Set(existing.map(([name]) => name));
      for (const [name] of skillFolders) {
        if (present.has(name)) continue;
        await this.copyFolder(vscode.Uri.joinPath(legacy, name), vscode.Uri.joinPath(target, name));
      }
      this.markSkillsMigrated();
    } catch {}
  }

  private markSkillsMigrated(): void {
    void this.context.globalState.update('opencodex.skillsMigrated', true);
  }

  private async copyFolder(source: vscode.Uri, target: vscode.Uri): Promise<void> {
    const entries = await vscode.workspace.fs.readDirectory(source);
    await vscode.workspace.fs.createDirectory(target);
    for (const [name, type] of entries) {
      const from = vscode.Uri.joinPath(source, name);
      const to = vscode.Uri.joinPath(target, name);
      if ((type & vscode.FileType.Directory) !== 0) await this.copyFolder(from, to);
      else await vscode.workspace.fs.writeFile(to, await vscode.workspace.fs.readFile(from));
    }
  }

  private async sendMarketplaceInstalled(): Promise<void> {
    await this.ensureGlobalSkills();
    const sources = this.context.globalState.get<Record<string, string>>('opencodex.skillSources', {}) ?? {};
    const skills = (await listInstalledSkills(this.skillsRoot())).map(skill => ({ ...skill, source: sources[skill.folder] ?? '' }));
    this.post({ type: 'marketplaceInstalled', skills });
  }

  private async showSettings(initialSetup = false): Promise<void> {
    const config = this.config();
    this.post({
      type: 'settings',
      maxSteps: config.maxSteps,
      approvalMode: config.approvalMode,
      searxngUrl: config.searxngUrl,
      systemPrompt: config.systemPrompt,
      mcpServers: config.mcpServers,
      extraFreeModels: config.extraFreeModels.join(', '),
      provider: config.provider,
      providers: listProviders().map(provider => ({ id: provider.id, name: provider.name, needsApiKey: provider.needsApiKey, acceptsApiKey: provider.acceptsApiKey ?? provider.needsApiKey, apiKeyEnvVar: provider.apiKeyEnvVar, apiKeyUrl: provider.apiKeyUrl, isLocal: Boolean(provider.isLocal), baseUrl: this.providerBaseUrl(provider) })),
      apiKeys: Object.fromEntries(listProviders().map(provider => [provider.id, Boolean(this.apiKeys[provider.id] || (provider.apiKeyEnvVar ? process.env[provider.apiKeyEnvVar] : ''))])),
      configured: Object.fromEntries(listProviders().map(provider => [provider.id, this.providerConfigured(provider)])),
      onlyDefaultModels: this.config().onlyDefaultModels,
      confirmDelete: this.confirmDeleteConversations(),
      initialSetup,
    });
  }

  private async maybeShowFirstLaunchSettings(): Promise<void> {
    if (this.context.globalState.get<boolean>('opencodex.setupComplete', false)) return;
    await this.showSettings(true);
  }

  clear(): void {
    this.newConversation();
  }

  dispose(): void {
    this.terminals.dispose();
    this.disposePendingNotifies();
  }

  private loadProjects(): void {
    const stored = this.context.globalState.get<unknown[]>('opencodex.projectIndex', []);
    this.projects = (Array.isArray(stored) ? stored : []).filter(isProjectMeta).map(entry => {
      const data = this.context.globalState.get<{ conversations?: unknown; activeConversationId?: unknown } | undefined>(`opencodex.project.${entry.id}`, undefined);
      const conversations = Array.isArray(data?.conversations) ? data.conversations as Conversation[] : [];
      return {
        id: entry.id,
        name: entry.name,
        path: entry.path,
        createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
        updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : Date.now(),
        activeConversationId: typeof data?.activeConversationId === 'string' ? data.activeConversationId : '',
        conversations: conversations.map(conversation => {
          const baseTimestamp = Number.isFinite(conversation.createdAt) ? conversation.createdAt : Date.now();
          return { ...conversation, items: conversation.items.map((item, index) => normalizeTranscriptItem(item, baseTimestamp + index)) };
        }),
      };
    });
    const seenIds = new Set<string>();
    this.projects = this.projects.filter(project => seenIds.has(project.id) ? false : (seenIds.add(project.id), true));
    const root = this.workspaceRoot()?.fsPath;
    if (root) {
      let project = this.projects.find(item => item.path === root);
      if (!project) {
        project = this.createProject(root);
        this.projects.unshift(project);
      }
      this.migrateLegacyWorkspaceState(project);
      this.activeProjectId = project.id;
    } else {
      this.activeProjectId = this.projects[0]?.id ?? '';
    }
    this.sortProjects();
    void this.persistProjects();
  }

  private migrateLegacyWorkspaceState(project: Project): void {
    const legacy = this.context.workspaceState.get<Conversation[]>('opencodex.conversations', []);
    const legacyTranscript = this.context.workspaceState.get<TranscriptItem[]>('opencodex.transcript', []);
    if ((!legacy.length && !legacyTranscript.length) || project.conversations.length) return;
    const conversations = legacy.length
      ? legacy.map(conversation => {
        const baseTimestamp = Number.isFinite(conversation.createdAt) ? conversation.createdAt : Date.now();
        return { ...conversation, items: conversation.items.map((item, index) => normalizeTranscriptItem(item, baseTimestamp + index)) };
      })
      : [this.createConversation(legacyTranscript.map((item, index) => normalizeTranscriptItem(item, Date.now() + index)))];
    project.conversations = conversations;
    const saved = this.context.workspaceState.get<string>('opencodex.activeConversationId', '');
    project.activeConversationId = conversations.some(item => item.id === saved && !item.archived) ? saved : (conversations.find(item => !item.archived)?.id ?? '');
    project.updatedAt = Date.now();
    void this.context.workspaceState.update('opencodex.conversations', undefined);
    void this.context.workspaceState.update('opencodex.activeConversationId', undefined);
    void this.context.workspaceState.update('opencodex.transcript', undefined);
  }

  private createProject(rootPath: string): Project {
    const now = Date.now();
    return {
      id: rootPath,
      name: rootPath ? path.basename(rootPath) || rootPath : 'No folder',
      path: rootPath,
      conversations: [],
      activeConversationId: '',
      createdAt: now,
      updatedAt: now,
    };
  }

  private createConversation(items: TranscriptItem[] = []): Conversation {
    const now = Date.now();
    const first = items.find(item => item.role === 'user')?.text.trim();
    return { id: `${now}-${Math.random().toString(36).slice(2, 8)}`, title: first ? conversationTitle(first) : 'New conversation', items, archived: false, createdAt: now, updatedAt: now };
  }

  private activeProject(): Project | undefined {
    return this.projects.find(item => item.id === this.activeProjectId);
  }

  private ensureProjectForRoot(): Project | undefined {
    const root = this.workspaceRoot()?.fsPath;
    if (!root) return undefined;
    let project = this.projects.find(item => item.path === root);
    if (!project) {
      project = this.createProject(root);
      this.projects.unshift(project);
    }
    this.activeProjectId = project.id;
    return project;
  }

  private sortProjects(): void {
    const root = this.workspaceRoot()?.fsPath;
    this.projects.sort((a, b) => {
      if (root) {
        if (a.path === root) return -1;
        if (b.path === root) return 1;
      }
      return b.updatedAt - a.updatedAt;
    });
  }

  private activeConversation(): Conversation | undefined {
    const project = this.activeProject();
    if (!project) return undefined;
    let conversation = project.conversations.find(item => item.id === project.activeConversationId);
    if (!conversation) {
      conversation = this.createConversation();
      project.conversations.unshift(conversation);
      project.activeConversationId = conversation.id;
    }
    return conversation;
  }

  private newConversation(): void {
    const project = this.activeProject();
    if (!project) return;
    const empty = project.conversations.find(item => !item.archived && item.items.length === 0);
    const conversation = empty ?? this.createConversation();
    if (!empty) project.conversations.unshift(conversation);
    project.activeConversationId = conversation.id;
    project.updatedAt = Date.now();
    void this.persistProjects();
    this.syncConversations();
  }

  private persistProjects(): Promise<void> {
    const projects = this.projects.slice(0, 60);
    this.persistChain = this.persistChain.then(async () => {
      await this.context.globalState.update('opencodex.projectIndex', projects.map(({ id, name, path, createdAt, updatedAt }) => ({ id, name, path, createdAt, updatedAt })));
      for (const project of projects) {
        await this.context.globalState.update(`opencodex.project.${project.id}`, {
          conversations: project.conversations.slice(0, 100),
          activeConversationId: project.activeConversationId,
        });
      }
    });
    return this.persistChain;
  }

  private syncConversations(includeActive = true): void {
    const root = this.workspaceRoot();
    this.post({ type: 'project', name: root ? path.basename(root.fsPath) || root.fsPath : 'No folder open', path: root ? root.fsPath : '' });
    const project = this.activeProject();
    if (!project) return;
    this.post({ type: 'conversations', conversations: project.conversations.map(({ id, title, archived, updatedAt, items }) => ({
      id, title, archived, updatedAt,
      hasMessages: items.length > 0,
      running: this.runs.has(id),
      queued: this.queue.find(entry => entry.conversationId === id)?.text ?? null,
    })), activeId: project.activeConversationId });
    if (includeActive) {
      const active = this.activeConversation();
      if (active) this.post({ type: 'conversation', id: active.id, items: active.items });
    }
  }

  private confirmDeleteConversations(): boolean {
    return this.context.globalState.get<boolean>('opencodex.confirmDelete', true) !== false;
  }

  private async onMessage(message: WebMessage): Promise<void> {
    if (message.type === 'notifyResponse') {
      const resolve = this.pendingNotifies.get(message.id);
      if (resolve) {
        this.pendingNotifies.delete(message.id);
        resolve(message.choice);
      }
      return;
    }
    if (message.type === 'ready') {
      this.syncConversations();
      await this.loadApiKeys();
      this.post({ type: 'config', model: this.config().model, provider: this.config().provider, approvalMode: this.config().approvalMode });
      await this.refreshModels();
      await this.maybeShowFirstLaunchSettings();
      this.sendUsage();
      this.maybePromptForStar();
      this.sendEditorContext();
      return;
    }
    if (message.type === 'stop') {
      const project = this.activeProject();
      this.runs.get(project?.activeConversationId ?? '')?.controller.abort();
      return;
    }
    if (message.type === 'copyText') {
      await vscode.env.clipboard.writeText(message.text);
      this.post({ type: 'copied' });
      return;
    }
    if (message.type === 'removeQueued') {
      this.queue = this.queue.filter(entry => entry.conversationId !== message.conversationId);
      this.postQueued(message.conversationId);
      return;
    }
    if (message.type === 'steerQueued') {
      const run = this.runs.get(message.conversationId);
      if (!run) return;
      run.steering = true;
      run.controller.abort();
      return;
    }
    if (message.type === 'newConversation') return this.newConversation();
    if (message.type === 'openConversation') {
      const project = this.activeProject();
      if (project && project.conversations.some(item => item.id === message.id)) {
        project.activeConversationId = message.id;
        project.updatedAt = Date.now();
        void this.persistProjects();
        this.syncConversations();
      }
      return;
    }
    if (message.type === 'archiveConversation') {
      const project = this.activeProject();
      const conversation = project?.conversations.find(item => item.id === message.id);
      if (!project || !conversation || this.runs.has(message.id)) return;
      this.queue = this.queue.filter(entry => entry.conversationId !== message.id);
      conversation.archived = !conversation.archived;
      conversation.updatedAt = Date.now();
      project.updatedAt = Date.now();
      if (conversation.archived && project.activeConversationId === conversation.id) {
        const next = project.conversations.find(item => !item.archived && item.id !== conversation.id);
        if (next) project.activeConversationId = next.id;
        else {
          const fresh = this.createConversation();
          project.conversations.unshift(fresh);
          project.activeConversationId = fresh.id;
        }
      }
      await this.persistProjects();
      this.syncConversations();
      return;
    }
    if (message.type === 'deleteConversation') {
      const project = this.activeProject();
      const conversation = project?.conversations.find(item => item.id === message.id);
      if (!project || !conversation || this.runs.has(message.id)) return;
      const messageCount = conversation.items.length;
      const detail = 'This permanently deletes ' + (conversation.archived ? 'the archived conversation' : 'this conversation') + (messageCount ? ' and its ' + messageCount + ' message' + (messageCount === 1 ? '' : 's') : '') + '. This cannot be undone.';
      if (this.confirmDeleteConversations()) {
        const choice = await this.prompt('Delete conversation \'' + conversation.title + '\'?', detail, { ok: 'Delete', secondary: 'Don\'t ask again', cancel: 'Cancel', danger: true });
        if (choice === 'secondary') {
          await this.context.globalState.update('opencodex.confirmDelete', false);
          return;
        }
        if (choice !== 'ok') return;
      }
      this.queue = this.queue.filter(entry => entry.conversationId !== message.id);
      project.conversations = project.conversations.filter(item => item.id !== message.id);
      project.updatedAt = Date.now();
      if (project.activeConversationId === message.id) {
        const next = project.conversations.find(item => !item.archived) ?? this.createConversation();
        if (!project.conversations.includes(next)) project.conversations.unshift(next);
        project.activeConversationId = next.id;
      }
      await this.persistProjects();
      this.syncConversations();
      systemNotify(this.context, { subtitle: 'Conversation deleted', message: 'Conversation \'' + conversation.title + '\' was deleted.' });
      return;
    }
    if (message.type === 'restoreCheckpoint') {
      if (this.runs.size) return;
      const root = this.workspaceRoot();
      const project = this.activeProject();
      if (!root || !project || project.path !== root.fsPath || !isGitTrackedWorkspace(root.fsPath)) {
        void vscode.window.showInformationMessage('Restore is available only for the Git-tracked project that matches the current folder.');
        return;
      }
      const conversation = project.conversations.find(item => item.id === message.conversationId);
      const targetIndex = conversation?.items.findIndex(item => item.id === message.itemId && item.role === 'assistant') ?? -1;
      if (!conversation || targetIndex < 0) return;
      const target = conversation.items[targetIndex];
      if (!target?.gitTree) {
        void vscode.window.showInformationMessage('This message does not have a Git restore point. Restore points are created for newer Opencodex responses.');
        return;
      }
      const removedMessageCount = conversation.items.length - targetIndex - 1;
      const detail = `This will restore Git-visible files to their state before this response${removedMessageCount ? ` and remove ${removedMessageCount} later message${removedMessageCount === 1 ? '' : 's'}` : ''}. The selected message will stay. Your staging area will not be changed.`;
      const choice = await this.prompt('Restore to before this response?', detail, { ok: 'Restore', cancel: 'Cancel', danger: true });
      if (choice !== 'ok') return;
      try {
        await restoreGitTree(root.fsPath, target.gitTree);
      } catch (error) {
        void vscode.window.showErrorMessage(`Git restore failed: ${errorMessage(error)}`);
        return;
      }
      conversation.items = conversation.items.slice(0, targetIndex + 1);
      conversation.updatedAt = Date.now();
      project.activeConversationId = conversation.id;
      project.updatedAt = Date.now();
      await this.persistProjects();
      this.syncConversations();
      void vscode.window.showInformationMessage('Git workspace and conversation restored.');
      return;
    }
    if (message.type === 'setKey' || message.type === 'requestSettings') return this.showSettings();
    if (message.type === 'requestUsage') return this.openUsage();
    if (message.type === 'requestMarketplace') return this.openMarketplace();
    if (message.type === 'requestMarketplaceInstalled') return void this.sendMarketplaceInstalled();
    if (message.type === 'marketplaceTop') {
      try {
        const { skills, total } = await searchSkills('skill', { limit: 20, sortBy: message.sortBy ?? 'stars' });
        this.post({ type: 'marketplaceResults', query: '', total, skills });
      } catch (error) {
        this.post({ type: 'marketplaceError', text: errorMessage(error) });
      }
      return;
    }
    if (message.type === 'marketplaceSearch') {
      try {
        const { skills, total } = await searchSkills(message.query, { limit: Math.max(1, Math.min(50, message.limit || 10)), sortBy: message.sortBy });
        this.post({ type: 'marketplaceResults', query: message.query, total, skills });
      } catch (error) {
        this.post({ type: 'marketplaceError', text: errorMessage(error) });
      }
      return;
    }
    if (message.type === 'marketplaceListRepo') {
      try {
        const reference = resolveInstallPath(message.source, '', message.branch ?? 'main');
        const skills = await listRepositorySkills(reference.owner, reference.repo, reference.branch);
        this.post({ type: 'marketplaceRepoSkills', owner: reference.owner, repo: reference.repo, branch: reference.branch, skills });
      } catch (error) {
        this.post({ type: 'marketplaceError', text: errorMessage(error) });
      }
      return;
    }
    if (message.type === 'marketplacePreview') {
      try {
        const reference = resolveInstallPath(message.source, '', message.branch ?? 'main');
        const folderPath = message.path ?? reference.folderPath ?? '';
        if (!folderPath) {
          const skills = await listRepositorySkills(reference.owner, reference.repo, reference.branch);
          this.post({ type: 'marketplaceRepoSkills', owner: reference.owner, repo: reference.repo, branch: reference.branch, skills });
          return;
        }
        const { content } = await readSkillMarkdown(reference.owner, reference.repo, reference.branch, folderPath);
        this.post({ type: 'marketplacePreview', title: reference.owner + '/' + reference.repo + ' / ' + folderPath, markdown: truncate(content), source: message.source, path: folderPath });
      } catch (error) {
        this.post({ type: 'marketplaceError', text: errorMessage(error) });
      }
      return;
    }
    if (message.type === 'marketplaceInstall') {
      const key = message.key ?? '';
      await this.ensureGlobalSkills();
      try {
        const reference = resolveInstallPath(message.source, message.skill ?? '', message.branch ?? 'main');
        const requested = message.skill ?? '';
        let folderPath = reference.folderPath;
        if (!folderPath) {
          const skills = await listRepositorySkills(reference.owner, reference.repo, reference.branch);
          const match = requested
            ? skills.find(candidate => candidate.name === sanitizeSkillName(requested) || candidate.name.toLowerCase() === requested.trim().toLowerCase())
            : undefined;
          if (!match) {
            this.post({ type: 'marketplaceResult', ok: false, text: skills.length ? reference.owner + '/' + reference.repo + ' has ' + skills.length + ' skills. Pick one: ' + skills.slice(0, 20).map(skill => skill.name).join(', ') : 'No SKILL.md skills found in ' + reference.owner + '/' + reference.repo + '.', key });
            return;
          }
          folderPath = match.path;
        }
        const installName = sanitizeSkillName(reference.hintedName ?? folderPath.split('/').pop() ?? message.skill ?? 'skill');
        await this.approve('edit', 'Install skill "' + installName + '"?', 'Source: ' + reference.owner + '/' + reference.repo + (folderPath ? ' (' + folderPath + ')' : '') + '\n\nThe skill will be installed into your global skills folder as \'' + installName + '\' and is available in every workspace.');
        await installSkillFromRepository(this.skillsRoot(), { owner: reference.owner, repo: reference.repo, branch: reference.branch, folderPath, installName }, undefined, (done, total) => {
          this.post({ type: 'marketplaceInstallProgress', key, done, total });
        });
        const sources = this.context.globalState.get<Record<string, string>>('opencodex.skillSources', {}) ?? {};
        sources[installName] = reference.owner + '/' + reference.repo;
        await this.context.globalState.update('opencodex.skillSources', sources);
        this.post({ type: 'marketplaceResult', ok: true, text: '', key });
        await this.sendMarketplaceInstalled();
      } catch (error) {
        this.post({ type: 'marketplaceResult', ok: false, text: errorMessage(error), key });
      }
      return;
    }
    if (message.type === 'marketplaceUninstall') {
      await this.ensureGlobalSkills();
      try {
        const safeName = sanitizeSkillName(message.folder);
        const installed = await listInstalledSkills(this.skillsRoot());
        const skill = installed.find(item => item.folder === safeName || sanitizeSkillName(item.name) === safeName);
        if (!skill) {
          this.post({ type: 'marketplaceResult', ok: false, text: 'Skill \'' + (message.folder || '') + '\' not found.' });
          return;
        }
        const choice = await this.prompt('Uninstall skill \'' + skill.name + '\'?', 'This removes \'' + skill.name + '\' from your global skills folder. It will no longer be offered to the agent in any workspace.', { ok: 'Uninstall', cancel: 'Cancel', danger: true });
        if (choice !== 'ok') return;
        await uninstallSkill(this.skillsRoot(), skill.folder);
        const sources = this.context.globalState.get<Record<string, string>>('opencodex.skillSources', {}) ?? {};
        delete sources[skill.folder];
        await this.context.globalState.update('opencodex.skillSources', sources);
        this.post({ type: 'marketplaceResult', ok: true, text: '' });
        await this.sendMarketplaceInstalled();
      } catch (error) {
        this.post({ type: 'marketplaceResult', ok: false, text: errorMessage(error) });
      }
      return;
    }
    if (message.type === 'saveSettings') {
      try {
        const searxngUrl = message.searxngUrl.trim().replace(/\/$/, '');
        if (searxngUrl && !/^https?:\/\//i.test(searxngUrl)) throw new Error('SearXNG URL must start with http:// or https://.');
        parseMcpServers(message.mcpServers ?? '{}');
        const rawMaxSteps = Number(message.maxSteps);
        const maxSteps = rawMaxSteps === 0 ? 0 : Math.max(1, Math.min(50, Math.round(rawMaxSteps) || 20));
        const providerId = listProviders().some(provider => provider.id === message.provider) ? message.provider : 'opencode';
        const config = vscode.workspace.getConfiguration('opencodex');
        await config.update('maxSteps', maxSteps, vscode.ConfigurationTarget.Global);
        await config.update('provider', providerId, vscode.ConfigurationTarget.Global);
        await config.update('extraFreeModels', message.extraFreeModels ?? '', vscode.ConfigurationTarget.Global);
        await this.context.globalState.update('opencodex.approvalMode', normalizeApprovalMode(message.approvalMode));
        await this.context.globalState.update('opencodex.searxngUrl', searxngUrl);
        await this.context.globalState.update('opencodex.systemPrompt', message.systemPrompt ?? '');
        await this.context.globalState.update('opencodex.mcpServers', message.mcpServers?.trim() || '{}');
        await this.context.globalState.update('opencodex.onlyDefaultModels', Boolean(message.onlyDefaultModels));
        await this.context.globalState.update('opencodex.confirmDelete', message.confirmDelete !== false);
        await this.context.globalState.update('opencodex.setupComplete', true);
        const provider = getProvider(providerId);
        if (provider.isLocal) {
          const baseUrl = (message.baseUrl ?? '').trim().replace(/\/$/, '');
          if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('Server URL must start with http:// or https://.');
          await this.context.globalState.update(`opencodex.baseUrl.${providerId}`, baseUrl || undefined);
        }
        if (message.apiKey.trim() && (provider.acceptsApiKey ?? provider.needsApiKey)) {
          await this.context.secrets.store(`opencodex.apiKey.${providerId}`, message.apiKey.trim());
          this.apiKeys[providerId] = message.apiKey.trim();
        }
        this.post({ type: 'settingsResult', ok: true, text: 'Settings saved.' });
        await this.refreshModels();
      } catch (error) {
        this.post({ type: 'settingsResult', ok: false, text: errorMessage(error) });
      }
      return;
    }
    if (message.type === 'removeApiKey') {
      const providerId = listProviders().some(provider => provider.id === message.provider) ? message.provider : this.config().provider;
      try {
        await this.context.secrets.delete(`opencodex.apiKey.${providerId}`);
      } catch {}
      delete this.apiKeys[providerId];
      const provider = getProvider(providerId);
      this.post({ type: 'apiKeyState', provider: providerId, hasApiKey: Boolean(this.apiKeys[providerId] || (provider.apiKeyEnvVar ? process.env[provider.apiKeyEnvVar] : '')), configured: this.providerConfigured(provider) });
      return;
    }
    if (message.type === 'resetSettings') {
      const config = vscode.workspace.getConfiguration('opencodex');
      await config.update('maxSteps', 20, vscode.ConfigurationTarget.Global);
      await config.update('provider', 'opencode', vscode.ConfigurationTarget.Global);
      await config.update('extraFreeModels', '', vscode.ConfigurationTarget.Global);
      await this.context.globalState.update('opencodex.approvalMode', 'ask');
      await this.context.globalState.update('opencodex.searxngUrl', undefined);
      await this.context.globalState.update('opencodex.systemPrompt', undefined);
      await this.context.globalState.update('opencodex.mcpServers', undefined);
      await this.context.globalState.update('opencodex.onlyDefaultModels', undefined);
      await this.context.globalState.update('opencodex.confirmDelete', undefined);
      for (const provider of listProviders()) {
        await this.context.secrets.delete(`opencodex.apiKey.${provider.id}`);
        await this.context.globalState.update(`opencodex.baseUrl.${provider.id}`, undefined);
      }
      this.apiKeys = {};
      await this.context.secrets.delete('opencodex.apiKey');
      await this.showSettings();
      return;
    }
    if (message.type === 'selectModel') {
      const config = vscode.workspace.getConfiguration('opencodex');
      await config.update('model', message.model, vscode.ConfigurationTarget.Global);
      if (message.provider && listProviders().some(provider => provider.id === message.provider)) {
        await config.update('provider', message.provider, vscode.ConfigurationTarget.Global);
      }
      this.post({ type: 'config', model: message.model, provider: this.config().provider, approvalMode: this.config().approvalMode });
      void this.refreshModels();
      return;
    }
    if (message.type === 'openFile') {
      try {
        const uri = this.resolveWorkspacePath(message.path);
        await vscode.window.showTextDocument(uri);
      } catch (error) {
        vscode.window.showErrorMessage(errorMessage(error));
      }
      return;
    }
    if (message.type === 'chooseContext') {
      const root = this.workspaceRoot();
      if (!root) return;
      const chosen = await vscode.window.showOpenDialog({
        defaultUri: root,
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: true,
        openLabel: 'Add context',
      });
      const attachments = [];
      for (const uri of chosen ?? []) {
        if (!pathInside(root.fsPath, uri.fsPath)) continue;
        const stat = await vscode.workspace.fs.stat(uri);
        attachments.push({
          kind: (stat.type & vscode.FileType.Directory) !== 0 ? 'folder' : 'file',
          path: path.relative(root.fsPath, uri.fsPath),
        });
      }
      this.post({ type: 'contextAttachments', attachments });
      return;
    }
    if (message.type === 'openMemory') {
      const root = this.workspaceRoot();
      if (root) await openProjectMemory(root);
      return;
    }
    if (message.type === 'revealInOS') {
      const root = this.workspaceRoot();
      if (!root) {
        void vscode.window.showInformationMessage('Open a folder or workspace first.');
        return;
      }
      try {
        await vscode.commands.executeCommand('revealFileInOS', root);
      } catch {
        void vscode.window.showInformationMessage('Could not open the folder in your file explorer.');
      }
      return;
    }
    if (message.type === 'revealSkill') {
      const raw = (message.folder || '').trim();
      if (!raw || raw.includes('/') || raw.includes('\\') || raw === '.' || raw === '..') {
        void vscode.window.showInformationMessage('Invalid skill folder.');
        return;
      }
      const folderUri = vscode.Uri.joinPath(this.skillsRoot(), raw);
      try {
        const stat = await vscode.workspace.fs.stat(folderUri);
        if ((stat.type & vscode.FileType.Directory) === 0) throw new Error('not a folder');
      } catch {
        void vscode.window.showInformationMessage(`Skill '${raw}' is not installed.`);
        return;
      }
      let target = folderUri;
      for (const fileName of SKILL_FILE_NAMES) {
        const candidate = vscode.Uri.joinPath(folderUri, fileName);
        try {
          const stat = await vscode.workspace.fs.stat(candidate);
          if ((stat.type & vscode.FileType.File) !== 0) { target = candidate; break; }
        } catch {}
      }
      try {
        await vscode.commands.executeCommand('revealFileInOS', target);
      } catch {
        void vscode.window.showInformationMessage('Could not open the skill in your file explorer.');
      }
      return;
    }
    if (message.type === 'send' && message.text.trim()) {
      markFirstUse(this.context);
      const previousActive = this.activeProjectId;
      const project = this.ensureProjectForRoot();
      if (!project) {
        this.post({ type: 'error', text: 'Open a folder or workspace first.' });
        return;
      }
      if (previousActive !== project.id) this.syncConversations();
      let conversationId = message.conversationId || project.activeConversationId;
      if (!project.conversations.some(conversation => conversation.id === conversationId)) {
        const active = this.activeConversation();
        if (!active) return;
        conversationId = active.id;
      }
      const root = this.workspaceRoot();
      const promptContext = root ? await this.composerContextBlock(root, message.context) : '';
      if (this.runs.has(conversationId) || this.runs.size >= MAX_CONCURRENT_RUNS) {
        this.enqueue(message.text.trim(), conversationId, message.context, promptContext);
      } else {
        void this.run(message.text.trim(), conversationId, undefined, undefined, message.context, promptContext);
      }
      return;
    }
    if (message.type === 'retryMessage') {
      const project = this.activeProject();
      const conversation = project?.conversations.find(item => item.id === message.conversationId);
      if (!project || !conversation || this.runs.has(message.conversationId)) return;
      const last = conversation.items[conversation.items.length - 1];
      const resume = last?.kind === 'error'
        ? { work: last.work, errorText: last.text }
        : undefined;
      if (last?.kind === 'error') conversation.items.pop();
      project.activeConversationId = conversation.id;
      project.updatedAt = Date.now();
      await this.persistProjects();
      this.syncConversations();
      await this.run('Continue', conversation.id, resume);
    }
  }

  private enqueue(text: string, conversationId: string, context?: ComposerContext, promptContext?: string): void {
    this.queue = this.queue.filter(entry => entry.conversationId !== conversationId);
    this.queue.push({ text, conversationId, context, promptContext });
    this.postQueued(conversationId);
  }

  private postQueued(conversationId: string): void {
    const entry = this.queue.find(item => item.conversationId === conversationId);
    this.post({ type: 'queuedPrompt', conversationId, prompt: entry?.text ?? null });
  }

  private async run(userText: string, conversationId: string, resume?: { work?: WorkItem[]; errorText?: string }, carryTree?: string, composerContext?: ComposerContext, preparedPromptContext?: string): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) {
      this.post({ type: 'error', text: 'Open a folder or workspace first.' });
      return;
    }
    const project = this.ensureProjectForRoot();
    if (!project) {
      this.post({ type: 'error', text: 'Open a folder or workspace first.' });
      return;
    }
    const promptContext = resume ? '' : preparedPromptContext ?? await this.composerContextBlock(root, composerContext);

    let conversation = project.conversations.find(item => item.id === conversationId);
    if (!conversation) {
      conversation = this.createConversation();
      project.conversations.unshift(conversation);
      conversationId = conversation.id;
    }
    const gitTracked = isGitTrackedWorkspace(root.fsPath);
    const run: ActiveRun = { conversationId, controller: new AbortController(), steering: false };
    this.runs.set(conversationId, run);
    let runGitTree = gitTracked ? carryTree : undefined;
    let carriedGitTree = carryTree;
    if (resume) {
      this.post({ type: 'resume', conversationId });
    } else {
      const userItem = createTranscriptItem('user', userText);
      conversation.items.push(userItem);
      if (conversation.items.length === 1) conversation.title = conversationTitle(userText);
      this.post({ type: 'user', conversationId, item: userItem });
    }
    conversation.updatedAt = Date.now();
    project.updatedAt = Date.now();
    await this.persistProjects();
    this.syncConversations(false);
    this.post({ type: 'state', conversationId, running: true, label: 'Thinking' });

    const work: WorkItem[] = resume ? [...(resume.work ?? [])] : [];
    const activeTasks = new Map<string, WorkItem>();
    let reasoningBuffer = '';
    let reasoningTruncated = false;
    let workStartedAt = 0;
    let planItem: WorkItem | undefined;
    let planState: PlanState | undefined;
    let mcpConnection: McpConnection | undefined;
    const describePlan = (): string => {
      const current = planState;
      if (!current) return 'No plan yet: call the plan tool with title and steps to create one.';
      if (!current.steps.length) return `Current plan: ${current.title}`;
      const lines = current.steps.map((step, index) => {
        const status = current.done.has(index) ? 'done' : index === current.active ? 'current' : 'pending';
        return `${index}. [${status}] ${step}`;
      });
      return `Current plan (${current.title}):\n${lines.join('\n')}`;
    };
    const postPlan = (): void => {
      if (!planState) return;
      const allDone = planState.done.size === planState.steps.length;
      if (planItem) {
        planItem.doneSteps = [...planState.done].sort((a, b) => a - b);
        planItem.activeStep = allDone ? -1 : planState.active;
        planItem.interrupted = planState.interrupted;
        planItem.done = allDone;
      }
      this.post({
        type: 'plan', conversationId, title: planState.title, steps: planState.steps,
        activeStep: allDone ? -1 : planState.active,
        doneSteps: [...planState.done].sort((a, b) => a - b),
        done: allDone,
        interrupted: planState.interrupted,
      });
    };
    const finalizePlan = (): void => {
      if (!planState) return;
      planState.done = new Set(planState.steps.map((_, index) => index));
      planState.active = -1;
      planState.manual = true;
      postPlan();
    };
    if (resume) {
      const priorPlan = [...work].reverse().find(item => item.kind === 'plan');
      if (priorPlan) {
        const steps = priorPlan.steps ?? [];
        const done = new Set<number>((priorPlan.doneSteps ?? []).filter(index => Number.isInteger(index)));
        let active = Number.isInteger(priorPlan.activeStep) && (priorPlan.activeStep ?? -1) >= 0 ? (priorPlan.activeStep as number) : 0;
        if (active >= steps.length) active = -1;
        planState = { title: priorPlan.title ?? 'Plan', steps, active, done, manual: Boolean(priorPlan.manual), interrupted: false };
        planItem = priorPlan;
        planItem.done = done.size === steps.length && steps.length > 0;
        planItem.doneSteps = [...done].sort((a, b) => a - b);
        planItem.activeStep = active;
        planItem.interrupted = false;
        planItem.manual = planState.manual;
        postPlan();
      }
    }
    const providerConfig = getProvider(this.config().provider);
    try {
      if (gitTracked) runGitTree ??= await captureGitTree(root.fsPath);
      const { model, maxSteps, apiKey, baseUrl } = this.config();
      if (!model) {
        await this.refreshModels();
        this.post({ type: 'error', text: 'Choose a model from the selector below the message box.' });
        return;
      }
      let reconnectAttempt = 0;
      const provider = createOpenAICompatible({
        name: providerConfig.id,
        baseURL: baseUrl,
        ...(apiKey ? { apiKey } : {}),
        ...(providerConfig.id === 'openrouter' ? { headers: { 'HTTP-Referer': 'https://github.com/matonhp5108/Opencodex', 'X-Title': 'Opencodex' } } : {}),
        fetch: async (input, init) => {
          try {
            const response = await fetch(input, init);
            if (response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500) {
              reconnectAttempt = Math.min(5, reconnectAttempt + 1);
              this.post({ type: 'retry', conversationId, attempt: reconnectAttempt, max: 5 });
            } else if (response.ok && reconnectAttempt) {
              this.post({ type: 'retryEnd', conversationId, ok: true, attempt: reconnectAttempt, max: 5 });
              reconnectAttempt = 0;
            }
            return response;
          } catch (error) {
            if (!run.controller.signal.aborted) {
              reconnectAttempt = Math.min(5, reconnectAttempt + 1);
              this.post({ type: 'retry', conversationId, attempt: reconnectAttempt, max: 5 });
            }
            throw error;
          }
        },
      });

      await this.ensureGlobalSkills();
      const skillBlock = await skillsPromptBlock(this.skillsRoot());
      const projectMemory = await readProjectMemory(root);
      mcpConnection = await connectMcpServers(
        this.config().mcpServers,
        root.fsPath,
        (title, detail) => this.approve('command', title, detail),
      );
      const instructions = [
        this.systemPrompt(root),
        projectMemory ? `Durable project memory from ${MEMORY_RELATIVE_PATH}:\n${projectMemory}` : '',
        `- Skills from the SkillsMP marketplace can be installed on request. Use skillsmp_search to find one, skillsmp_get_skill to preview it, and skillsmp_install_skill (it asks the user for approval) to add it to your global skills folder. Installed skills are available to the agent from the next request on; read their SKILL.md before applying them.`,
        mcpConnection.instructions.length ? `Connected MCP server instructions:\n${mcpConnection.instructions.join('\n')}` : '',
        mcpConnection.errors.length ? `Some configured MCP servers could not connect:\n- ${mcpConnection.errors.join('\n- ')}` : '',
        skillBlock,
      ].filter(Boolean).join('\n\n');
      const memoryAccess = {
        path: MEMORY_RELATIVE_PATH,
        read: () => readProjectMemory(root),
        write: async (content: string, reason?: string) => {
          const before = await readProjectMemory(root);
          await this.reviewEdit(MEMORY_RELATIVE_PATH, before, content, reason ?? 'Store durable project context for future conversations.');
          await writeProjectMemory(root, content);
        },
      };

      const delegate = async (role: 'explorer' | 'reviewer' | 'worker', task: string, context?: string): Promise<string> => {
        const subagentTools = buildTools({
          root,
          skillsDir: this.skillsRoot(),
          config: () => this.config(),
          approve: (kind, title, detail, destructive) => this.approve(kind, title, detail, destructive),
          reviewEdit: (filePath, before, after, reason, destructive) => this.reviewEdit(filePath, before, after, reason, destructive),
          post: message => this.post(message),
          resolvePath: filePath => this.resolveWorkspacePath(filePath),
          describePlan: () => 'Subagents do not publish a parent plan. Work directly on the assigned task.',
          abortSignal: run.controller.signal,
          terminals: this.terminals,
          memory: memoryAccess,
        });
        if (role !== 'worker') {
          for (const name of ['write_file', 'replace_text', 'delete_file', 'run_command', 'terminal_start', 'terminal_write', 'terminal_stop', 'memory_update', 'skillsmp_install_skill']) delete subagentTools[name];
        }
        const roleInstruction = role === 'explorer'
          ? 'Research the repository read-only. Return findings with precise file paths and line references.'
          : role === 'reviewer'
            ? 'Review independently and read-only. Look for correctness, regressions, security issues, and missing verification. Return only actionable findings or state that none were found.'
            : 'Complete the bounded implementation or verification task. Inspect before editing, preserve unrelated changes, and verify the result.';
        const subagent = new ToolLoopAgent({
          model: provider(model),
          maxRetries: 3,
          instructions: `${this.systemPrompt(root)}\n\nYou are a ${role} subagent. ${roleInstruction}\nDo not delegate further.`,
          tools: { ...subagentTools, ...(role === 'worker' ? mcpConnection?.tools : {}) },
          stopWhen: isStepCount(maxSteps === 0 ? 12 : Math.max(2, Math.min(12, maxSteps))),
        });
        const result = await subagent.generate({
          prompt: `${task.trim()}${context?.trim() ? `\n\nContext from the parent agent:\n${context.trim()}` : ''}`,
          abortSignal: run.controller.signal,
        });
        if (result.usage?.inputTokens || result.usage?.outputTokens) {
          recordUsage(this.context, { model, provider: providerConfig.id, inputTokens: result.usage.inputTokens ?? 0, outputTokens: result.usage.outputTokens ?? 0 });
        }
        return result.text.trim() || '(Subagent completed without a text response.)';
      };

      const agentTools = {
        ...buildTools({
          root,
          skillsDir: this.skillsRoot(),
          config: () => this.config(),
          approve: (kind, title, detail, destructive) => this.approve(kind, title, detail, destructive),
          reviewEdit: (filePath, before, after, reason, destructive) => this.reviewEdit(filePath, before, after, reason, destructive),
          post: message => this.post(message),
          resolvePath: filePath => this.resolveWorkspacePath(filePath),
          describePlan,
          abortSignal: run.controller.signal,
          terminals: this.terminals,
          delegate,
          memory: memoryAccess,
        }),
        ...mcpConnection.tools,
      };

      const agent = new ToolLoopAgent({
        model: provider(model),
        maxRetries: 4,
        instructions,
        tools: agentTools,
        stopWhen: maxSteps === 0 ? isLoopFinished() : isStepCount(maxSteps),
      });

      let streamPrompt: string;
      let resumeContext = '';
      if (resume) {
        const plan = planState;
        const planLines = plan?.steps
          ? plan.steps.map((step, index) => `- ${plan.done.has(index) ? '[done]' : index === plan.active ? '[current]' : '[pending]'} ${step}`).join('\n')
          : '';
        const inProgressLines = work.filter(item => item.kind === 'task' && item.done === false)
          .map(item => `- ${item.text.replace(/\s+/g, ' ')}`)
          .join('\n');
        const doneLines = work.filter(item => item.kind === 'task' && item.done !== false).slice(-10)
          .map(item => `- ${item.text.replace(/\s+/g, ' ')}`)
          .join('\n');
        resumeContext = [
          planLines ? `Task plan:\n${planLines}` : '',
          inProgressLines ? `Current task (continue from here):\n${inProgressLines}` : '',
          doneLines ? `Work already completed (do not redo):\n${doneLines}` : '',
          resume?.errorText ? `The last attempt ended with:\n${resume.errorText}` : '',
        ].filter(Boolean).join('\n\n');
        streamPrompt = resumeContext
          ? `The previous attempt of this task was interrupted. Continue from exactly where it stopped, using the plan and last task below: do NOT redo completed work or replay the original request. Work through only the remaining steps, verify the result, then give only the concise final summary.\n\n${resumeContext}`
          : userText;
      } else {
        const recent = conversation.items.slice(-10, -1)
          .map(item => `${item.role.toUpperCase()}: ${item.text}`)
          .join('\n\n');
        streamPrompt = recent
          ? `Previous conversation:\n${recent}\n\nCurrent request:\n${userText}${promptContext}`
          : `${userText}${promptContext}`;
      }
      let answer = '';
      let finishReason = '';
      let stepCount = 0;
      let continuationCount = 0;
      let liveInput = 0;
      let liveOutput = 0;
      do {
        finishReason = '';
        const result = await agent.stream({
          prompt: streamPrompt,
          abortSignal: run.controller.signal,
          onToolExecutionStart: ({ toolCall }) => {
            if (toolCall.toolName === 'plan') {
              const input = toolCall.input as { title?: string; steps?: string[]; activeStep?: number; doneSteps?: number[] };
              const parsedSteps = Array.isArray(input?.steps)
                ? input.steps.filter((step): step is string => typeof step === 'string' && step.trim().length > 0).map(step => step.trim())
                : [];
              const passedDone = new Set<number>();
              for (const index of input?.doneSteps ?? []) {
                if (Number.isInteger(index) && (index as number) >= 0) passedDone.add(index as number);
              }
              if (parsedSteps.length) {
                const title = typeof input?.title === 'string' && input.title.trim() ? input.title.trim() : planState?.title ?? 'Plan';
                const done = new Set<number>();
                for (const index of passedDone) if (index < parsedSteps.length) done.add(index);
                for (const index of planState?.done ?? []) if (index < parsedSteps.length) done.add(index);
                let active = Number.isInteger(input?.activeStep) ? (input.activeStep as number) : (planState && planState.active >= 0 ? planState.active : 0);
                if (active >= parsedSteps.length) active = parsedSteps.length - 1;
                planState = { title, steps: parsedSteps, active: Math.max(0, active), done, manual: true, interrupted: false };
              } else if (planState) {
                for (const index of passedDone) {
                  if (index < planState.steps.length) planState.done.add(index);
                }
                if (typeof input?.title === 'string' && input.title.trim()) planState.title = input.title.trim();
                if (Number.isInteger(input?.activeStep) && (input.activeStep as number) >= 0) {
                  planState.active = Math.min(planState.steps.length - 1, input.activeStep as number);
                }
                planState.manual = true;
                planState.interrupted = false;
              }
              if (planState) {
                planItem = { kind: 'plan', text: planState.title, title: planState.title, steps: planState.steps, doneSteps: [], activeStep: planState.active, interrupted: false };
                let lastPlanIndex = -1;
                for (let index = work.length - 1; index >= 0; index--) {
                  if (work[index]?.kind === 'plan') { lastPlanIndex = index; break; }
                }
                if (lastPlanIndex >= 0) work[lastPlanIndex] = planItem; else work.push(planItem);
                postPlan();
              }
              return;
            }
            const taskEntry: WorkItem = { kind: 'task', text: toolTask(toolCall.toolName, toolCall.input), done: false };
            activeTasks.set(toolCall.toolCallId, taskEntry);
            work.push(taskEntry);
            workStartedAt ||= Date.now();
            this.post({ type: 'tool', conversationId, phase: 'start', id: toolCall.toolCallId, name: taskEntry.text });
            this.post({ type: 'state', conversationId, running: true, label: humanToolName(toolCall.toolName) });
          },
          onToolExecutionEnd: ({ toolCall }) => {
            if (toolCall.toolName === 'plan') return;
            const taskEntry = activeTasks.get(toolCall.toolCallId);
            if (taskEntry) taskEntry.done = true;
            this.post({ type: 'tool', conversationId, phase: 'end', id: toolCall.toolCallId, name: toolTask(toolCall.toolName, toolCall.input) });
          },
        });

        for await (const part of result.stream) {
          if (part.type === 'text-delta') {
            answer += part.text;
            this.post({ type: 'delta', conversationId, text: part.text });
          } else if (part.type === 'reasoning-delta') {
            workStartedAt ||= Date.now();
            const remaining = MAX_PERSISTED_REASONING - reasoningBuffer.length;
            if (remaining > 0) reasoningBuffer += part.text.slice(0, remaining);
            if (reasoningBuffer.length >= MAX_PERSISTED_REASONING) reasoningTruncated = true;
            this.post({ type: 'reasoningDelta', conversationId, text: part.text });
          } else if (part.type === 'reasoning-end') {
            if (reasoningBuffer.trim()) work.push({ kind: 'reasoning', text: reasoningBuffer + (reasoningTruncated ? '\n…(truncated)' : '') });
            reasoningBuffer = '';
            reasoningTruncated = false;
            this.post({ type: 'reasoningEnd' });
          } else if (part.type === 'start-step') {
            workStartedAt ||= Date.now();
            const first = stepCount++ === 0;
            this.post({ type: 'workPhase', conversationId, first });
          } else if (part.type === 'finish-step') {
            const usage = part.usage;
            const input = usage?.inputTokens ?? 0;
            const output = usage?.outputTokens ?? 0;
            if (input || output) {
              liveInput += input;
              liveOutput += output;
              this.post({ type: 'liveUsage', conversationId, model, provider: providerConfig.id, inputTokens: liveInput, outputTokens: liveOutput });
            }
          } else if (part.type === 'error') {
            throw new Error(providerErrorMessage(part.error));
          } else if (part.type === 'finish') {
            finishReason = part.finishReason;
          }
        }
        const usage = await result.usage;
        if (usage?.inputTokens || usage?.outputTokens) {
          recordUsage(this.context, { model, provider: providerConfig.id, inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 });
        }
        if (finishReason === 'error') throw new Error('The model stopped because the provider reported a generation error.');
        if (finishReason === 'content-filter') throw new Error('The model stopped because the provider blocked the response.');
        if (!shouldAutoContinue(answer, finishReason, continuationCount)) break;
        continuationCount++;
        streamPrompt = `Continue the original coding request from exactly where you stopped. Do not mention this instruction, do not repeat prior text, and do not stop after describing the next action. Use tools to complete all remaining work, verify it, and only then give the concise final summary.\n\nOriginal request:\n${userText}\n\nWork shown so far:\n${answer.slice(-8_000)}`;
      } while (continuationCount < 2 && !run.controller.signal.aborted);
      this.sendUsage();
      this.maybePromptForStar();
      if (!answer.trim()) answer = '(No response)';
      if (reasoningBuffer.trim()) work.push({ kind: 'reasoning', text: reasoningBuffer + (reasoningTruncated ? '\n…(truncated)' : '') });
      const keptWork = work.slice(-80);
      const workSeconds = workStartedAt ? Math.max(1, Math.round((Date.now() - workStartedAt) / 1000)) : 0;
      const assistantItem = createTranscriptItem('assistant', answer, undefined, runGitTree, keptWork, workSeconds);
      conversation.items.push(assistantItem);
      conversation.items = conversation.items.slice(-60);
      conversation.updatedAt = Date.now();
      project.updatedAt = Date.now();
      await this.persistProjects();
      finalizePlan();
      this.post({ type: 'done', conversationId, item: assistantItem });
      systemNotify(this.context, { subtitle: 'Task complete', message: notificationSummary(answer) || conversation.title, kind: 'info' });
    } catch (error) {
      if (run.controller.signal.aborted) {
        if (planState) { planState.interrupted = true; postPlan(); }
        if (run.steering) {
          carriedGitTree = runGitTree;
          this.post({ type: 'steered', conversationId });
        } else this.post({ type: 'error', conversationId, text: 'Stopped.' });
      } else {
        this.post({ type: 'retryEnd', conversationId, ok: false, attempt: 5, max: 5 });
        const message = friendlyError(error, providerConfig);
        if (reasoningBuffer.trim()) work.push({ kind: 'reasoning', text: reasoningBuffer + (reasoningTruncated ? '\n…(truncated)' : '') });
        const errorItem = createTranscriptItem('assistant', message, 'error', runGitTree, work.slice(-80), workStartedAt ? Math.max(1, Math.round((Date.now() - workStartedAt) / 1000)) : 0);
        conversation.items.push(errorItem);
        conversation.items = conversation.items.slice(-60);
        conversation.updatedAt = Date.now();
        project.updatedAt = Date.now();
        await this.persistProjects();
        finalizePlan();
        this.post({ type: 'generationError', conversationId, item: errorItem });
        systemNotify(this.context, { subtitle: 'Task failed', message: notificationSummary(message) || conversation.title, kind: 'attention' });
      }
    } finally {
      await mcpConnection?.close();
      this.post({ type: 'liveUsage', conversationId, model: '', provider: '', inputTokens: 0, outputTokens: 0 });
      this.runs.delete(conversationId);
      this.post({ type: 'state', conversationId, running: false, label: '' });
      this.syncConversations(false);
      const own = this.queue.find(entry => entry.conversationId === conversationId);
      const next = own ?? this.queue[0];
      if (next && this.runs.size < MAX_CONCURRENT_RUNS) {
        this.queue = this.queue.filter(entry => entry !== next);
        this.postQueued(next.conversationId);
        void this.run(next.text, next.conversationId, undefined, carriedGitTree, next.context, next.promptContext);
      } else if (own) {
        this.postQueued(conversationId);
      }
    }
  }

  private async approve(kind: 'edit' | 'command', title: string, detail: string, destructive = false): Promise<void> {
    const mode = this.config().approvalMode;
    if (mode === 'autonomous') return;
    if (mode === 'edits' && !destructive) return;
    systemNotify(this.context, { subtitle: 'Approval needed', message: title, kind: 'attention' });
    const choice = await this.prompt(title, detail, { ok: 'Allow', cancel: 'Deny', danger: destructive });
    if (choice !== 'ok') throw new Error('User denied this action.');
  }

  private async reviewEdit(filePath: string, before: string, after: string, reason: string, destructive = false): Promise<void> {
    const mode = this.config().approvalMode;
    if (mode === 'autonomous' || (mode === 'edits' && !destructive)) return;
    const directory = await mkdtemp(path.join(tmpdir(), 'opencodex-review-'));
    const safeBase = (path.basename(filePath) || 'change.txt').replace(/[^a-zA-Z0-9._-]/g, '_');
    const beforePath = path.join(directory, `before-${safeBase}`);
    const afterPath = path.join(directory, `proposed-${safeBase}`);
    await Promise.all([writeFile(beforePath, before), writeFile(afterPath, after)]);
    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.file(beforePath),
        vscode.Uri.file(afterPath),
        `${filePath} — proposed Opencodex change`,
        { preview: true },
      );
      systemNotify(this.context, { subtitle: 'Edit review needed', message: filePath, kind: 'attention' });
      const choice = await this.prompt(
        destructive ? `Review deletion of ${filePath}` : `Review proposed edit to ${filePath}`,
        `${reason}\n\nThe proposed diff is open in the editor. Apply it?`,
        { ok: destructive ? 'Delete' : 'Apply', cancel: 'Reject', danger: destructive },
      );
      if (choice !== 'ok') throw new Error('User rejected the proposed edit.');
    } finally {
      setTimeout(() => { void rm(directory, { recursive: true, force: true }); }, 30_000);
    }
  }

  private async prompt(title: string, detail: string, options: { ok?: string; secondary?: string; cancel?: string; danger?: boolean } = {}): Promise<'ok' | 'secondary' | 'cancel'> {
    if (!this.view) return 'cancel';
    const id = ++this.notifySeq;
    return new Promise(resolve => {
      this.pendingNotifies.set(id, resolve);
      this.post({
        type: 'notify',
        id,
        title,
        detail,
        okLabel: options.ok ?? 'OK',
        secondaryLabel: options.secondary,
        cancelLabel: options.cancel ?? 'Cancel',
        danger: options.danger ?? false,
      });
    });
  }

  private disposePendingNotifies(): void {
    for (const resolve of this.pendingNotifies.values()) resolve('cancel');
    this.pendingNotifies.clear();
  }

  private workspaceRoot(): vscode.Uri | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  private resolveWorkspacePath(relativePath: string): vscode.Uri {
    const root = this.workspaceRoot();
    if (!root) throw new Error('No workspace is open.');
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
      throw new Error('Path must stay inside the workspace.');
    }
    const uri = vscode.Uri.joinPath(root, ...normalized.split('/'));
    const resolved = path.resolve(uri.fsPath);
    const rootPath = path.resolve(root.fsPath);
    if (resolved !== rootPath && !resolved.startsWith(rootPath + path.sep)) throw new Error('Path escapes the workspace.');
    return uri;
  }

  private config(): AppConfig {
    const config = vscode.workspace.getConfiguration('opencodex');
    const provider = getProvider(config.get<string>('provider', 'opencode'));
    return {
      model: config.get<string>('model', ''),
      provider: provider.id,
      apiKey: this.providerApiKey(provider),
      baseUrl: this.providerBaseUrl(provider),
      maxSteps: config.get<number>('maxSteps', 20),
      approvalMode: normalizeApprovalMode(this.context.globalState.get<string>('opencodex.approvalMode', config.get<string>('approvalMode', 'ask'))),
      searxngUrl: this.context.globalState.get<string>('opencodex.searxngUrl', config.get<string>('searxngUrl', '')),
      systemPrompt: this.context.globalState.get<string>('opencodex.systemPrompt', config.get<string>('systemPrompt', '')),
      mcpServers: this.context.globalState.get<string>('opencodex.mcpServers', config.get<string>('mcpServers', '{}')),
      extraFreeModels: (config.get<string>('extraFreeModels', '') ?? '').split(',').map(item => item.trim()).filter(Boolean),
      onlyDefaultModels: this.context.globalState.get<boolean>('opencodex.onlyDefaultModels', true),
    };
  }

  private providerConfigured(provider: Provider): boolean {
    if (provider.isLocal) return Boolean(this.context.globalState.get<string>(`opencodex.baseUrl.${provider.id}`));
    if (!provider.needsApiKey) return true;
    return Boolean(this.apiKeys[provider.id] || (provider.apiKeyEnvVar ? process.env[provider.apiKeyEnvVar] : ''));
  }

  private providerApiKey(provider: Provider): string {
    if (!(provider.acceptsApiKey ?? provider.needsApiKey)) return '';
    return this.apiKeys[provider.id] || (provider.apiKeyEnvVar ? process.env[provider.apiKeyEnvVar] ?? '' : '');
  }

  private providerBaseUrl(provider: Provider): string {
    return this.context.globalState.get<string>(`opencodex.baseUrl.${provider.id}`, provider.baseURL) || provider.baseURL;
  }

  private async refreshModels(): Promise<void> {
    const config = this.config();
    const defaultProvider = getProvider(config.provider);
    const targets = config.onlyDefaultModels
      ? [defaultProvider]
      : listProviders().filter(provider => this.providerConfigured(provider));
    const groups: ProviderModelGroup[] = [];
    await Promise.all(targets.map(async provider => {
      try {
        const models = await fetchProviderModels(provider, this.providerApiKey(provider), config.extraFreeModels, this.providerBaseUrl(provider));
        groups.push({ providerId: provider.id, providerName: provider.name, configured: this.providerConfigured(provider), models });
      } catch (error) {
        if (provider.isLocal) return;
        groups.push({ providerId: provider.id, providerName: provider.name, configured: this.providerConfigured(provider), models: [], error: friendlyError(error, provider) });
      }
    }));
    groups.sort((a, b) => (a.providerId === config.provider ? -1 : b.providerId === config.provider ? 1 : a.providerName.localeCompare(b.providerName)));
    const configured = config.model;
    const selected = configured && groups.some(group => group.models.includes(configured)) ? configured : '';
    if (configured && !selected) await vscode.workspace.getConfiguration('opencodex').update('model', '', vscode.ConfigurationTarget.Global);
    const anyModels = groups.some(group => group.models.length > 0);
    if (!anyModels) {
      const details = groups.map(group => group.error).filter(Boolean).join(' ');
      this.post({ type: 'modelsError', text: details || 'No free models found for any configured provider.' });
      return;
    }
    this.post({ type: 'models', groups, selected, defaultProvider: defaultProvider.id, onlyDefaultModels: config.onlyDefaultModels });
  }

  private sendEditorContext(): void {
    const root = this.workspaceRoot();
    const editor = vscode.window.activeTextEditor;
    const editorPath = editor?.document.uri.fsPath ?? '';
    const inside = Boolean(root && editor && pathInside(root.fsPath, editorPath));
    const selection = inside && editor && !editor.selection.isEmpty ? editor.selection : undefined;
    this.post({
      type: 'editorContext',
      activeFile: inside && root ? path.relative(root.fsPath, editorPath) : '',
      hasSelection: Boolean(selection),
      selectionLines: selection ? `${selection.start.line + 1}-${selection.end.line + 1}` : '',
    });
  }

  private async composerContextBlock(root: vscode.Uri, context?: ComposerContext): Promise<string> {
    const sections: string[] = [];
    const seen = new Set<string>();
    const editor = vscode.window.activeTextEditor;
    const editorPath = editor?.document.uri.fsPath ?? '';
    const editorInside = Boolean(editor && pathInside(root.fsPath, editorPath));
    const requestedFile = context?.activeFile?.replace(/\\/g, '/').replace(/^\.\//, '');
    const editorRelative = editorInside ? path.relative(root.fsPath, editorPath).replace(/\\/g, '/') : '';
    const editorMatchesRequest = Boolean(editor && editorInside && (!requestedFile || requestedFile === editorRelative));
    if (editor && editorMatchesRequest && context?.includeSelection !== false && !editor.selection.isEmpty) {
      const relative = path.relative(root.fsPath, editorPath);
      const selected = editor.document.getText(editor.selection).slice(0, 12_000);
      sections.push(`Selected code from ${relative}:${editor.selection.start.line + 1}-${editor.selection.end.line + 1}:\n\`\`\`\n${selected}\n\`\`\``);
    }
    if (context?.includeActiveFile !== false && (requestedFile || editorRelative)) {
      const relative = requestedFile || editorRelative;
      if (!isSecret(relative)) {
        const content = editor && editorMatchesRequest
          ? editor.document.getText()
          : new TextDecoder().decode(await vscode.workspace.fs.readFile(this.resolveWorkspacePath(relative)));
        sections.push(`Active file ${relative} (included via the active-file context control):\n\`\`\`\n${content.slice(0, 30_000)}\n\`\`\``);
        seen.add(relative);
      }
    }
    for (const attachment of (context?.attachments ?? []).slice(0, 16)) {
      const relative = attachment.path.replace(/\\/g, '/').replace(/^\.\//, '');
      if (!relative || seen.has(relative) || isSecret(relative)) continue;
      const uri = this.resolveWorkspacePath(relative);
      const stat = await vscode.workspace.fs.stat(uri);
      if (attachment.kind === 'folder' || (stat.type & vscode.FileType.Directory) !== 0) {
        sections.push(`Attached folder: ${relative}. Inspect only the relevant files inside it.`);
      } else if (stat.size <= MAX_FILE_BYTES) {
        const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)).slice(0, 30_000);
        sections.push(`Attached file ${relative}:\n\`\`\`\n${content}\n\`\`\``);
      } else {
        sections.push(`Attached file: ${relative} (${stat.size} bytes; use read/search tools selectively).`);
      }
      seen.add(relative);
    }
    return sections.length ? `\n\nEditor context explicitly included by the user:\n\n${sections.join('\n\n')}` : '';
  }

  private systemPrompt(root: vscode.Uri): string {
    const base = `You are Opencodex, an autonomous coding agent inside VS Code. Work carefully and persist until the request is complete.\n\nUser OS: ${userOsName()}\nWorkspace: ${root.fsPath}\nRules:\n- For non-trivial tasks, call the plan tool first to present the main design aspects; the plan is shown as a floating card at the top of the chat with the currently executing step highlighted and completed steps checked off.
  The plan tool is stateful: every call is merged with the current plan and its result always returns the complete current plan to you, so you always know its exact state and can update it accordingly. Steps NEVER advance automatically: after finishing a step, re-call the plan tool with activeStep (0-based index of the step you are now working on) and doneSteps (the indices of the steps you just finished). Previously completed steps stay checked automatically, so never re-send the whole list - pass steps and title again only when you are creating or explicitly rewriting the plan.\n- Inspect relevant files before editing.\n- Use workspace-relative paths only.\n- Never attempt to read or modify .env files, secrets, credentials, or files outside the workspace.\n- Make focused edits and preserve unrelated user changes.\n- Use replace_text for small edits, write_file for new files or complete rewrites, and delete_file instead of shell commands when removing files.\n- Run relevant checks when practical.\n- Use memory_read when durable project context may matter. Use memory_update only for stable decisions, conventions, or explicit user preferences; never store secrets or transient task state.\n- Use delegate_task for bounded research, review, or focused work that benefits from a separate context window.\n- Use persistent terminal tools for interactive or long-running processes and reuse existing named sessions.\n- Do not narrate plans, intentions, or tool progress in the visible answer; the interface already shows work status.\n- Do not claim success until verification finishes.\n- End with only a concise result summary and tests.`;
    const custom = this.config().systemPrompt.trim();
    return custom ? `${base}\n\n${custom}` : base;
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }
}

import * as vscode from 'vscode';
import * as path from 'node:path';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { ToolLoopAgent, isLoopFinished, isStepCount } from 'ai';
import { captureGitTree, isGitTrackedWorkspace, restoreGitTree } from './git';
import { fetchProviderModels, getProvider, listProviders, type Provider } from './providers';
import { buildTools } from './tools';
import type { AppConfig, Conversation, ProviderModelGroup, TranscriptItem, WebMessage, WorkItem } from './types';
import { MAX_PERSISTED_REASONING } from './types';
import { conversationTitle, createTranscriptItem, errorMessage, friendlyError, humanToolName, normalizeApprovalMode, normalizeTranscriptItem, providerErrorMessage, shouldAutoContinue, toolTask } from './util';
import { getWebviewHtml } from './webview';
import { aggregateUsage, loadUsage, recordUsage } from './usage';

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

type ActiveRun = {
  conversationId: string;
  controller: AbortController;
  steering: boolean;
};

export class AgentViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private conversations: Conversation[] = [];
  private activeConversationId = '';
  private runs = new Map<string, ActiveRun>();
  private queue: { text: string; conversationId: string }[] = [];
  private apiKeys: Record<string, string> = {};
  private persistChain: Promise<void> = Promise.resolve();

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = getWebviewHtml(view.webview, this.context.extensionUri, this.workspaceRoot()?.fsPath);
    view.webview.onDidReceiveMessage((message: WebMessage) => this.onMessage(message));
    this.loadConversations();
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
    } catch {}
  }

  async openSettings(): Promise<void> { return this.showSettings(); }

  openUsage(): void {
    this.view?.show?.(true);
    this.post({ type: 'showUsage' });
    this.sendUsage();
  }

  private sendUsage(): void {
    this.post({ type: 'usage', ...aggregateUsage(loadUsage(this.context)) });
  }

  private async showSettings(initialSetup = false): Promise<void> {
    const config = this.config();
    this.post({
      type: 'settings',
      maxSteps: config.maxSteps,
      approvalMode: config.approvalMode,
      searxngUrl: config.searxngUrl,
      systemPrompt: config.systemPrompt,
      extraFreeModels: config.extraFreeModels.join(', '),
      provider: config.provider,
      providers: listProviders().map(provider => ({ id: provider.id, name: provider.name, needsApiKey: provider.needsApiKey, acceptsApiKey: provider.acceptsApiKey ?? provider.needsApiKey, apiKeyEnvVar: provider.apiKeyEnvVar, apiKeyUrl: provider.apiKeyUrl, isLocal: Boolean(provider.isLocal), baseUrl: this.providerBaseUrl(provider) })),
      apiKeys: Object.fromEntries(listProviders().map(provider => [provider.id, Boolean(this.apiKeys[provider.id] || (provider.apiKeyEnvVar ? process.env[provider.apiKeyEnvVar] : ''))])),
      configured: Object.fromEntries(listProviders().map(provider => [provider.id, this.providerConfigured(provider)])),
      onlyDefaultModels: this.config().onlyDefaultModels,
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

  private loadConversations(): void {
    this.conversations = this.context.workspaceState.get<Conversation[]>('opencodex.conversations', []).map(conversation => {
      const baseTimestamp = Number.isFinite(conversation.createdAt) ? conversation.createdAt : Date.now();
      return { ...conversation, items: conversation.items.map((item, index) => normalizeTranscriptItem(item, baseTimestamp + index)) };
    });
    if (!this.conversations.length) {
      const legacy = this.context.workspaceState.get<TranscriptItem[]>('opencodex.transcript', []).map((item, index) => normalizeTranscriptItem(item, Date.now() + index));
      this.conversations = [this.createConversation(legacy)];
    }
    const saved = this.context.workspaceState.get<string>('opencodex.activeConversationId', '');
    this.activeConversationId = this.conversations.some(item => item.id === saved && !item.archived)
      ? saved : (this.conversations.find(item => !item.archived)?.id ?? this.conversations[0]!.id);
    void this.persistConversations();
  }

  private createConversation(items: TranscriptItem[] = []): Conversation {
    const now = Date.now();
    const first = items.find(item => item.role === 'user')?.text.trim();
    return { id: `${now}-${Math.random().toString(36).slice(2, 8)}`, title: first ? conversationTitle(first) : 'New conversation', items, archived: false, createdAt: now, updatedAt: now };
  }

  private activeConversation(): Conversation {
    let conversation = this.conversations.find(item => item.id === this.activeConversationId);
    if (!conversation) {
      conversation = this.createConversation();
      this.conversations.unshift(conversation);
      this.activeConversationId = conversation.id;
    }
    return conversation;
  }

  private newConversation(): void {
    const empty = this.conversations.find(item => !item.archived && item.items.length === 0);
    const conversation = empty ?? this.createConversation();
    if (!empty) this.conversations.unshift(conversation);
    this.activeConversationId = conversation.id;
    void this.persistConversations();
    this.syncConversations();
  }

  private persistConversations(): Promise<void> {
    const conversations = this.conversations.slice(0, 100);
    const activeId = this.activeConversationId;
    this.persistChain = this.persistChain.then(async () => {
      await this.context.workspaceState.update('opencodex.conversations', conversations);
      await this.context.workspaceState.update('opencodex.activeConversationId', activeId);
    });
    return this.persistChain;
  }

  private syncConversations(includeActive = true): void {
    this.post({ type: 'conversations', conversations: this.conversations.map(({ id, title, archived, updatedAt, items }) => ({
      id, title, archived, updatedAt,
      hasMessages: items.length > 0,
      running: this.runs.has(id),
      queued: this.queue.find(entry => entry.conversationId === id)?.text ?? null,
    })), activeId: this.activeConversationId });
    if (includeActive) {
      const active = this.activeConversation();
      this.post({ type: 'conversation', id: active.id, items: active.items });
    }
  }

  private async onMessage(message: WebMessage): Promise<void> {
    if (message.type === 'ready') {
      this.syncConversations();
      await this.loadApiKeys();
      this.post({ type: 'config', model: this.config().model, provider: this.config().provider, approvalMode: this.config().approvalMode });
      await this.refreshModels();
      await this.maybeShowFirstLaunchSettings();
      this.sendUsage();
      return;
    }
    if (message.type === 'stop') {
      this.runs.get(this.activeConversationId)?.controller.abort();
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
      if (this.conversations.some(item => item.id === message.id)) {
        this.activeConversationId = message.id;
        void this.persistConversations();
        this.syncConversations();
      }
      return;
    }
    if (message.type === 'archiveConversation') {
      const conversation = this.conversations.find(item => item.id === message.id);
      if (!conversation || this.runs.has(message.id)) return;
      this.queue = this.queue.filter(entry => entry.conversationId !== message.id);
      conversation.archived = !conversation.archived;
      conversation.updatedAt = Date.now();
      if (conversation.archived && this.activeConversationId === conversation.id) {
        const next = this.conversations.find(item => !item.archived && item.id !== conversation.id);
        if (next) this.activeConversationId = next.id;
        else {
          const fresh = this.createConversation();
          this.conversations.unshift(fresh);
          this.activeConversationId = fresh.id;
        }
      }
      await this.persistConversations();
      this.syncConversations();
      return;
    }
    if (message.type === 'deleteConversation') {
      const conversation = this.conversations.find(item => item.id === message.id);
      if (!conversation?.archived || this.runs.has(message.id)) return;
      this.queue = this.queue.filter(entry => entry.conversationId !== message.id);
      this.conversations = this.conversations.filter(item => item.id !== message.id);
      if (this.activeConversationId === message.id) {
        const next = this.conversations.find(item => !item.archived) ?? this.createConversation();
        if (!this.conversations.includes(next)) this.conversations.unshift(next);
        this.activeConversationId = next.id;
      }
      await this.persistConversations();
      this.syncConversations();
      return;
    }
    if (message.type === 'restoreCheckpoint') {
      if (this.runs.size) return;
      const root = this.workspaceRoot();
      if (!root || !isGitTrackedWorkspace(root.fsPath)) {
        void vscode.window.showInformationMessage('Restore is available only for Git-tracked projects.');
        return;
      }
      const conversation = this.conversations.find(item => item.id === message.conversationId);
      const targetIndex = conversation?.items.findIndex(item => item.id === message.itemId && item.role === 'assistant') ?? -1;
      if (!conversation || targetIndex < 0) return;
      const target = conversation.items[targetIndex];
      if (!target?.gitTree) {
        void vscode.window.showInformationMessage('This message does not have a Git restore point. Restore points are created for newer Opencodex responses.');
        return;
      }
      const removedMessageCount = conversation.items.length - targetIndex - 1;
      const detail = `This will restore Git-visible files to their state before this response${removedMessageCount ? ` and remove ${removedMessageCount} later message${removedMessageCount === 1 ? '' : 's'}` : ''}. The selected message will stay. Your staging area will not be changed.`;
      const choice = await vscode.window.showWarningMessage('Restore to before this response?', { modal: true, detail }, 'Restore');
      if (choice !== 'Restore') return;
      try {
        await restoreGitTree(root.fsPath, target.gitTree);
      } catch (error) {
        void vscode.window.showErrorMessage(`Git restore failed: ${errorMessage(error)}`);
        return;
      }
      conversation.items = conversation.items.slice(0, targetIndex + 1);
      conversation.updatedAt = Date.now();
      await this.persistConversations();
      this.activeConversationId = conversation.id;
      this.syncConversations();
      void vscode.window.showInformationMessage('Git workspace and conversation restored.');
      return;
    }
    if (message.type === 'setKey' || message.type === 'requestSettings') return this.showSettings();
    if (message.type === 'requestUsage') return this.openUsage();
    if (message.type === 'saveSettings') {
      try {
        const searxngUrl = message.searxngUrl.trim().replace(/\/$/, '');
        if (searxngUrl && !/^https?:\/\//i.test(searxngUrl)) throw new Error('SearXNG URL must start with http:// or https://.');
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
        await this.context.globalState.update('opencodex.onlyDefaultModels', Boolean(message.onlyDefaultModels));
        await this.context.globalState.update('opencodex.setupComplete', true);
        const provider = getProvider(providerId);
        if (provider.isLocal) {
          const baseUrl = (message.baseUrl ?? '').trim().replace(/\/$/, '');
          if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error('Server URL must start with http:// or https://.');
          await this.context.globalState.update(`opencodex.baseUrl.${providerId}`, baseUrl || undefined);
        }
        if (message.apiKey.trim()) {
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
      await this.context.globalState.update('opencodex.onlyDefaultModels', undefined);
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
    if (message.type === 'send' && message.text.trim()) {
      const conversationId = message.conversationId || this.activeConversationId;
      if (!this.conversations.some(conversation => conversation.id === conversationId)) return;
      if (this.runs.has(conversationId) || this.runs.size >= MAX_CONCURRENT_RUNS) {
        this.enqueue(message.text.trim(), conversationId);
      } else {
        void this.run(message.text.trim(), conversationId);
      }
      return;
    }
    if (message.type === 'retryMessage') {
      const conversation = this.conversations.find(item => item.id === message.conversationId);
      if (!conversation || this.runs.has(message.conversationId)) return;
      const last = conversation.items[conversation.items.length - 1];
      const resume = last?.kind === 'error'
        ? { work: last.work, errorText: last.text }
        : undefined;
      if (last?.kind === 'error') conversation.items.pop();
      this.activeConversationId = conversation.id;
      await this.persistConversations();
      this.syncConversations();
      await this.run('Continue', conversation.id, resume);
    }
  }

  private enqueue(text: string, conversationId: string): void {
    this.queue = this.queue.filter(entry => entry.conversationId !== conversationId);
    this.queue.push({ text, conversationId });
    this.postQueued(conversationId);
  }

  private postQueued(conversationId: string): void {
    const entry = this.queue.find(item => item.conversationId === conversationId);
    this.post({ type: 'queuedPrompt', conversationId, prompt: entry?.text ?? null });
  }

  private async run(userText: string, conversationId: string, resume?: { work?: WorkItem[]; errorText?: string }, carryTree?: string): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) {
      this.post({ type: 'error', text: 'Open a folder or workspace first.' });
      return;
    }

    let conversation = this.conversations.find(item => item.id === conversationId);
    if (!conversation) {
      conversation = this.createConversation();
      this.conversations.unshift(conversation);
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
    await this.persistConversations();
    this.syncConversations(false);
    this.post({ type: 'state', conversationId, running: true, label: 'Thinking' });

    const work: WorkItem[] = resume ? [...(resume.work ?? [])] : [];
    const activeTasks = new Map<string, WorkItem>();
    let reasoningBuffer = '';
    let reasoningTruncated = false;
    let workStartedAt = 0;
    let planItem: WorkItem | undefined;
    let planState: PlanState | undefined;
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

      const agent = new ToolLoopAgent({
        model: provider(model),
        maxRetries: 4,
        instructions: this.systemPrompt(root),
        tools: buildTools({
          root,
          config: () => this.config(),
          approve: (kind, title, detail, destructive) => this.approve(kind, title, detail, destructive),
          post: message => this.post(message),
          resolvePath: filePath => this.resolveWorkspacePath(filePath),
          describePlan,
          abortSignal: run.controller.signal,
        }),
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
          ? `Previous conversation:\n${recent}\n\nCurrent request:\n${userText}`
          : userText;
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
      if (!answer.trim()) answer = '(No response)';
      if (reasoningBuffer.trim()) work.push({ kind: 'reasoning', text: reasoningBuffer + (reasoningTruncated ? '\n…(truncated)' : '') });
      const keptWork = work.slice(-80);
      const workSeconds = workStartedAt ? Math.max(1, Math.round((Date.now() - workStartedAt) / 1000)) : 0;
      const assistantItem = createTranscriptItem('assistant', answer, undefined, runGitTree, keptWork, workSeconds);
      conversation.items.push(assistantItem);
      conversation.items = conversation.items.slice(-60);
      conversation.updatedAt = Date.now();
      await this.persistConversations();
      finalizePlan();
      this.post({ type: 'done', conversationId, item: assistantItem });
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
        await this.persistConversations();
        finalizePlan();
        this.post({ type: 'generationError', conversationId, item: errorItem });
      }
    } finally {
      // Stopped/interrupted responses are not counted, so drop their partial live tokens.
      this.post({ type: 'liveUsage', conversationId, model: '', provider: '', inputTokens: 0, outputTokens: 0 });
      this.runs.delete(conversationId);
      this.post({ type: 'state', conversationId, running: false, label: '' });
      this.syncConversations(false);
      const own = this.queue.find(entry => entry.conversationId === conversationId);
      const next = own ?? this.queue[0];
      if (next && this.runs.size < MAX_CONCURRENT_RUNS) {
        this.queue = this.queue.filter(entry => entry !== next);
        this.postQueued(next.conversationId);
        void this.run(next.text, next.conversationId, undefined, carriedGitTree);
      } else if (own) {
        this.postQueued(conversationId);
      }
    }
  }

  private async approve(kind: 'edit' | 'command', title: string, detail: string, destructive = false): Promise<void> {
    const mode = this.config().approvalMode;
    if (mode === 'autonomous') return;
    if (mode === 'edits' && (kind === 'edit' || !destructive)) return;
    const choice = await vscode.window.showWarningMessage(title, { modal: true, detail }, 'Allow');
    if (choice !== 'Allow') throw new Error('User denied this action.');
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
      apiKey: this.apiKeys[provider.id] || (provider.apiKeyEnvVar ? process.env[provider.apiKeyEnvVar] ?? '' : ''),
      baseUrl: this.providerBaseUrl(provider),
      maxSteps: config.get<number>('maxSteps', 20),
      approvalMode: normalizeApprovalMode(this.context.globalState.get<string>('opencodex.approvalMode', config.get<string>('approvalMode', 'ask'))),
      searxngUrl: this.context.globalState.get<string>('opencodex.searxngUrl', config.get<string>('searxngUrl', '')),
      systemPrompt: this.context.globalState.get<string>('opencodex.systemPrompt', config.get<string>('systemPrompt', '')),
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

  private systemPrompt(root: vscode.Uri): string {
    const editor = vscode.window.activeTextEditor;
    const active = editor && editor.document.uri.fsPath.startsWith(root.fsPath)
      ? path.relative(root.fsPath, editor.document.uri.fsPath)
      : '(none)';
    const selection = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection).slice(0, 6000) : '';
    const base = `You are Opencodex, an autonomous coding agent inside VS Code. Work carefully and persist until the request is complete.\n\nUser OS: ${userOsName()}\nWorkspace: ${root.fsPath}\nActive file: ${active}\n${selection ? `Selected text:\n${selection}\n` : ''}\nRules:\n- For non-trivial tasks, call the plan tool first to present the main design aspects; the plan is shown as a floating card at the top of the chat with the currently executing step highlighted and completed steps checked off.
The plan tool is stateful: every call is merged with the current plan and its result always returns the complete current plan to you, so you always know its exact state and can update it accordingly. Steps NEVER advance automatically: after finishing a step, re-call the plan tool with activeStep (0-based index of the step you are now working on) and doneSteps (the indices of the steps you just finished). Previously completed steps stay checked automatically, so never re-send the whole list - pass steps and title again only when you are creating or explicitly rewriting the plan.\n- Inspect relevant files before editing.\n- Use workspace-relative paths only.\n- Never attempt to read or modify .env files, secrets, credentials, or files outside the workspace.\n- Make focused edits and preserve unrelated user changes.\n- Use replace_text for small edits, write_file for new files or complete rewrites, and delete_file instead of shell commands when removing files.\n- Run relevant checks when practical.\n- Do not narrate plans, intentions, or tool progress in the visible answer; the interface already shows work status.\n- Do not claim success until verification finishes.\n- End with only a concise result summary and tests.`;
    const custom = this.config().systemPrompt.trim();
    return custom ? `${base}\n\n${custom}` : base;
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }
}

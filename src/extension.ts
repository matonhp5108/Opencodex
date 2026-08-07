import * as vscode from 'vscode';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { ToolLoopAgent, isStepCount, tool } from 'ai';
import { z } from 'zod';

type WebMessage =
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'newConversation' }
  | { type: 'openConversation'; id: string }
  | { type: 'archiveConversation'; id: string }
  | { type: 'deleteConversation'; id: string }
  | { type: 'restoreCheckpoint'; conversationId: string; itemId: string }
  | { type: 'copyText'; text: string }
  | { type: 'queuePrompt'; text: string; conversationId: string }
  | { type: 'steerQueued' }
  | { type: 'removeQueued' }
  | { type: 'setKey' }
  | { type: 'selectModel'; model: string }
  | { type: 'requestSettings' }
  | { type: 'saveSettings'; maxSteps: number; approvalMode: string; searxngUrl: string; initialSetup?: boolean }
  | { type: 'testSettings' }
  | { type: 'resetSettings' }
  | { type: 'openFile'; path: string };

type TranscriptItem = { id: string; role: 'user' | 'assistant'; text: string; timestamp: number; kind?: 'error'; gitTree?: string };
type Conversation = { id: string; title: string; items: TranscriptItem[]; archived: boolean; createdAt: number; updatedAt: number };

const OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1';
const MAX_FILE_BYTES = 250_000;
const MAX_TOOL_OUTPUT = 40_000;

export function activate(context: vscode.ExtensionContext) {
  const provider = new AgentViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('opencodex.chat', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('opencodex.focus', () =>
      vscode.commands.executeCommand('opencodex.chat.focus')),
    vscode.commands.registerCommand('opencodex.settings', () => provider.openSettings()),
    vscode.commands.registerCommand('opencodex.clear', () => provider.clear()),
  );
}

export function deactivate() {}

class AgentViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private abortController?: AbortController;
  private conversations: Conversation[] = [];
  private activeConversationId = '';
  private runningConversationId = '';
  private running = false;
  private queuedPrompt?: { text: string; conversationId: string };
  private steering = false;
  private runGitTree?: string;
  private carriedGitTree?: string;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((message: WebMessage) => this.onMessage(message));
    this.loadConversations();
    this.syncConversations();
    this.post({ type: 'queuedPrompt', prompt: this.queuedPrompt ?? null });
    this.post({ type: 'config', model: this.config().model });
    void this.refreshModels();
    void this.maybeShowFirstLaunchSettings();
  }

  async openSettings(): Promise<void> { return this.showSettings(); }

  private async showSettings(initialSetup = false): Promise<void> {
    const config = this.config();
    this.post({
      type: 'settings',
      maxSteps: config.maxSteps,
      approvalMode: config.approvalMode,
      searxngUrl: config.searxngUrl,
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

  private async persistConversations(): Promise<void> {
    await this.context.workspaceState.update('opencodex.conversations', this.conversations.slice(0, 100));
    await this.context.workspaceState.update('opencodex.activeConversationId', this.activeConversationId);
  }

  private syncConversations(includeActive = true): void {
    this.post({ type: 'conversations', conversations: this.conversations.map(({ id, title, archived, updatedAt }) => ({ id, title, archived, updatedAt, running: id === this.runningConversationId })), activeId: this.activeConversationId });
    if (includeActive) {
      const active = this.activeConversation();
      this.post({ type: 'conversation', id: active.id, items: active.items });
    }
  }

  private async onMessage(message: WebMessage): Promise<void> {
    if (message.type === 'stop') {
      this.abortController?.abort();
      return;
    }
    if (message.type === 'copyText') {
      await vscode.env.clipboard.writeText(message.text);
      this.post({ type: 'copied' });
      return;
    }
    if (message.type === 'queuePrompt') {
      if (!this.running || this.queuedPrompt || message.conversationId !== this.runningConversationId || !message.text.trim()) return;
      this.queuedPrompt = { text: message.text.trim(), conversationId: message.conversationId };
      this.post({ type: 'queuedPrompt', prompt: this.queuedPrompt });
      return;
    }
    if (message.type === 'removeQueued') {
      this.queuedPrompt = undefined;
      this.post({ type: 'queuedPrompt', prompt: null });
      return;
    }
    if (message.type === 'steerQueued') {
      if (!this.queuedPrompt || !this.running) return;
      this.steering = true;
      this.abortController?.abort();
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
      if (!conversation || message.id === this.runningConversationId) return;
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
      if (!conversation?.archived || message.id === this.runningConversationId) return;
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
      if (this.running) return;
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
    if (message.type === 'saveSettings') {
      try {
        const searxngUrl = message.searxngUrl.trim().replace(/\/$/, '');
        if (searxngUrl && !/^https?:\/\//i.test(searxngUrl)) throw new Error('SearXNG URL must start with http:// or https://.');
        const maxSteps = Math.max(1, Math.min(50, Math.round(Number(message.maxSteps) || 20)));
        const config = vscode.workspace.getConfiguration('opencodex');
        await config.update('maxSteps', maxSteps, vscode.ConfigurationTarget.Global);
        await this.context.globalState.update('opencodex.approvalMode', normalizeApprovalMode(message.approvalMode));
        await this.context.globalState.update('opencodex.searxngUrl', searxngUrl);
        await this.context.globalState.update('opencodex.setupComplete', true);
        this.post({ type: 'settingsResult', ok: true, text: 'Settings saved.' });
        await this.refreshModels();
      } catch (error) {
        this.post({ type: 'settingsResult', ok: false, text: errorMessage(error) });
      }
      return;
    }
    if (message.type === 'testSettings') {
      try {
        const models = await this.fetchModels();
        this.post({ type: 'settingsResult', ok: true, text: `Connected · ${models.length} free models found.` });
      } catch (error) {
        this.post({ type: 'settingsResult', ok: false, text: friendlyError(error) });
      }
      return;
    }
    if (message.type === 'resetSettings') {
      const config = vscode.workspace.getConfiguration('opencodex');
      await config.update('maxSteps', 20, vscode.ConfigurationTarget.Global);
      await this.context.globalState.update('opencodex.approvalMode', 'ask');
      await this.context.globalState.update('opencodex.searxngUrl', '');
      await this.showSettings();
      return;
    }
    if (message.type === 'selectModel') {
      await vscode.workspace.getConfiguration('opencodex').update('model', message.model, vscode.ConfigurationTarget.Global);
      this.post({ type: 'config', model: message.model });
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
      if (this.running) return;
      await this.run(message.text.trim());
    }
  }

  private async run(userText: string): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) {
      this.post({ type: 'error', text: 'Open a folder or workspace first.' });
      return;
    }

    const conversation = this.activeConversation();
    const conversationId = conversation.id;
    const gitTracked = isGitTrackedWorkspace(root.fsPath);
    this.running = true;
    this.steering = false;
    this.runningConversationId = conversationId;
    this.runGitTree = gitTracked ? this.carriedGitTree : undefined;
    this.carriedGitTree = undefined;
    this.abortController = new AbortController();
    const userItem = createTranscriptItem('user', userText);
    conversation.items.push(userItem);
    if (conversation.items.length === 1) conversation.title = conversationTitle(userText);
    conversation.updatedAt = Date.now();
    await this.persistConversations();
    this.syncConversations(false);
    this.post({ type: 'user', conversationId, item: userItem });
    this.post({ type: 'state', conversationId, running: true, label: 'Thinking' });

    try {
      if (gitTracked) this.runGitTree ??= await captureGitTree(root.fsPath);
      const { model, maxSteps } = this.config();
      if (!model) {
        await this.refreshModels();
        this.post({ type: 'error', text: 'Choose a model from the selector below the message box.' });
        return;
      }
      let reconnectAttempt = 0;
      const provider = createOpenAICompatible({
        name: 'opencode',
        baseURL: OPENCODE_BASE_URL,
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
            if (!this.abortController?.signal.aborted) {
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
        tools: this.makeTools(root),
        stopWhen: isStepCount(maxSteps),
      });

      const recent = conversation.items.slice(-10, -1)
        .map(item => `${item.role.toUpperCase()}: ${item.text}`)
        .join('\n\n');
      let streamPrompt = recent
        ? `Previous conversation:\n${recent}\n\nCurrent request:\n${userText}`
        : userText;
      let answer = '';
      let finishReason = '';
      let stepCount = 0;
      let continuationCount = 0;
      do {
        finishReason = '';
        const result = await agent.stream({
          prompt: streamPrompt,
          abortSignal: this.abortController.signal,
          onToolExecutionStart: ({ toolCall }) => {
            this.post({ type: 'tool', conversationId, phase: 'start', id: toolCall.toolCallId, name: toolTask(toolCall.toolName, toolCall.input) });
            this.post({ type: 'state', conversationId, running: true, label: humanToolName(toolCall.toolName) });
          },
          onToolExecutionEnd: ({ toolCall }) => {
            this.post({ type: 'tool', conversationId, phase: 'end', id: toolCall.toolCallId, name: toolTask(toolCall.toolName, toolCall.input) });
          },
        });

        for await (const part of result.stream) {
          if (part.type === 'text-delta') {
            answer += part.text;
            this.post({ type: 'delta', conversationId, text: part.text });
          } else if (part.type === 'reasoning-delta') {
            this.post({ type: 'reasoningDelta', conversationId, text: part.text });
          } else if (part.type === 'reasoning-end') {
            this.post({ type: 'reasoningEnd' });
          } else if (part.type === 'start-step') {
            this.post({ type: 'workPhase', conversationId, first: stepCount++ === 0 });
          } else if (part.type === 'error') {
            throw new Error(providerErrorMessage(part.error));
          } else if (part.type === 'finish') {
            finishReason = part.finishReason;
          }
        }
        if (finishReason === 'error') throw new Error('The model stopped because the provider reported a generation error.');
        if (finishReason === 'content-filter') throw new Error('The model stopped because the provider blocked the response.');
        if (!shouldAutoContinue(answer, finishReason, continuationCount)) break;
        continuationCount++;
        streamPrompt = `Continue the original coding request from exactly where you stopped. Do not mention this instruction, do not repeat prior text, and do not stop after describing the next action. Use tools to complete all remaining work, verify it, and only then give the concise final summary.\n\nOriginal request:\n${userText}\n\nWork shown so far:\n${answer.slice(-8_000)}`;
      } while (continuationCount < 2 && !this.abortController.signal.aborted);
      if (!answer.trim()) answer = '(No response)';
      const assistantItem = createTranscriptItem('assistant', answer, undefined, this.runGitTree);
      conversation.items.push(assistantItem);
      conversation.items = conversation.items.slice(-60);
      conversation.updatedAt = Date.now();
      await this.persistConversations();
      this.post({ type: 'done', conversationId, item: assistantItem });
    } catch (error) {
      if (this.abortController.signal.aborted) {
        if (this.steering) {
          this.carriedGitTree = this.runGitTree;
          this.post({ type: 'steered', conversationId });
        } else this.post({ type: 'error', conversationId, text: 'Stopped.' });
      } else {
        this.post({ type: 'retryEnd', conversationId, ok: false, attempt: 5, max: 5 });
        const message = friendlyError(error);
        const errorItem = createTranscriptItem('assistant', message, 'error', this.runGitTree);
        conversation.items.push(errorItem);
        conversation.items = conversation.items.slice(-60);
        conversation.updatedAt = Date.now();
        await this.persistConversations();
        this.post({ type: 'generationError', conversationId, item: errorItem });
      }
    } finally {
      const next = this.queuedPrompt;
      this.running = false;
      this.runningConversationId = '';
      this.abortController = undefined;
      this.post({ type: 'state', conversationId, running: false, label: '' });
      this.syncConversations(false);
      if (next) {
        this.queuedPrompt = undefined;
        this.post({ type: 'queuedPrompt', prompt: null });
        this.activeConversationId = next.conversationId;
        void this.persistConversations();
        this.syncConversations();
        void this.run(next.text);
      }
    }
  }

  private makeTools(root: vscode.Uri) {
    const tools: Record<string, any> = {
      list_files: tool({
        description: 'List workspace files matching a glob. Excludes dependencies and Git metadata.',
        inputSchema: z.object({ glob: z.string().default('**/*'), limit: z.number().int().min(1).max(500).default(200) }),
        execute: async ({ glob, limit }) => {
          const files = await vscode.workspace.findFiles(glob, '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**}', limit);
          return files.map(uri => path.relative(root.fsPath, uri.fsPath)).join('\n') || '(no files)';
        },
      }),
      read_file: tool({
        description: 'Read a UTF-8 text file from the workspace. Secret env files are blocked.',
        inputSchema: z.object({ path: z.string() }),
        execute: async ({ path: filePath }) => {
          assertNotSecret(filePath);
          const uri = this.resolveWorkspacePath(filePath);
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.size > MAX_FILE_BYTES) throw new Error(`File is too large (${stat.size} bytes).`);
          return truncate(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
        },
      }),
      search_files: tool({
        description: 'Search text across workspace files using a plain text query.',
        inputSchema: z.object({ query: z.string().min(1), glob: z.string().default('**/*'), limit: z.number().int().min(1).max(200).default(80) }),
        execute: async ({ query, glob, limit }) => {
          const files = await vscode.workspace.findFiles(glob, '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**}', 500);
          const hits: string[] = [];
          for (const uri of files) {
            if (hits.length >= limit) break;
            if (isSecret(path.relative(root.fsPath, uri.fsPath))) continue;
            try {
              const stat = await vscode.workspace.fs.stat(uri);
              if (stat.size > MAX_FILE_BYTES) continue;
              const lines = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)).split(/\r?\n/);
              lines.forEach((line, index) => {
                if (hits.length < limit && line.toLowerCase().includes(query.toLowerCase())) {
                  hits.push(`${path.relative(root.fsPath, uri.fsPath)}:${index + 1}: ${line.trim().slice(0, 300)}`);
                }
              });
            } catch {}
          }
          return hits.join('\n') || '(no matches)';
        },
      }),
      write_file: tool({
        description: 'Create or completely replace a workspace text file. Requires user approval.',
        inputSchema: z.object({ path: z.string(), content: z.string(), reason: z.string().optional() }),
        execute: async ({ path: filePath, content, reason }) => {
          assertNotSecret(filePath);
          const uri = this.resolveWorkspacePath(filePath);
          await this.approve('edit', `Write ${filePath}?`, reason ?? 'The agent wants to create or replace this file.');
          const edit = new vscode.WorkspaceEdit();
          let exists = true;
          try { await vscode.workspace.fs.stat(uri); } catch { exists = false; }
          if (exists) {
            const document = await vscode.workspace.openTextDocument(uri);
            const end = document.positionAt(document.getText().length);
            edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), content);
          } else {
            await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
            edit.createFile(uri, { ignoreIfExists: false });
            edit.insert(uri, new vscode.Position(0, 0), content);
          }
          if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected the edit.');
          await vscode.workspace.saveAll(false);
          this.post({ type: 'changed', path: filePath });
          return `Wrote ${filePath} (${content.length} characters).`;
        },
      }),
      replace_text: tool({
        description: 'Replace one exact text occurrence in a workspace file. Requires user approval.',
        inputSchema: z.object({ path: z.string(), oldText: z.string().min(1), newText: z.string(), reason: z.string().optional() }),
        execute: async ({ path: filePath, oldText, newText, reason }) => {
          assertNotSecret(filePath);
          const uri = this.resolveWorkspacePath(filePath);
          const document = await vscode.workspace.openTextDocument(uri);
          const source = document.getText();
          const first = source.indexOf(oldText);
          if (first < 0) throw new Error('Exact oldText was not found. Read the file again.');
          if (source.indexOf(oldText, first + oldText.length) >= 0) throw new Error('oldText occurs more than once; provide a larger unique block.');
          await this.approve('edit', `Edit ${filePath}?`, reason ?? 'The agent wants to replace one block of text.');
          const edit = new vscode.WorkspaceEdit();
          edit.replace(uri, new vscode.Range(document.positionAt(first), document.positionAt(first + oldText.length)), newText);
          if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected the edit.');
          await document.save();
          this.post({ type: 'changed', path: filePath });
          return `Updated ${filePath}.`;
        },
      }),
      delete_file: tool({
        description: 'Delete one workspace file. Requires user approval.',
        inputSchema: z.object({ path: z.string(), reason: z.string().optional() }),
        execute: async ({ path: filePath, reason }) => {
          assertNotSecret(filePath);
          const uri = this.resolveWorkspacePath(filePath);
          const stat = await vscode.workspace.fs.stat(uri);
          if ((stat.type & vscode.FileType.Directory) !== 0) throw new Error('delete_file only deletes individual files.');
          await this.approve('edit', `Delete ${filePath}?`, reason ?? 'The agent wants to delete this file.');
          await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
          this.post({ type: 'changed', path: filePath, action: 'Deleted' });
          return `Deleted ${filePath}.`;
        },
      }),
      get_diagnostics: tool({
        description: 'Return current VS Code errors and warnings for the workspace.',
        inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(100) }),
        execute: async ({ limit }) => {
          const rows: string[] = [];
          for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
            if (!uri.fsPath.startsWith(root.fsPath)) continue;
            for (const diagnostic of diagnostics) {
              if (rows.length >= limit) break;
              if (diagnostic.severity > vscode.DiagnosticSeverity.Warning) continue;
              rows.push(`${path.relative(root.fsPath, uri.fsPath)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${diagnostic.severity === 0 ? 'error' : 'warning'}: ${diagnostic.message}`);
            }
          }
          return rows.join('\n') || '(no errors or warnings)';
        },
      }),
      run_command: tool({
        description: 'Run a shell command in the workspace and return output. Always requires user approval.',
        inputSchema: z.object({ command: z.string().min(1), reason: z.string().optional(), timeoutSeconds: z.number().min(1).max(120).default(30) }),
        execute: async ({ command, reason, timeoutSeconds }) => {
          await this.approve('command', 'Run command?', `${command}\n\n${reason ?? ''}`);
          this.post({ type: 'command', command });
          return runCommand(command, root.fsPath, timeoutSeconds * 1000, this.abortController?.signal);
        },
      }),
    };
    const endpoint = this.config().searxngUrl;
    if (endpoint) {
      tools.web_search = tool({
        description: 'Search the web through the user-configured SearXNG instance and return result titles, URLs, and snippets.',
        inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(10).default(5) }),
        execute: async ({ query, limit }) => {
          const url = `${endpoint.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;
          const response = await fetch(url, { signal: this.abortController?.signal, headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}. Make sure JSON output is enabled.`);
          const payload = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
          return (payload.results ?? []).slice(0, limit).map((result, index) => `${index + 1}. ${result.title ?? 'Untitled'}\n${result.url ?? ''}\n${result.content ?? ''}`).join('\n\n') || '(no results)';
        },
      });
    }
    return tools;
  }

  private async approve(kind: 'edit' | 'command', title: string, detail: string): Promise<void> {
    const mode = this.config().approvalMode;
    if (mode === 'autonomous' || (mode === 'edits' && kind === 'edit')) return;
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

  private config() {
    const config = vscode.workspace.getConfiguration('opencodex');
    return {
      model: config.get<string>('model', ''),
      maxSteps: config.get<number>('maxSteps', 20),
      approvalMode: normalizeApprovalMode(this.context.globalState.get<string>('opencodex.approvalMode', config.get<string>('approvalMode', 'ask'))),
      searxngUrl: this.context.globalState.get<string>('opencodex.searxngUrl', config.get<string>('searxngUrl', '')),
    };
  }

  private async fetchModels(): Promise<string[]> {
    const response = await fetch(`${OPENCODE_BASE_URL}/models`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`OpenCode returned ${response.status}.`);
    const body = await response.json() as { data?: Array<{ id?: string }> };
    return [...new Set((body.data ?? [])
      .map(item => item.id)
      .filter((id): id is string => typeof id === 'string' && (id.endsWith('-free') || id === 'big-pickle')))]
      .sort();
  }

  private async refreshModels(): Promise<void> {
    try {
      const models = await this.fetchModels();
      const configured = this.config().model;
      const selected = configured && models.includes(configured) ? configured : '';
      if (configured && !selected) await vscode.workspace.getConfiguration('opencodex').update('model', '', vscode.ConfigurationTarget.Global);
      this.post({ type: 'models', models, selected });
    } catch (error) {
      this.post({ type: 'modelsError', text: friendlyError(error) });
    }
  }

  private systemPrompt(root: vscode.Uri): string {
    const editor = vscode.window.activeTextEditor;
    const active = editor && editor.document.uri.fsPath.startsWith(root.fsPath)
      ? path.relative(root.fsPath, editor.document.uri.fsPath)
      : '(none)';
    const selection = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection).slice(0, 6000) : '';
    return `You are Opencodex, an autonomous coding agent inside VS Code. Work carefully and persist until the request is complete.\n\nWorkspace: ${root.fsPath}\nActive file: ${active}\n${selection ? `Selected text:\n${selection}\n` : ''}\nRules:\n- Inspect relevant files before editing.\n- Use workspace-relative paths only.\n- Never attempt to read or modify .env files, secrets, credentials, or files outside the workspace.\n- Make focused edits and preserve unrelated user changes.\n- Use replace_text for small edits, write_file for new files or complete rewrites, and delete_file instead of shell commands when removing files.\n- Run relevant checks when practical.\n- Do not narrate plans, intentions, or tool progress in the visible answer; the interface already shows work status.\n- Do not claim success until verification finishes.\n- End with only a concise result summary and tests.`;
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2);
    const markUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'opencodex-mark.svg'));
    const gitTracked = isGitTrackedWorkspace(this.workspaceRoot()?.fsPath);
    return String.raw`<!doctype html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  *{box-sizing:border-box}body{padding:0;margin:0;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font:13px var(--vscode-font-family);height:100vh}.app{position:relative;height:100vh;display:flex;flex-direction:column}
  .top{position:relative;display:flex;align-items:center;gap:6px;padding:8px 9px;border-bottom:1px solid var(--vscode-widget-border)}button{font:inherit}.icon{display:grid;place-items:center;border:0;background:transparent;color:var(--vscode-foreground);cursor:pointer;width:30px;height:30px;padding:0;border-radius:6px}.icon:hover{background:var(--vscode-toolbar-hoverBackground)}.icon svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.settings-icon{width:34px;height:34px}.settings-icon svg{width:21px;height:21px}.conversation-button{min-width:0;flex:1;display:flex;align-items:center;gap:7px;border:0;background:transparent;color:var(--vscode-foreground);padding:6px 7px;border-radius:6px;cursor:pointer}.conversation-button:hover{background:var(--vscode-toolbar-hoverBackground)}.conversation-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}.conversation-menu{display:none;position:absolute;z-index:10;left:8px;right:8px;top:45px;max-height:360px;overflow:auto;padding:6px;background:var(--vscode-menu-background);border:1px solid var(--vscode-menu-border,var(--vscode-widget-border));border-radius:9px;box-shadow:0 10px 28px rgba(0,0,0,.35)}.conversation-menu.open{display:block}.menu-label{padding:7px 8px 4px;color:var(--vscode-descriptionForeground);font-size:10px;text-transform:uppercase}.conversation-row{display:flex;align-items:center;gap:7px;padding:7px 8px;border-radius:6px;cursor:pointer}.conversation-row:hover,.conversation-row.active{background:var(--vscode-list-hoverBackground)}.conversation-row .title{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.archive-action{display:grid;place-items:center;flex:none;width:22px;height:22px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--vscode-foreground);opacity:.65;cursor:pointer}.archive-action:hover{opacity:1;background:var(--vscode-toolbar-hoverBackground)}.delete-action:hover{color:var(--vscode-errorForeground)}.spinner{width:12px;height:12px;flex:none;border:1.5px solid color-mix(in srgb,currentColor 25%,transparent);border-top-color:currentColor;border-radius:50%;animation:spin .75s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}
  #messages{flex:1;overflow:auto;padding:14px 13px 24px;scroll-behavior:smooth}.empty{height:100%;display:grid;place-items:center;text-align:center}.empty-inner{display:flex;flex-direction:column;align-items:center;gap:14px}.empty-mark{width:62px;height:62px;display:block}.empty h2{color:var(--vscode-foreground);font-size:17px;font-weight:550;margin:0}
  .turn{margin:0 0 22px}.user-row{display:flex;justify-content:flex-end;margin-bottom:13px}.user-message{max-width:88%;display:flex;flex-direction:column;align-items:flex-end}.user-text{white-space:pre-wrap;line-height:1.48;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid color-mix(in srgb,var(--vscode-widget-border) 75%,transparent);border-radius:14px 14px 4px 14px;padding:8px 11px}.assistant{line-height:1.58;overflow-wrap:anywhere;margin-top:3px}.assistant:empty{display:none}.assistant.streaming{animation:answerIn .22s ease-out}.assistant.streaming:after{content:'';display:inline-block;width:5px;height:14px;margin-left:2px;vertical-align:-2px;border-radius:2px;background:var(--vscode-foreground);animation:cursorPulse .8s ease-in-out infinite}@keyframes answerIn{from{opacity:.35;transform:translateY(3px)}to{opacity:1;transform:none}}@keyframes cursorPulse{50%{opacity:.2}}
  .message-footer{display:flex;align-items:center;gap:5px;min-height:22px;margin-top:4px;color:var(--vscode-descriptionForeground);font-size:10px}.assistant-footer{justify-content:flex-start}.message-action{display:grid;place-items:center;width:22px;height:22px;border:0;border-radius:5px;background:transparent;color:var(--vscode-descriptionForeground);padding:0;cursor:pointer}.message-action:hover{color:var(--vscode-foreground);background:var(--vscode-toolbar-hoverBackground)}.message-action svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
  .assistant p{margin:0 0 9px}.assistant h1,.assistant h2,.assistant h3{font-size:14px;margin:14px 0 7px}.assistant ul{margin:5px 0 10px;padding-left:20px}.assistant li{margin:3px 0}.assistant pre{overflow:auto;background:var(--vscode-textCodeBlock-background);border:1px solid var(--vscode-widget-border);border-radius:7px;padding:9px;margin:8px 0}.assistant code{font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background);padding:1px 3px;border-radius:3px}.assistant pre code{padding:0;background:transparent}.assistant a{color:var(--vscode-textLink-foreground)}
  .activity{margin:2px 0 3px;background:transparent}.activity summary{position:relative;list-style:none;cursor:default;padding:4px 0;color:var(--vscode-descriptionForeground);font-size:12px;line-height:1.45;user-select:none}.activity summary::-webkit-details-marker{display:none}.activity summary:before{display:none;content:'›';width:14px;margin-right:3px;transition:transform .15s}.activity.has-content summary{cursor:pointer}.activity.has-content summary:before{display:inline-block}.activity.has-content[open] summary:before{transform:rotate(90deg)}.activity:not(.has-content) summary{pointer-events:none}.activity:not(.has-content) .activity-body{display:none}
  .activity.loading summary{color:transparent;background:linear-gradient(100deg,var(--vscode-descriptionForeground) 20%,var(--vscode-foreground) 43%,var(--vscode-descriptionForeground) 67%);background-size:220% 100%;background-clip:text;-webkit-background-clip:text;animation:shine 1.45s linear infinite}@keyframes shine{to{background-position:-220% 0}}
  .activity-body{padding:2px 0 5px 17px;color:var(--vscode-descriptionForeground);font-size:12px;line-height:1.5;max-height:230px;overflow:auto}.reasoning{margin-bottom:4px}.reasoning:empty{display:none}.activity-body p{margin:0 0 7px}.activity-body h1,.activity-body h2,.activity-body h3{margin:9px 0 5px;color:var(--vscode-foreground);font-size:12px}.activity-body ul,.activity-body ol{margin:4px 0 8px;padding-left:19px}.activity-body li{margin:2px 0}.activity-body blockquote{margin:5px 0;padding-left:8px;border-left:2px solid var(--vscode-textBlockQuote-border);color:var(--vscode-textBlockQuote-foreground)}.activity-body pre{max-width:100%;overflow:auto;margin:6px 0;padding:8px;border:1px solid var(--vscode-widget-border);border-radius:7px;background:var(--vscode-textCodeBlock-background);color:var(--vscode-editor-foreground);white-space:pre}.activity-body code{font-family:var(--vscode-editor-font-family);font-size:11px;background:var(--vscode-textCodeBlock-background);padding:1px 3px;border-radius:3px}.activity-body pre code{padding:0;background:transparent}.activity-body a{color:var(--vscode-textLink-foreground)}.tool{display:flex;align-items:flex-start;gap:8px;padding:3px 0}.task-state{margin-top:3px}.task-label{min-width:0;flex:1;overflow-wrap:anywhere}.task-label>p:last-child{margin-bottom:0}.tool.done{opacity:.68}.task-state{width:12px;height:12px;flex:none;border:1.5px solid color-mix(in srgb,currentColor 25%,transparent);border-top-color:var(--vscode-progressBar-background);border-radius:50%;animation:spin .75s linear infinite}.tool.done .task-state{border:0;animation:none}.tool.done .task-state:after{content:'✓';font-size:11px;color:var(--vscode-testing-iconPassed)}.tool.retry.failed{opacity:1;color:var(--vscode-errorForeground)}.tool.retry.failed .task-state{border:0;animation:none}.tool.retry.failed .task-state:after{content:'×';font-size:13px;color:var(--vscode-errorForeground)}
  .changed{border-left:2px solid var(--vscode-gitDecoration-addedResourceForeground);padding:4px 8px;margin:4px 0;color:var(--vscode-textLink-foreground);cursor:pointer;font-size:12px}.error,.error-card{color:var(--vscode-errorForeground);white-space:pre-wrap;border:1px solid color-mix(in srgb,var(--vscode-errorForeground) 65%,transparent);background:color-mix(in srgb,var(--vscode-errorForeground) 11%,transparent);border-radius:8px;padding:10px 11px;margin:10px 0;line-height:1.48}.error-card.streaming:after{display:none}
  .jump-bottom{display:none;position:absolute;z-index:8;left:50%;bottom:118px;transform:translateX(-50%);width:30px;height:30px;border:1px solid var(--vscode-widget-border);border-radius:50%;background:var(--vscode-editorWidget-background);color:var(--vscode-foreground);box-shadow:0 4px 14px rgba(0,0,0,.3);place-items:center;cursor:pointer}.jump-bottom.visible{display:grid}.jump-bottom svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.jump-spinner{display:none;width:13px;height:13px;border:1.5px solid color-mix(in srgb,currentColor 25%,transparent);border-top-color:currentColor;border-radius:50%;animation:spin .75s linear infinite}.jump-bottom.working .jump-arrow{display:none}.jump-bottom.working .jump-spinner{display:block}
  .composer{padding:9px 10px 10px;border-top:1px solid var(--vscode-widget-border);background:var(--vscode-sideBar-background)}.queued{display:none;align-items:center;gap:7px;margin:0 0 7px;padding:7px 8px;border:1px solid var(--vscode-widget-border);border-radius:8px;background:var(--vscode-editorWidget-background)}.queued.visible{display:flex}.queued-text{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--vscode-descriptionForeground);font-size:11px}.queued button{border:0;background:transparent;color:var(--vscode-foreground);padding:3px 5px;border-radius:4px;cursor:pointer;font-size:10px}.queued button:hover{background:var(--vscode-toolbar-hoverBackground)}.box{border:1px solid var(--vscode-input-border);background:var(--vscode-input-background);border-radius:9px;padding:8px;box-shadow:0 2px 8px rgba(0,0,0,.09)}textarea{width:100%;min-height:64px;max-height:180px;resize:none;border:0;outline:0;color:var(--vscode-input-foreground);background:transparent;font:13px var(--vscode-font-family);line-height:1.45}
  .actions{display:flex;justify-content:space-between;align-items:center;gap:7px;margin-top:6px}.model-select{min-width:0;max-width:calc(100% - 40px);height:27px;border:0;border-radius:5px;padding:0 6px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);font:11px var(--vscode-font-family);outline:none}.send{display:grid;place-items:center;width:29px;height:29px;border:0;border-radius:7px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);padding:0;cursor:pointer}.send svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.send .send-svg{fill:currentColor;stroke:currentColor;stroke-width:2.5;stroke-linejoin:round}.send:hover{background:var(--vscode-button-hoverBackground)}.send.stop{background:color-mix(in srgb,var(--vscode-foreground) 15%,transparent);color:#fff}.send .stop-svg{display:none}.send.stop .send-svg{display:none}.send.stop .stop-svg{display:block;fill:currentColor;stroke:none}
  .modal-backdrop{display:none;position:fixed;inset:0;z-index:20;background:rgba(0,0,0,.43);align-items:center;justify-content:center;padding:14px}.modal-backdrop.open{display:flex}.modal{width:100%;max-width:390px;background:var(--vscode-editorWidget-background);border:1px solid var(--vscode-widget-border);border-radius:10px;box-shadow:0 12px 35px rgba(0,0,0,.35);overflow:hidden}.modal.onboarding #settingsClose,.modal.onboarding #resetSettings{display:none}.modal-head{display:flex;align-items:center;padding:12px 13px;border-bottom:1px solid var(--vscode-widget-border)}.modal-title{font-weight:650;flex:1}.modal-body{padding:13px;max-height:calc(100vh - 130px);overflow:auto}.setup-copy{display:none;margin:0 0 14px;color:var(--vscode-descriptionForeground);font-size:12px;line-height:1.45}.modal.onboarding .setup-copy{display:block}.field{margin-bottom:12px}.field label{display:block;font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:5px}.field input{width:100%;height:30px;border:1px solid var(--vscode-input-border);border-radius:5px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);padding:0 8px;outline:none}.field input:focus{border-color:var(--vscode-focusBorder)}.small-btn,.secondary{border:1px solid var(--vscode-button-border,transparent);border-radius:5px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);padding:5px 8px;cursor:pointer}.learn-more{margin-top:6px;font-size:11px;color:var(--vscode-descriptionForeground)}.learn-more summary{width:max-content;color:var(--vscode-textLink-foreground);cursor:pointer;list-style:none}.learn-more summary::-webkit-details-marker{display:none}.learn-more p{margin:6px 0 0;line-height:1.45}.settings-result{min-height:18px;font-size:11px;margin-top:8px}.settings-result.ok{color:var(--vscode-testing-iconPassed)}.settings-result.bad{color:var(--vscode-errorForeground)}.modal-actions{display:flex;align-items:center;gap:7px;padding:10px 13px;border-top:1px solid var(--vscode-widget-border)}.modal-actions .spacer{flex:1}.primary{border:0;border-radius:5px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);padding:6px 11px;cursor:pointer}
</style></head><body><div class="app">
  <div class="top"><button class="conversation-button" id="conversationButton"><span class="conversation-title" id="conversationTitle">New conversation</span></button><button class="icon" id="newConversation" title="New conversation"><svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg></button><button class="icon settings-icon" id="settingsButton" title="Settings"><svg viewBox="0 0 24 24"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="3"/></svg></button><div class="conversation-menu" id="conversationMenu"></div></div>
  <div id="messages"><div class="empty" id="empty"><div class="empty-inner"><img class="empty-mark" src="${markUri}" alt=""><h2>What should I build?</h2></div></div></div>
  <button class="jump-bottom" id="jumpBottom" title="Jump to latest"><svg class="jump-arrow" viewBox="0 0 24 24"><path d="M12 5v14M19 12l-7 7-7-7"/></svg><span class="jump-spinner"></span></button>
  <div class="composer"><div class="queued" id="queued"><span class="queued-text" id="queuedText"></span><button id="steerQueued">Steer</button><button id="removeQueued" title="Remove queued prompt">×</button></div><div class="box"><textarea id="input" placeholder="Ask Opencodex to change your code…"></textarea><div class="actions"><select class="model-select" id="model"><option value="">Choose free model…</option></select><button class="send" id="send" title="Send"><svg class="send-svg" viewBox="0 0 24 24"><path d="M7.5 5.5 19 12 7.5 18.5Z"/></svg><svg class="stop-svg" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button></div></div></div>
</div>
<div class="modal-backdrop" id="settingsModal"><div class="modal" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
  <div class="modal-head"><span class="modal-title" id="settingsTitle">Opencodex Settings</span><button class="icon" id="settingsClose" aria-label="Close">×</button></div>
  <div class="modal-body">
    <p class="setup-copy">Choose how Opencodex should work before starting your first conversation. It connects directly to OpenCode's anonymous free models, so no account or API key is needed.</p>
    <div class="field"><label for="maxSteps">Maximum agent steps</label><input id="maxSteps" type="number" min="1" max="50"></div>
    <div class="field"><label for="approvalMode">Approval mode</label><select class="model-select" id="approvalMode" style="width:100%;max-width:none"><option value="ask">Ask every time</option><option value="edits">Auto-approve file edits</option><option value="autonomous">Auto-approve edits + commands</option></select></div>
    <div class="field"><label for="searxngUrl">SearXNG URL (optional, recommended)</label><input id="searxngUrl" spellcheck="false" placeholder="http://127.0.0.1:8080"><details class="learn-more"><summary>Learn more</summary><p>Lets the model search the web for current information and useful sources when a task needs them. Leave this blank to disable web search.</p></details></div>
    <div class="settings-result" id="settingsResult"></div>
  </div>
  <div class="modal-actions"><button class="secondary" id="resetSettings">Defaults</button><span class="spacer"></span><button class="secondary" id="testSettings">Test models</button><button class="primary" id="saveSettings">Save</button></div>
</div></div>
<script nonce="${nonce}">
  const vscode=acquireVsCodeApi(),messages=document.getElementById('messages'),input=document.getElementById('input'),send=document.getElementById('send'),model=document.getElementById('model'),conversationMenu=document.getElementById('conversationMenu'),conversationTitle=document.getElementById('conversationTitle'),jumpBottom=document.getElementById('jumpBottom'),queued=document.getElementById('queued'),queuedText=document.getElementById('queuedText');let running=false,runningConversationId='',activeConversationId='',conversations=[],queuedPrompt=null,currentTurn=null,current=null,activity=null,activityBody=null,reasoning=null,phaseStartedAt=0,taskCount=0,followOutput=true,gitTracked=${gitTracked};
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const nearBottom=()=>messages.scrollHeight-messages.scrollTop-messages.clientHeight<42;
  function updateJump(){const away=!nearBottom();jumpBottom.style.bottom=(document.querySelector('.composer').offsetHeight+10)+'px';jumpBottom.classList.toggle('visible',away);jumpBottom.classList.toggle('working',away&&running)}
  const scroll=(force=false)=>requestAnimationFrame(()=>{if(force||followOutput)messages.scrollTop=messages.scrollHeight;updateJump()});
  function scrollActivity(){const body=activityBody,details=activity;requestAnimationFrame(()=>{if(body&&details?.open&&followOutput)body.scrollTop=body.scrollHeight});scroll()}
  function inlineMarkdown(raw){const tick=String.fromCharCode(96),tokenStart=String.fromCharCode(57344),tokenEnd=String.fromCharCode(57345),codes=[];let line=esc(raw);line=line.replace(new RegExp(tick+'([^'+tick+'\\n]+)'+tick,'g'),(_,code)=>{codes.push(code);return tokenStart+(codes.length-1)+tokenEnd});line=line.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2">$1</a>').replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/__([^_]+)__/g,'<strong>$1</strong>').replace(/\*([^*]+)\*/g,'<em>$1</em>').replace(/_([^_]+)_/g,'<em>$1</em>');return line.replace(new RegExp(tokenStart+'(\\d+)'+tokenEnd,'g'),(_,index)=>'<code>'+codes[Number(index)]+'</code>')}
  function markdown(raw){
    const fence=String.fromCharCode(96).repeat(3),lines=String(raw).split(/\r?\n/);let html='',inCode=false,code='',list='',paragraph=[];
    const flushParagraph=()=>{if(paragraph.length){html+='<p>'+paragraph.map(inlineMarkdown).join(' ')+'</p>';paragraph=[]}};
    const closeList=()=>{if(list){html+='</'+list+'>';list=''}};
    for(const rawLine of lines){
      if(rawLine.trim().startsWith(fence)){flushParagraph();closeList();if(inCode){html+='<pre><code>'+esc(code.replace(/\n$/,''))+'</code></pre>';code=''}inCode=!inCode;continue}
      if(inCode){code+=rawLine+'\n';continue}
      const item=rawLine.match(/^\s*([-+*]|\d+\.)\s+(.+)$/);if(item){flushParagraph();const type=/\d/.test(item[1])?'ol':'ul';if(list!==type){closeList();html+='<'+type+'>';list=type}html+='<li>'+inlineMarkdown(item[2])+'</li>';continue}
      closeList();if(!rawLine.trim()){flushParagraph();continue}
      const heading=rawLine.match(/^(#{1,3})\s+(.+)$/);if(heading){flushParagraph();const level=heading[1].length;html+='<h'+level+'>'+inlineMarkdown(heading[2])+'</h'+level+'>';continue}
      const quote=rawLine.match(/^>\s?(.*)$/);if(quote){flushParagraph();html+='<blockquote>'+inlineMarkdown(quote[1])+'</blockquote>';continue}
      paragraph.push(rawLine.trim())
    }
    flushParagraph();closeList();if(inCode)html+='<pre><code>'+esc(code.replace(/\n$/,''))+'</code></pre>';return html
  }
  const emptyState=()=>'<div class="empty" id="empty"><div class="empty-inner"><img class="empty-mark" src="${markUri}" alt=""><h2>What should I build?</h2></div></div>';
  const timeLabel=value=>new Date(value||Date.now()).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
  function messageFooter(item,isAssistant){const footer=document.createElement('div');footer.className='message-footer'+(isAssistant?' assistant-footer':'');const time=document.createElement('span');time.textContent=timeLabel(item.timestamp);footer.appendChild(time);const copy=document.createElement('button');copy.className='message-action';copy.title='Copy';copy.setAttribute('aria-label','Copy message');copy.innerHTML='<svg viewBox="0 0 24 24"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';copy.onclick=()=>vscode.postMessage({type:'copyText',text:item.text});footer.appendChild(copy);if(isAssistant&&gitTracked&&item.gitTree){const restore=document.createElement('button');restore.className='message-action';restore.title='Restore here';restore.setAttribute('aria-label','Restore workspace to this message');restore.innerHTML='<svg viewBox="0 0 24 24"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>';restore.onclick=()=>vscode.postMessage({type:'restoreCheckpoint',conversationId:activeConversationId,itemId:item.id});footer.appendChild(restore)}return footer}
  function userBubble(item){const row=document.createElement('div');row.className='user-row';const wrapper=document.createElement('div');wrapper.className='user-message';const text=document.createElement('div');text.className='user-text';text.textContent=item.text;wrapper.append(text,messageFooter(item,false));row.appendChild(wrapper);return row}
  function closeCurrentText(){if(current)current.classList.remove('streaming');current=null}
  function clearActivityRefs(){activity=activityBody=reasoning=null;taskCount=0}
  function createActivity(){closeCurrentText();activity=document.createElement('details');activity.className='activity loading';activity.open=true;activity.innerHTML='<summary>Thinking</summary><div class="activity-body"></div>';activityBody=activity.querySelector('.activity-body');reasoning=document.createElement('div');reasoning.className='reasoning';reasoning.dataset.raw='';activityBody.appendChild(reasoning);currentTurn.appendChild(activity);phaseStartedAt=Date.now();taskCount=0}
  function ensureActivity(){if(!activity)createActivity()}
  function createTextSegment(){if(activity){finishActivity();clearActivityRefs()}current=document.createElement('div');current.className='assistant streaming';current.dataset.raw='';currentTurn.appendChild(current);return current}
  function beginTurn(item){document.getElementById('empty')?.remove();currentTurn=document.createElement('section');currentTurn.className='turn';currentTurn.appendChild(userBubble(item));messages.appendChild(currentTurn);current=activity=activityBody=reasoning=null;scroll(true)}
  function renderConversation(items){messages.innerHTML=items&&items.length?'':emptyState();currentTurn=current=activity=activityBody=reasoning=null;for(let i=0;i<(items||[]).length;i++){const item=items[i];if(item.role==='user'){const turn=document.createElement('section');turn.className='turn';turn.appendChild(userBubble(item));const next=items[i+1];if(next&&next.role==='assistant'){const answer=document.createElement('div');answer.className=next.kind==='error'?'assistant error-card':'assistant';if(next.kind==='error')answer.textContent=next.text;else answer.innerHTML=markdown(next.text);turn.append(answer,messageFooter(next,true));i++}messages.appendChild(turn)}}followOutput=true;scroll(true)}
  function enableActivity(){if(activity)activity.classList.add('has-content')}
  function updateTask(m){ensureActivity();enableActivity();let row=activityBody.querySelector('[data-task="'+CSS.escape(m.id)+'"]');if(!row){row=document.createElement('div');row.className='tool';row.dataset.task=m.id;row.innerHTML='<span class="task-state"></span><div class="task-label"></div>';activityBody.appendChild(row);taskCount++}row.querySelector('.task-label').innerHTML=markdown(m.name);if(m.phase==='end')row.classList.add('done');activity.querySelector('summary').textContent=m.phase==='start'?m.name:'Working';scrollActivity()}
  function showRetry(m){ensureActivity();enableActivity();activityBody.querySelectorAll('.retry:not(.done):not(.failed)').forEach(row=>row.classList.add('done'));const row=document.createElement('div');row.className='tool retry';row.dataset.retry=String(m.attempt);row.innerHTML='<span class="task-state"></span><div class="task-label"></div>';row.querySelector('.task-label').innerHTML=markdown('**Reconnecting '+m.attempt+'/'+m.max+'**');activityBody.appendChild(row);taskCount++;activity.querySelector('summary').textContent='Reconnecting '+m.attempt+'/'+m.max;scrollActivity()}
  function finishRetry(m){const rows=activityBody?.querySelectorAll('.retry');if(!rows?.length)return;const last=rows[rows.length-1];last.classList.add(m.ok?'done':'failed');last.querySelector('.task-label').innerHTML=markdown(m.ok?'**Reconnected '+m.attempt+'/'+m.max+'**':'**Reconnect failed '+m.attempt+'/'+m.max+'**');scrollActivity()}
  function finishActivity(){if(!activity)return;activity.classList.remove('loading');const seconds=Math.max(1,Math.round((Date.now()-phaseStartedAt)/1000));activity.querySelector('summary').textContent='Worked for '+seconds+'s'+(taskCount?' · '+taskCount+' task'+(taskCount===1?'':'s'):'');activity.open=false}
  function nextWorkPhase(){closeCurrentText();finishActivity();clearActivityRefs();scroll()}
  function finish(item){closeCurrentText();finishActivity();if(item&&currentTurn)currentTurn.appendChild(messageFooter(item,true));currentTurn=current=activity=activityBody=reasoning=null;scroll()}
  function renderConversationMenu(){const active=conversations.filter(x=>!x.archived),archived=conversations.filter(x=>x.archived);const group=(label,items)=>items.length?'<div class="menu-label">'+label+'</div>'+items.map(x=>'<div class="conversation-row '+(x.id===activeConversationId?'active':'')+'" data-open="'+esc(x.id)+'">'+(x.running?'<span class="spinner"></span>':'')+'<span class="title">'+esc(x.title)+'</span><button class="archive-action" data-archive="'+esc(x.id)+'" title="'+(x.archived?'Restore':'Archive')+'">'+(x.archived?'↶':'⌁')+'</button>'+(x.archived?'<button class="archive-action delete-action" data-delete="'+esc(x.id)+'" title="Delete permanently">×</button>':'')+'</div>').join(''):'';conversationMenu.innerHTML=group('Conversations',active)+group('Archived',archived);conversationMenu.querySelectorAll('[data-open]').forEach(el=>el.onclick=()=>{vscode.postMessage({type:'openConversation',id:el.dataset.open});conversationMenu.classList.remove('open')});conversationMenu.querySelectorAll('[data-archive]').forEach(el=>el.onclick=e=>{e.stopPropagation();vscode.postMessage({type:'archiveConversation',id:el.dataset.archive})});conversationMenu.querySelectorAll('[data-delete]').forEach(el=>el.onclick=e=>{e.stopPropagation();vscode.postMessage({type:'deleteConversation',id:el.dataset.delete})})}
  function addError(text){document.getElementById('empty')?.remove();const d=document.createElement('div');d.className='error';d.textContent=text;messages.appendChild(d);scroll()}
  function showGenerationError(item){if(!current&&currentTurn)createTextSegment();if(current){current.className='assistant error-card';current.dataset.raw='';current.textContent=item.text}else addError(item.text);finish(item)}
  function updateSendMode(){const stopping=running&&!input.value.trim();send.classList.toggle('stop',stopping);send.title=stopping?'Stop':'Send'}
  function submit(){const text=input.value.trim();if(running){if(!text){vscode.postMessage({type:'stop'});return}if(queuedPrompt)return;input.value='';resize();vscode.postMessage({type:'queuePrompt',text,conversationId:runningConversationId});return}if(!text)return;if(!model.value){addError('Choose a model first.');return}input.value='';resize();vscode.postMessage({type:'send',text})}
  function resize(){input.style.height='auto';input.style.height=Math.min(input.scrollHeight,180)+'px';updateSendMode()}
  send.onclick=submit;input.oninput=resize;input.onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();submit()}};
  messages.addEventListener('scroll',()=>{followOutput=nearBottom();updateJump()});jumpBottom.onclick=()=>{followOutput=true;scroll(true)};
  document.getElementById('steerQueued').onclick=()=>vscode.postMessage({type:'steerQueued'});document.getElementById('removeQueued').onclick=()=>vscode.postMessage({type:'removeQueued'});
  const modal=document.getElementById('settingsModal'),settingsPanel=modal.querySelector('.modal'),maxSteps=document.getElementById('maxSteps'),approvalMode=document.getElementById('approvalMode'),searxngUrl=document.getElementById('searxngUrl'),settingsResult=document.getElementById('settingsResult'),saveSettings=document.getElementById('saveSettings');let initialSetup=false;
  function openSettings(m){initialSetup=Boolean(m.initialSetup);settingsPanel.classList.toggle('onboarding',initialSetup);document.getElementById('settingsTitle').textContent=initialSetup?'Set up Opencodex':'Opencodex Settings';saveSettings.textContent=initialSetup?'Start using Opencodex':'Save';maxSteps.value=m.maxSteps||20;approvalMode.value=m.approvalMode||'ask';searxngUrl.value=m.searxngUrl||'';settingsResult.textContent='';settingsResult.className='settings-result';saveSettings.disabled=false;modal.classList.add('open');setTimeout(()=>maxSteps.focus(),0)}
  function closeSettings(){if(initialSetup)return;modal.classList.remove('open')}
  model.onchange=()=>vscode.postMessage({type:'selectModel',model:model.value});document.getElementById('settingsButton').onclick=()=>vscode.postMessage({type:'requestSettings'});document.getElementById('settingsClose').onclick=closeSettings;modal.onclick=e=>{if(e.target===modal)closeSettings()};document.getElementById('newConversation').onclick=()=>vscode.postMessage({type:'newConversation'});document.getElementById('conversationButton').onclick=()=>conversationMenu.classList.toggle('open');
  document.getElementById('resetSettings').onclick=()=>vscode.postMessage({type:'resetSettings'});
  document.getElementById('testSettings').onclick=()=>{settingsResult.textContent='Loading free models…';settingsResult.className='settings-result';vscode.postMessage({type:'testSettings'})};
  saveSettings.onclick=()=>{saveSettings.disabled=true;settingsResult.textContent='Saving…';settingsResult.className='settings-result';vscode.postMessage({type:'saveSettings',maxSteps:Number(maxSteps.value),approvalMode:approvalMode.value,searxngUrl:searxngUrl.value,initialSetup})};
  window.addEventListener('message',({data:m})=>{switch(m.type){
    case'conversations':conversations=m.conversations||[];activeConversationId=m.activeId;conversationTitle.textContent=conversations.find(x=>x.id===activeConversationId)?.title||'New conversation';renderConversationMenu();break;
    case'conversation':activeConversationId=m.id;renderConversation(m.items);break;
    case'settings':openSettings(m);break;
    case'settingsResult':saveSettings.disabled=false;settingsResult.textContent=m.text;settingsResult.className='settings-result '+(m.ok?'ok':'bad');if(m.ok&&m.text==='Settings saved.'){initialSetup=false;settingsPanel.classList.remove('onboarding');setTimeout(closeSettings,450)}break;
    case'config':if(m.model)model.value=m.model;break;
    case'models':{const selected=m.selected||'';model.innerHTML='<option value="">Choose free model…</option>'+m.models.map(x=>'<option value="'+esc(x)+'">'+esc(x)+'</option>').join('');model.value=selected;break}
    case'modelsError':addError(m.text);break;
    case'user':if(m.conversationId===activeConversationId)beginTurn(m.item);break;
    case'workPhase':if(m.conversationId===activeConversationId)nextWorkPhase();break;
    case'delta':if(m.conversationId===activeConversationId&&currentTurn){if(!current)createTextSegment();current.dataset.raw+=m.text;current.innerHTML=markdown(current.dataset.raw);scroll()}break;
    case'reasoningDelta':if(m.conversationId===activeConversationId&&currentTurn){ensureActivity();enableActivity();reasoning.dataset.raw+=m.text;reasoning.innerHTML=markdown(reasoning.dataset.raw);scrollActivity()}break;
    case'reasoningEnd':break;
    case'tool':if(m.conversationId===activeConversationId)updateTask(m);break;
    case'retry':if(m.conversationId===activeConversationId)showRetry(m);break;
    case'retryEnd':if(m.conversationId===activeConversationId)finishRetry(m);break;
    case'changed':{if(m.conversationId&&m.conversationId!==activeConversationId)break;if(!currentTurn)break;ensureActivity();enableActivity();const d=document.createElement('div');d.className='changed';d.textContent=(m.action||'Changed')+' '+m.path;d.onclick=()=>vscode.postMessage({type:'openFile',path:m.path});activityBody.appendChild(d);scrollActivity();break}
    case'command':break;
    case'error':if(!m.conversationId||m.conversationId===activeConversationId){addError(m.text);finish()}break;
    case'steered':if(m.conversationId===activeConversationId)finish();break;
    case'generationError':if(m.conversationId===activeConversationId)showGenerationError(m.item);break;
    case'queuedPrompt':queuedPrompt=m.prompt;queued.classList.toggle('visible',Boolean(queuedPrompt));queuedText.textContent=queuedPrompt?.text||'';updateJump();break;
    case'state':if(m.running)runningConversationId=m.conversationId;else if(runningConversationId===m.conversationId)runningConversationId='';running=Boolean(runningConversationId);model.disabled=running;updateSendMode();updateJump();break;
    case'done':if(m.conversationId===activeConversationId)finish(m.item);break;
  }})
</script></body></html>`;
  }
}

function createTranscriptItem(role: 'user' | 'assistant', text: string, kind?: 'error', gitTree?: string): TranscriptItem {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, role, text, timestamp: Date.now(), kind, gitTree };
}

function normalizeTranscriptItem(item: Partial<TranscriptItem>, fallbackTimestamp: number): TranscriptItem {
  return {
    id: item.id ?? `${fallbackTimestamp}-${Math.random().toString(36).slice(2, 8)}`,
    role: item.role === 'assistant' ? 'assistant' : 'user',
    text: item.text ?? '',
    timestamp: item.timestamp ?? fallbackTimestamp,
    kind: item.kind,
    gitTree: item.gitTree,
  };
}

function shouldAutoContinue(answer: string, finishReason: string, continuationCount: number): boolean {
  if (continuationCount >= 2) return false;
  if (finishReason === 'length') return true;
  if (finishReason && finishReason !== 'stop' && finishReason !== 'unknown' && finishReason !== 'other') return false;
  const text = answer.trim();
  if (!text) return true;
  const tail = text.slice(-700);
  const unfinishedAction = /(?:^|\n)(?:now|next|then|after that)\b[^\n]{0,500}(?::|\.{3}|…)$/i;
  const statedIntent = /(?:^|\n)(?:let me|i(?:'ll| will| am going to| need to))\s+(?:update|edit|change|fix|add|remove|create|write|implement|run|inspect|check|test|open|read|wire|finish|build)\b[^\n]{0,400}(?::|\.{3}|…)?$/i;
  return unfinishedAction.test(tail) || statedIntent.test(tail);
}

function isSecret(filePath: string): boolean {
  return filePath.split(/[\\/]/).some(part => /^\.env(?:\.|$)/i.test(part) || /^(credentials|secrets?)\.(json|ya?ml|toml)$/i.test(part));
}

function assertNotSecret(filePath: string): void {
  if (isSecret(filePath)) throw new Error('Access to environment and credential files is blocked.');
}

function truncate(value: string): string {
  return value.length > MAX_TOOL_OUTPUT ? `${value.slice(0, MAX_TOOL_OUTPUT)}\n…(truncated)` : value;
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  return String(record.path ?? record.query ?? record.glob ?? record.command ?? '').slice(0, 100);
}

function humanToolName(name: string): string {
    return ({ list_files: 'Listing files', read_file: 'Reading file', search_files: 'Searching workspace', write_file: 'Writing file', replace_text: 'Editing file', delete_file: 'Deleting file', get_diagnostics: 'Checking diagnostics', run_command: 'Running command', web_search: 'Searching the web' } as Record<string, string>)[name] ?? name;
}

function toolTask(name: string, input: unknown): string {
  const detail = summarizeInput(input);
  return detail ? `${humanToolName(name)} · ${detail}` : humanToolName(name);
}

function conversationTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 46 ? `${clean.slice(0, 45)}…` : clean || 'New conversation';
}

function normalizeApprovalMode(value: string): 'ask' | 'edits' | 'autonomous' {
  return value === 'edits' || value === 'autonomous' ? value : 'ask';
}

function isGitTrackedWorkspace(rootPath?: string): boolean {
  if (!rootPath) return false;
  const result = spawnSync('git', ['-C', rootPath, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
    timeout: 2_000,
    windowsHide: true,
  });
  return result.status === 0 && result.stdout.trim() === 'true';
}

function runGit(args: string[], cwd: string, extraEnv: NodeJS.ProcessEnv = {}, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)));
    child.on('error', reject);
    child.on('close', code => {
      const output = Buffer.concat(stdout).toString();
      if (code === 0) resolve(output);
      else reject(new Error(Buffer.concat(stderr).toString().trim() || `git ${args[0]} exited with code ${code}`));
    });
    child.stdin.end(input);
  });
}

async function captureGitTree(rootPath: string): Promise<string> {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'opencodex-git-'));
  const env = { GIT_INDEX_FILE: path.join(temporaryDirectory, 'index') };
  try {
    try { await runGit(['read-tree', 'HEAD'], rootPath, env); }
    catch { await runGit(['read-tree', '--empty'], rootPath, env); }
    await runGit(['add', '-A', '--', '.'], rootPath, env);
    const tree = (await runGit(['write-tree'], rootPath, env)).trim();
    if (!/^[0-9a-f]{40,64}$/i.test(tree)) throw new Error('Git did not produce a valid restore tree.');
    await runGit(['update-ref', `refs/opencodex/checkpoints/${tree}`, tree], rootPath);
    return tree;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function restoreGitTree(rootPath: string, targetTree: string): Promise<void> {
  const currentTree = await captureGitTree(rootPath);
  if (currentTree === targetTree) return;
  const patch = await runGit(['diff', '--binary', '--full-index', currentTree, targetTree, '--', '.'], rootPath);
  if (!patch) return;
  await runGit(['apply', '--binary', '--whitespace=nowarn', '-'], rootPath, {}, patch);
}

function runCommand(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, env: process.env });
    let output = '';
    const append = (chunk: Buffer) => { output = truncate(output + chunk.toString()); };
    child.stdout.on('data', append); child.stderr.on('data', append);
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Command timed out after ${timeoutMs / 1000}s.\n${output}`)); }, timeoutMs);
    const abort = () => child.kill('SIGTERM'); signal?.addEventListener('abort', abort, { once: true });
    child.on('error', error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); });
    child.on('close', code => { clearTimeout(timer); signal?.removeEventListener('abort', abort); code === 0 ? resolve(output || '(command completed with no output)') : reject(new Error(`Command exited with code ${code}.\n${output}`)); });
  });
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function providerErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    if (typeof record.message === 'string') return record.message;
    if (record.error && typeof record.error === 'object') {
      const nested = record.error as Record<string, unknown>;
      if (typeof nested.message === 'string') return nested.message;
    }
    if (typeof record.responseBody === 'string') {
      try {
        const body = JSON.parse(record.responseBody) as { error?: { message?: string } | string; message?: string };
        if (typeof body.error === 'string') return body.error;
        if (body.error && typeof body.error.message === 'string') return body.error.message;
        if (typeof body.message === 'string') return body.message;
      } catch {}
    }
  }
  return errorMessage(error);
}
function friendlyError(error: unknown): string {
  const message = providerErrorMessage(error);
  if (/ECONNREFUSED|fetch failed/i.test(message)) return 'Could not connect to OpenCode. Check your internet connection and try again.';
  if (/401|unauthorized|api key/i.test(message)) return 'OpenCode rejected the anonymous request. This free model may no longer support no-auth access; refresh the model list or choose another free model.';
  return message;
}

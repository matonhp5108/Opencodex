import * as vscode from 'vscode';
import * as path from 'node:path';
import { tool } from 'ai';
import { z } from 'zod';
import { runCommand } from './git';
import { MAX_FILE_BYTES } from './types';
import type { AppConfig } from './types';
import { assertNotSecret, isDestructiveCommand, isSecret, truncate } from './util';

export interface ToolContext {
  root: vscode.Uri;
  config(): AppConfig;
  approve(kind: 'edit' | 'command', title: string, detail: string, destructive?: boolean): Promise<void>;
  post(message: unknown): void;
  resolvePath(filePath: string): vscode.Uri;
  describePlan(): string;
  abortSignal?: AbortSignal;
}

export function buildTools(ctx: ToolContext): Record<string, any> {
  const tools: Record<string, any> = {
    plan: tool({
      description: 'Call this first for any non-trivial task. Present the main design aspects as an ordered plan: what will change, which files are involved, and how each part will be verified. The plan is shown as a floating card pinned to the top of the chat with the currently executing step spinning and completed steps checked off. IMPORTANT: the plan tool is STATEFUL and there is NO auto-advancement - the plan NEVER moves forward on its own, and previously completed steps stay checked. The result of every call returns the complete current plan back to you, so you always know its exact state. After finishing each step you MUST re-call this tool and pass doneSteps (0-based indices of every step now completed, including the one you just finished) plus activeStep (0-based index of the step you are now working on). Pass steps and title only when creating a plan or explicitly rewriting it; progress updates may omit them.',
      inputSchema: z.object({
        title: z.string().min(1).max(120).optional().describe('Short plan title, e.g. "Add multi-provider support". Omit for progress updates on an existing plan.'),
        steps: z.array(z.string().min(1)).min(1).max(12).optional().describe('Ordered steps covering the main design aspects. Omit for progress updates on an existing plan.'),
        activeStep: z.number().int().min(0).max(12).optional().describe('0-based index of the step you are currently working on. Pass this explicitly on EVERY plan call - the index never advances on its own.'),
        doneSteps: z.array(z.number().int().min(0).max(12)).optional().describe('0-based indices of steps already completed. Include every step you just finished, or it stays unchecked; previously completed steps are merged in automatically.'),
      }),
      execute: async () => ctx.describePlan(),
    }),
    list_files: tool({
      description: 'List workspace files matching a glob. Excludes dependencies and Git metadata.',
      inputSchema: z.object({ glob: z.string().default('**/*'), limit: z.number().int().min(1).max(500).default(200) }),
      execute: async ({ glob, limit }) => {
        const files = await vscode.workspace.findFiles(glob, '{**/node_modules/**,**/.git/**,**/dist/**,**/build/**}', limit);
        return files.map(uri => path.relative(ctx.root.fsPath, uri.fsPath)).join('\n') || '(no files)';
      },
    }),
    read_file: tool({
      description: 'Read a UTF-8 text file from the workspace. Secret env files are blocked.',
      inputSchema: z.object({ path: z.string() }),
      execute: async ({ path: filePath }) => {
        assertNotSecret(filePath);
        const uri = ctx.resolvePath(filePath);
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
          if (isSecret(path.relative(ctx.root.fsPath, uri.fsPath))) continue;
          try {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.size > MAX_FILE_BYTES) continue;
            const lines = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)).split(/\r?\n/);
            lines.forEach((line, index) => {
              if (hits.length < limit && line.toLowerCase().includes(query.toLowerCase())) {
                hits.push(`${path.relative(ctx.root.fsPath, uri.fsPath)}:${index + 1}: ${line.trim().slice(0, 300)}`);
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
        const uri = ctx.resolvePath(filePath);
        await ctx.approve('edit', `Write ${filePath}?`, reason ?? 'The agent wants to create or replace this file.');
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
        ctx.post({ type: 'changed', path: filePath });
        return `Wrote ${filePath} (${content.length} characters).`;
      },
    }),
    replace_text: tool({
      description: 'Replace one exact text occurrence in a workspace file. Requires user approval.',
      inputSchema: z.object({ path: z.string(), oldText: z.string().min(1), newText: z.string(), reason: z.string().optional() }),
      execute: async ({ path: filePath, oldText, newText, reason }) => {
        assertNotSecret(filePath);
        const uri = ctx.resolvePath(filePath);
        const document = await vscode.workspace.openTextDocument(uri);
        const source = document.getText();
        const first = source.indexOf(oldText);
        if (first < 0) throw new Error('Exact oldText was not found. Read the file again.');
        if (source.indexOf(oldText, first + oldText.length) >= 0) throw new Error('oldText occurs more than once; provide a larger unique block.');
        await ctx.approve('edit', `Edit ${filePath}?`, reason ?? 'The agent wants to replace one block of text.');
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(document.positionAt(first), document.positionAt(first + oldText.length)), newText);
        if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected the edit.');
        await document.save();
        ctx.post({ type: 'changed', path: filePath });
        return `Updated ${filePath}.`;
      },
    }),
    delete_file: tool({
      description: 'Delete one workspace file. Requires user approval.',
      inputSchema: z.object({ path: z.string(), reason: z.string().optional() }),
      execute: async ({ path: filePath, reason }) => {
        assertNotSecret(filePath);
        const uri = ctx.resolvePath(filePath);
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.Directory) !== 0) throw new Error('delete_file only deletes individual files.');
        await ctx.approve('edit', `Delete ${filePath}?`, reason ?? 'The agent wants to delete this file.');
        await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: false });
        ctx.post({ type: 'changed', path: filePath, action: 'Deleted' });
        return `Deleted ${filePath}.`;
      },
    }),
    get_diagnostics: tool({
      description: 'Return current VS Code errors and warnings for the workspace.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(200).default(100) }),
      execute: async ({ limit }) => {
        const rows: string[] = [];
        for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
          if (!uri.fsPath.startsWith(ctx.root.fsPath)) continue;
          for (const diagnostic of diagnostics) {
            if (rows.length >= limit) break;
            if (diagnostic.severity > vscode.DiagnosticSeverity.Warning) continue;
            rows.push(`${path.relative(ctx.root.fsPath, uri.fsPath)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${diagnostic.severity === 0 ? 'error' : 'warning'}: ${diagnostic.message}`);
          }
        }
        return rows.join('\n') || '(no errors or warnings)';
      },
    }),
    run_command: tool({
      description: 'Run a shell command in the workspace and return output. Destructive commands (deleting files, discarding Git changes, force-pushing, wiping data) require user approval in auto-edit mode.',
      inputSchema: z.object({ command: z.string().min(1), reason: z.string().optional(), timeoutSeconds: z.number().min(1).max(120).default(30) }),
      execute: async ({ command, reason, timeoutSeconds }) => {
        await ctx.approve('command', 'Run command?', `${command}\n\n${reason ?? ''}`, isDestructiveCommand(command));
        ctx.post({ type: 'command', command });
        return runCommand(command, ctx.root.fsPath, timeoutSeconds * 1000, ctx.abortSignal);
      },
    }),
  };
  const endpoint = ctx.config().searxngUrl;
  if (endpoint) {
    tools.web_search = tool({
      description: 'Search the web through the user-configured SearXNG instance and return result titles, URLs, and snippets.',
      inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(10).default(5) }),
      execute: async ({ query, limit }) => {
        const url = `${endpoint.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`;
        const response = await fetch(url, { signal: ctx.abortSignal, headers: { accept: 'application/json' } });
        if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}. Make sure JSON output is enabled.`);
        const payload = await response.json() as { results?: Array<{ title?: string; url?: string; content?: string }> };
        return (payload.results ?? []).slice(0, limit).map((result, index) => `${index + 1}. ${result.title ?? 'Untitled'}\n${result.url ?? ''}\n${result.content ?? ''}`).join('\n\n') || '(no results)';
      },
    });
  }
  return tools;
}

import * as vscode from 'vscode';
import { AgentViewProvider } from './agent';
import { systemNotify } from './notifications';

async function revealChat(): Promise<void> {
  try {
    await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
  } catch {}
  try {
    await vscode.commands.executeCommand('opencodex.chat.focus');
  } catch {}
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new AgentViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('opencodex.chat', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('opencodex.openChat', () => revealChat()),
    vscode.commands.registerCommand('opencodex.focus', () => revealChat()),
    vscode.commands.registerCommand('opencodex.settings', () => provider.openSettings()),
    vscode.commands.registerCommand('opencodex.usage', () => provider.openUsage()),
    vscode.commands.registerCommand('opencodex.marketplace', () => provider.openMarketplace()),
    vscode.commands.registerCommand('opencodex.clear', () => provider.clear()),
    vscode.commands.registerCommand('opencodex.testSystemNotification', () => {
      systemNotify(context, { subtitle: 'Opencodex', message: 'This is a test system notification from Opencodex. If you can read this, native notifications are working.', kind: 'info' });
      void vscode.window.showInformationMessage('Test system notification sent. (Notifications only appear when VS Code is not focused.)');
    }),
  );
}

export function deactivate() {}

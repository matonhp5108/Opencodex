import * as vscode from "vscode";
import { AgentViewProvider } from "./agent";

async function revealChat(): Promise<void> {
  try {
    await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
  } catch {}
  try {
    await vscode.commands.executeCommand("opencodex.chat.focus");
  } catch {}
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new AgentViewProvider(context);
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider("opencodex.chat", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("opencodex.openChat", () => revealChat()),
    vscode.commands.registerCommand("opencodex.focus", () => revealChat()),
    vscode.commands.registerCommand("opencodex.settings", () =>
      provider.openSettings(),
    ),
    vscode.commands.registerCommand("opencodex.usage", () =>
      provider.openUsage(),
    ),
    vscode.commands.registerCommand("opencodex.memory", () =>
      provider.openMemory(),
    ),
    vscode.commands.registerCommand("opencodex.marketplace", () =>
      provider.openMarketplace(),
    ),
    vscode.commands.registerCommand("opencodex.clear", () => provider.clear()),
    vscode.commands.registerCommand("opencodex.addMcp", () =>
      provider.showAddMcp(),
    ),
    vscode.window.registerUriHandler({
      handleUri: (uri) => provider.handleUri(uri),
    }),
  );
}

export function deactivate() {}

import * as vscode from "vscode";
import { AgentViewProvider } from "./agent";
import { FeatureRuntime } from "./features/runtime";
import { systemNotify } from "./features/notifications";

async function revealChat(): Promise<void> {
  try {
    await vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
  } catch {}
  try {
    await vscode.commands.executeCommand("opencodex.chat.focus");
  } catch {}
}

export function activate(context: vscode.ExtensionContext) {
  const features = new FeatureRuntime(context);
  const provider = new AgentViewProvider(context, features);
  features.setBrowserPreviewSink((preview) =>
    provider.showBrowserPreview(preview),
  );
  features.setTaskRunner((prompt, agentId) =>
    provider.runScheduledTask(
      agentId ? `@opencodex-agent(${agentId}) ${prompt}` : prompt,
    ),
  );
  context.subscriptions.push(
    features,
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
    vscode.commands.registerCommand("opencodex.testSystemNotification", () => {
      systemNotify(context, {
        subtitle: "Opencodex notification test",
        message: "System notifications are working.",
      });
      if (vscode.window.state.focused)
        void vscode.window.showInformationMessage(
          "Opencodex notification test passed. Native notifications appear when VS Code is not focused.",
        );
    }),
    vscode.commands.registerCommand("opencodex.testStarPrompt", async () => {
      const choice = await vscode.window.showInformationMessage(
        "Enjoying Opencodex? Consider starring the repo on GitHub.",
        "Star on GitHub",
      );
      if (choice === "Star on GitHub")
        await vscode.env.openExternal(
          vscode.Uri.parse("https://github.com/matonhp5108/Opencodex"),
        );
    }),
    vscode.window.registerUriHandler({
      handleUri: (uri) => provider.handleUri(uri),
    }),
  );
}

export function deactivate() {}

import * as vscode from "vscode";
import * as path from "node:path";
import { execFile } from "node:child_process";

export interface NotifyOptions {
  message: string;
  subtitle?: string;
  kind?: "info" | "attention";
}

let toastSeq = 0;

export function notifyToast(
  post: (message: unknown) => void,
  options: NotifyOptions,
): void {
  post({
    type: "toast",
    id: ++toastSeq,
    title: options.subtitle ?? "Opencodex",
    message: options.message,
    kind: options.kind ?? "info",
  });
}

const APP_NAME = "Opencodex";
const SETTING_ENABLED = "systemNotifications";

function notificationsEnabled(): boolean {
  return vscode.workspace
    .getConfiguration("opencodex")
    .get<boolean>(SETTING_ENABLED, true);
}

function spawnNotifier(
  command: string,
  args: string[],
  timeoutMs: number,
  onMissing?: () => void,
): void {
  execFile(
    command,
    args,
    { timeout: timeoutMs, windowsHide: true },
    (error) => {
      if (!error) return;
      const errno = (error as NodeJS.ErrnoException).code;
      if (errno === "ENOENT") {
        onMissing?.();
        return;
      }
      console.warn(`Opencodex notifier "${command}" failed: ${error.message}`);
    },
  );
}

function notifyMacOS(
  context: vscode.ExtensionContext,
  title: string,
  message: string,
): void {
  const binary = context.asAbsolutePath(
    path.join(
      "native",
      "OpencodexNotifier.app",
      "Contents",
      "MacOS",
      "OpencodexNotifier",
    ),
  );
  spawnNotifier(binary, ["--title", title, "--body", message], 60_000);
}

function vscodeUriScheme(): string {
  return vscode.env.appName.includes("Insiders")
    ? "vscode-insiders://"
    : "vscode://";
}

function notifyWindows(
  context: vscode.ExtensionContext,
  title: string,
  message: string,
): void {
  const script = context.asAbsolutePath(
    path.join("native", "windows", "notify.ps1"),
  );
  const icon = context.asAbsolutePath(
    path.join("media", "opencodex-notification.png"),
  );
  const payload = Buffer.from(
    JSON.stringify({ title, body: message, icon, uri: vscodeUriScheme() }),
  ).toString("base64");
  spawnNotifier(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-WindowStyle",
      "Hidden",
      "-File",
      script,
      payload,
    ],
    30_000,
  );
}

function notifyLinux(
  context: vscode.ExtensionContext,
  title: string,
  message: string,
): void {
  const script = context.asAbsolutePath(
    path.join("native", "linux", "notify.sh"),
  );
  const icon = context.asAbsolutePath(
    path.join("media", "opencodex-notification.png"),
  );
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  spawnNotifier(
    "bash",
    [script, title, message, icon, vscodeUriScheme(), folder],
    20_000,
  );
}

export function systemNotify(
  context: vscode.ExtensionContext,
  options: NotifyOptions,
): void {
  try {
    if (vscode.window.state.focused) return;
    if (!notificationsEnabled()) return;
    const title = options.subtitle ?? APP_NAME;
    const message = options.message.trim();
    if (!message) return;
    switch (process.platform) {
      case "darwin":
        notifyMacOS(context, title, message);
        break;
      case "win32":
        notifyWindows(context, title, message);
        break;
      case "linux":
        notifyLinux(context, title, message);
        break;
    }
  } catch (error) {
    console.warn("Opencodex system notification failed:", error);
  }
}

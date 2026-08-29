import * as fs from "node:fs";
import * as vscode from "vscode";
import { isGitTrackedWorkspace } from "./features/git";

export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  rootPath?: string,
): string {
  const nonce = Math.random().toString(36).slice(2);
  const assetUri = (name: string): string =>
    webview
      .asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", name))
      .toString();
  const templatePath = vscode.Uri.joinPath(
    extensionUri,
    "media",
    "webview.html",
  ).fsPath;
  const config = JSON.stringify({
    gitTracked: isGitTrackedWorkspace(rootPath),
    markUri: assetUri("opencodex-mark.svg"),
  }).replaceAll("<", "\\u003c");

  return fs
    .readFileSync(templatePath, "utf8")
    .replaceAll("{{CSP_SOURCE}}", webview.cspSource)
    .replaceAll("{{NONCE}}", nonce)
    .replaceAll("{{STYLE_URI}}", assetUri("webview.css"))
    .replaceAll("{{SCRIPT_URI}}", assetUri("webview.js"))
    .replaceAll("{{MARK_URI}}", assetUri("opencodex-mark.svg"))
    .replace("{{CONFIG_JSON}}", config);
}

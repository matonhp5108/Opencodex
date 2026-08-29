import * as vscode from "vscode";

export const MEMORY_RELATIVE_PATH = ".opencodex/memory.md";
const MAX_MEMORY_CHARS = 24_000;

export function memoryUri(root: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(root, ".opencodex", "memory.md");
}

export async function readProjectMemory(root: vscode.Uri): Promise<string> {
  try {
    const content = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(memoryUri(root)),
    );
    return content.slice(0, MAX_MEMORY_CHARS).trim();
  } catch {
    return "";
  }
}

export async function writeProjectMemory(
  root: vscode.Uri,
  content: string,
): Promise<void> {
  const normalized = content.trim().slice(0, MAX_MEMORY_CHARS);
  await vscode.workspace.fs.createDirectory(
    vscode.Uri.joinPath(root, ".opencodex"),
  );
  await vscode.workspace.fs.writeFile(
    memoryUri(root),
    new TextEncoder().encode(`${normalized}\n`),
  );
}

export async function openProjectMemory(root: vscode.Uri): Promise<void> {
  const uri = memoryUri(root);
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    await writeProjectMemory(
      root,
      "# Opencodex project memory\n\nKeep durable project decisions, conventions, and user preferences here. Do not store secrets.",
    );
  }
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
}

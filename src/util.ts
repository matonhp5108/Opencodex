import * as path from "node:path";
import type { Provider } from "./providers";
import { MAX_TOOL_OUTPUT } from "./types";
import type { TranscriptItem, WorkItem } from "./types";

export function pathInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(".." + path.sep) &&
    !path.isAbsolute(rel)
  );
}

export function createTranscriptItem(
  role: "user" | "assistant",
  text: string,
  kind?: "error",
  gitTree?: string,
  work?: WorkItem[],
  seconds?: number,
): TranscriptItem {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text,
    timestamp: Date.now(),
    kind,
    gitTree,
    work,
    seconds,
  };
}

export function normalizeTranscriptItem(
  item: Partial<TranscriptItem>,
  fallbackTimestamp: number,
): TranscriptItem {
  return {
    id:
      item.id ??
      `${fallbackTimestamp}-${Math.random().toString(36).slice(2, 8)}`,
    role: item.role === "assistant" ? "assistant" : "user",
    text: item.text ?? "",
    timestamp: item.timestamp ?? fallbackTimestamp,
    kind: item.kind,
    gitTree: item.gitTree,
    work: item.work,
    seconds: item.seconds,
  };
}

export function shouldAutoContinue(
  answer: string,
  finishReason: string,
  continuationCount: number,
): boolean {
  if (continuationCount >= 2) return false;
  if (finishReason === "length") return true;
  if (
    finishReason &&
    finishReason !== "stop" &&
    finishReason !== "unknown" &&
    finishReason !== "other"
  )
    return false;
  const text = answer.trim();
  if (!text) return true;
  const tail = text.slice(-700);
  const unfinishedAction =
    /(?:^|\n)(?:now|next|then|after that)\b[^\n]{0,500}(?::|\.{3}|…)$/i;
  const statedIntent =
    /(?:^|\n)(?:let me|i(?:'ll| will| am going to| need to))\s+(?:update|edit|change|fix|add|remove|create|write|implement|run|inspect|check|test|open|read|wire|finish|build)\b[^\n]{0,400}(?::|\.{3}|…)?$/i;
  return unfinishedAction.test(tail) || statedIntent.test(tail);
}

const DESTRUCTIVE_PATTERNS = [
  /\brm\b/,
  /\brmdir\b/,
  /\brmtree\b/,
  /\b(?:del|erase|deltree)\b/,
  /\bremove-item\b/,
  /\brd\b\s+[/-]\w*[sqr]\b/,
  /\b(?:unlink|os\.remove|os\.unlink|shutil\.rmtree|pathlib\.\w+\.unlink)\b/,
  /\bclear-(?:content|item|recyclebin)\b/,
  /\breg\s+delete\b/,
  /\bgit\s+(?:rm\b|clean|checkout\s+--(?!track\b|orphan\b|detach\b)|checkout\s+\.|restore\s+(?!--staged\b)|reset\s+--hard|branch\s+-(?:[dD]\b|--?delete\b)|tag\s+-d|stash\s+(?:drop|clear)|remote\s+(?:rm|remove)|filter-branch|reflog\s+expire|update-ref\s+-d)/,
  /\bgit\s+push\b[^|;&]*\s--?f(?:orce)?\b/,
  /\bmkfs(?:\.\w+)?\b/,
  /\b(?:fdisk|parted|dd|shred|wipefs|diskpart|format-volume|clear-disk)\b/,
  /\bformat\s+[a-z]:/,
  /\b(?:kill|pkill|killall|taskkill|stop-process|stop-service|stop-computer)\b/,
  /drop\s+(?:table|database|view|index|trigger|schema|user|role|sequence)/,
  /\btruncate\b/,
  /\s>\s*(?!\/dev\/null\b|&\d)\S+/,
  /\b(?:docker|podman)\s+(?:rm|rmi|volume\s+rm|image\s+prune|builder\s+prune|network\s+prune|system\s+prune)\b/,
  /\bkubectl\s+delete\b/,
  /\bterraform\s+(?:destroy|apply\s+-destroy)\b/,
  /\b(?:pip|pip3|pipx)\s+uninstall\b/,
  /\bnpm\s+uninstall\b/,
  /\b(?:yarn|pnpm)\s+remove\b/,
  /\b(?:apt|apt-get|yum|dnf|brew|cargo)\s+(?:remove|purge|autoremove|uninstall)\b/,
  /\bmvn\s+(?:clean|dependency:purge-local-repository)\b/,
];

export function isDestructiveCommand(command: string): boolean {
  const text = command.trim().toLowerCase();
  if (!text) return false;
  return DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(text));
}

export function isSecret(filePath: string): boolean {
  return filePath
    .split(/[\\/]/)
    .some(
      (part) =>
        /^\.env(?:\.|$)/i.test(part) ||
        /^(credentials|secrets?)\.(json|ya?ml|toml)$/i.test(part),
    );
}

export function assertNotSecret(filePath: string): void {
  if (isSecret(filePath))
    throw new Error("Access to environment and credential files is blocked.");
}

export function truncate(value: string): string {
  return value.length > MAX_TOOL_OUTPUT
    ? `${value.slice(0, MAX_TOOL_OUTPUT)}\n…(truncated)`
    : value;
}

export function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  return String(
    record.path ??
      record.query ??
      record.glob ??
      record.command ??
      record.source ??
      record.skill ??
      record.skills ??
      "",
  ).slice(0, 100);
}

export function humanToolName(name: string): string {
  return (
    (
      {
        list_files: "Listing files",
        read_file: "Reading file",
        search_files: "Searching workspace",
        write_file: "Writing file",
        replace_text: "Editing file",
        delete_file: "Deleting file",
        get_diagnostics: "Checking diagnostics",
        run_command: "Running command",
        web_search: "Searching the web",
        plan: "Planning",
        delegate_task: "Running subagent",
        terminal_start: "Starting terminal",
        terminal_write: "Writing to terminal",
        terminal_read: "Reading terminal",
        terminal_list: "Listing terminals",
        terminal_stop: "Stopping terminal",
        memory_read: "Reading project memory",
        memory_update: "Updating project memory",
        skillsmp_search: "Searching SkillsMP",
        skillsmp_list_repo_skills: "Listing repo skills",
        skillsmp_get_skill: "Previewing skill",
        skillsmp_install_skill: "Installing skill",
        skillsmp_list_installed: "Listing installed skills",
      } as Record<string, string>
    )[name] ?? name
  );
}

export function toolTask(name: string, input: unknown): string {
  const detail = summarizeInput(input);
  return detail ? `${humanToolName(name)} · ${detail}` : humanToolName(name);
}

export function conversationTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 46
    ? `${clean.slice(0, 45)}…`
    : clean || "New conversation";
}

export function normalizeApprovalMode(
  value: string,
): "ask" | "edits" | "autonomous" {
  return value === "edits" || value === "autonomous" ? value : "ask";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function providerErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (record.error && typeof record.error === "object") {
      const nested = record.error as Record<string, unknown>;
      if (typeof nested.message === "string") return nested.message;
    }
    if (typeof record.responseBody === "string") {
      try {
        const body = JSON.parse(record.responseBody) as {
          error?: { message?: string } | string;
          message?: string;
        };
        if (typeof body.error === "string") return body.error;
        if (body.error && typeof body.error.message === "string")
          return body.error.message;
        if (typeof body.message === "string") return body.message;
      } catch {}
    }
  }
  return errorMessage(error);
}

export function friendlyError(error: unknown, provider?: Provider): string {
  const message = providerErrorMessage(error);
  const name = provider?.name ?? "the provider";
  if (
    /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|networkerror/i.test(message)
  ) {
    return provider?.isLocal
      ? `Could not connect to ${name}. Make sure its local server is running, then try again.`
      : `Could not connect to ${name}. Check your internet connection and try again.`;
  }
  if (
    /api[ _-]?key/i.test(message) &&
    /invalid|not valid|valid api key|unauthorized|rejected|please pass|400|401|403/i.test(
      message,
    )
  ) {
    return `${name} rejected the API key. Check the key in Settings.`;
  }
  return message;
}

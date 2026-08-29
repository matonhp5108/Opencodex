import * as vscode from "vscode";
import * as path from "node:path";

export const SKILLS_SUBDIR = ".opencodex/skills";
export const SKILLS_GLOBAL_DIR = "skills";
export const SKILL_FILE_NAMES = ["SKILL.md", "skill.md", "Skill.md"];
const SKILLSMP_API = "https://skillsmp.com/api/v1";
const MAX_DOWNLOAD_FILES = 200;
const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const MAX_TREE_ENTRIES = 25_000;

export type SkillInfo = {
  name: string;
  description: string;
  author: string;
  stars: number;
  githubUrl: string;
  skillUrl: string;
  updatedAt?: number;
};

export type RepositorySkill = {
  name: string;
  path: string;
};

export type InstalledSkill = {
  name: string;
  description: string;
  folder: string;
  skillMdPath: string;
};

export type InstallResult = {
  name: string;
  files: number;
  bytes: number;
  skillMdPath: string;
};

type TreeEntry = {
  path: string;
  type: "blob" | "tree" | string;
  size?: number;
};

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/;

export function sanitizeSkillName(name: string): string {
  let safe = (name || "skill")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/^[.-]+|[.-]+$/g, "");
  if (WINDOWS_RESERVED_NAME.test(safe)) safe = `${safe}-skill`;
  return safe || "skill";
}

function parsedGithubReference(
  source: string,
): { owner: string; repo: string; branch: string; path: string } | undefined {
  let value = source.trim().replace(/\/+$/, "");
  value = value.replace(/^https?:\/\/(www\.)?github\.com\//i, "");
  const parts = value.split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  const [owner, repo, third, fourth, ...rest] = parts;
  if (!owner || !repo) return undefined;
  let branch = "main";
  let skillPath = "";
  if (third === "tree" || third === "blob") {
    branch = fourth || "main";
    skillPath = rest.join("/");
  } else if (third && parts.length >= 4) {
    branch = third;
    skillPath = parts.slice(3).join("/");
  }
  return { owner, repo, branch, path: skillPath };
}

function isSkillFile(filePath: string): boolean {
  const base = filePath.split("/").pop() ?? "";
  return SKILL_FILE_NAMES.includes(base);
}

async function readJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    signal,
    headers: { accept: "application/json" },
  });
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const payload = JSON.parse(text) as {
        error?: { message?: string };
        message?: string;
      };
      message = payload.error?.message ?? payload.message ?? message;
    } catch {}
    throw new Error(`${message} (${url})`);
  }
  return JSON.parse(text) as unknown;
}

export async function searchSkills(
  query: string,
  options: { page?: number; limit?: number; sortBy?: "stars" | "recent" } = {},
  signal?: AbortSignal,
): Promise<{ skills: SkillInfo[]; total: number }> {
  const params = new URLSearchParams({ q: query });
  params.set("page", String(options.page ?? 1));
  params.set("limit", String(Math.max(1, Math.min(50, options.limit ?? 20))));
  params.set("sortBy", options.sortBy ?? "stars");
  const payload = (await readJson(
    `${SKILLSMP_API}/skills/search?${params.toString()}`,
    signal,
  )) as {
    data?: {
      skills?: Array<Partial<SkillInfo> & { contentLanguage?: string }>;
      pagination?: { total?: number };
    };
  };
  const skills = (payload.data?.skills ?? []).map((skill) => ({
    name: String(skill.name ?? "Unnamed"),
    description: String(skill.description ?? ""),
    author: String(skill.author ?? ""),
    stars: Number(skill.stars ?? 0),
    githubUrl: String(skill.githubUrl ?? ""),
    skillUrl: String(skill.skillUrl ?? ""),
    updatedAt:
      typeof skill.updatedAt === "number" ? skill.updatedAt : undefined,
  }));
  return { skills, total: payload.data?.pagination?.total ?? skills.length };
}

async function fetchRepoTree(
  owner: string,
  repo: string,
  branch: string,
  signal?: AbortSignal,
): Promise<TreeEntry[]> {
  const candidates = [branch, "main", "master"]
    .filter((item, index, all) => all.indexOf(item) === index)
    .slice(0, 3);
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const payload = (await readJson(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${candidate}?recursive=1`,
        signal,
      )) as { tree?: unknown[] };
      const entries = Array.isArray(payload.tree)
        ? payload.tree.slice(0, MAX_TREE_ENTRIES)
        : [];
      return entries.map((entry) => {
        const record = entry as Partial<TreeEntry>;
        return {
          path: String(record.path ?? ""),
          type: record.type ?? "blob",
          size: typeof record.size === "number" ? record.size : undefined,
        };
      });
    } catch (error) {
      lastError = error;
    }
  }
  throw (
    lastError ??
    new Error(`Could not fetch the repository tree for ${owner}/${repo}.`)
  );
}

export async function listRepositorySkills(
  owner: string,
  repo: string,
  branch: string,
  signal?: AbortSignal,
): Promise<RepositorySkill[]> {
  const entries = await fetchRepoTree(owner, repo, branch, signal);
  const skills = new Map<string, RepositorySkill>();
  for (const entry of entries) {
    if (entry.type !== "blob" || !isSkillFile(entry.path)) continue;
    const folder = entry.path.split("/").slice(0, -1).join("/");
    const name = sanitizeSkillName(folder.split("/").pop() ?? "skill");
    if (!folder || skills.has(name)) continue;
    skills.set(name, { name, path: folder });
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function readRawFile(
  owner: string,
  repo: string,
  branch: string,
  filePath: string,
  signal?: AbortSignal,
): Promise<string> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath.split("/").map(encodeURIComponent).join("/")}`;
  const response = await fetch(url, { signal });
  if (!response.ok)
    throw new Error(`GitHub returned HTTP ${response.status} for ${filePath}.`);
  return response.text();
}

export async function readSkillMarkdown(
  owner: string,
  repo: string,
  branch: string,
  folderPath: string,
  signal?: AbortSignal,
): Promise<{ content: string; path: string }> {
  const base = folderPath.replace(/\/+$/, "");
  let lastError: unknown;
  for (const fileName of SKILL_FILE_NAMES) {
    const filePath = base ? `${base}/${fileName}` : fileName;
    try {
      return {
        content: await readRawFile(owner, repo, branch, filePath, signal),
        path: filePath,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw (
    lastError ??
    new Error(
      `No ${SKILL_FILE_NAMES.join(" or ")} found in ${owner}/${repo}/${base || "."}.`,
    )
  );
}

export function parseSkillFrontmatter(markdown: string): {
  name?: string;
  description?: string;
} {
  const result: { name?: string; description?: string } = {};
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return result;
  const block = match[1] ?? "";
  const nameMatch = /^name:\s*(.+)$/m.exec(block);
  if (nameMatch?.[1])
    result.name = nameMatch[1].trim().replace(/^['"]|['"]$/g, "");
  const descriptionMatch = /^description:\s*(.*)$/m.exec(block);
  const descriptionLine = descriptionMatch?.[1];
  if (descriptionLine !== undefined) {
    const first = descriptionLine.trim();
    if (first === "|" || first === ">-" || first === ">" || first === "|-") {
      const lines: string[] = [];
      const marker = descriptionMatch?.[0];
      const start = marker ? block.indexOf(marker) + marker.length : 0;
      for (const line of block.slice(start).split(/\r?\n/)) {
        if (/^\s{2,}/.test(line)) lines.push(line.trim());
        else if (!line.trim()) lines.push("");
        else break;
      }
      result.description = lines.join(" ").trim();
    } else {
      result.description = first.replace(/^['"]|['"]$/g, "");
    }
  }
  return result;
}

export async function listInstalledSkills(
  skillsDir: vscode.Uri,
): Promise<InstalledSkill[]> {
  const result: InstalledSkill[] = [];
  try {
    const folders = await vscode.workspace.fs.readDirectory(skillsDir);
    for (const [folder, type] of folders) {
      if ((type & vscode.FileType.Directory) === 0) continue;
      const folderUri = vscode.Uri.joinPath(skillsDir, folder);
      let skillMdPath = "";
      let content = "";
      for (const fileName of SKILL_FILE_NAMES) {
        const candidate = vscode.Uri.joinPath(folderUri, fileName);
        try {
          const stat = await vscode.workspace.fs.stat(candidate);
          if ((stat.type & vscode.FileType.File) !== 0) {
            skillMdPath = `${SKILLS_GLOBAL_DIR}/${folder}/${fileName}`;
            content = new TextDecoder().decode(
              await vscode.workspace.fs.readFile(candidate),
            );
            break;
          }
        } catch {}
      }
      if (!skillMdPath) continue;
      const meta = parseSkillFrontmatter(content);
      result.push({
        name: meta.name ?? folder,
        description: meta.description ?? "",
        folder,
        skillMdPath,
      });
    }
  } catch {}
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function installSkillFromRepository(
  skillsDir: vscode.Uri,
  spec: {
    owner: string;
    repo: string;
    branch: string;
    folderPath: string;
    installName: string;
  },
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<InstallResult> {
  const entries = await fetchRepoTree(
    spec.owner,
    spec.repo,
    spec.branch,
    signal,
  );
  const base = spec.folderPath.replace(/\/+$/, "");
  const prefix = base ? `${base}/` : "";
  const files = entries
    .filter(
      (entry) =>
        entry.type === "blob" &&
        (base ? entry.path.startsWith(prefix) : !entry.path.includes("/")),
    )
    .slice(0, MAX_DOWNLOAD_FILES);
  if (!files.length)
    throw new Error(
      `No files found for skill '${spec.installName}' at ${spec.owner}/${spec.repo}/${base || "."}.`,
    );
  let totalBytes = 0;
  for (const entry of files) {
    totalBytes += entry.size ?? 0;
    if (totalBytes > MAX_DOWNLOAD_BYTES)
      throw new Error(
        `Skill '${spec.installName}' is too large to install (over ${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)} MB).`,
      );
  }
  const installName = sanitizeSkillName(spec.installName);
  const targetDir = vscode.Uri.joinPath(skillsDir, installName);
  await vscode.workspace.fs.createDirectory(targetDir);
  let writtenBytes = 0;
  for (let index = 0; index < files.length; index++) {
    const entry = files[index];
    if (!entry) continue;
    const relative = entry.path.slice(prefix.length);
    const content = await readRawFile(
      spec.owner,
      spec.repo,
      spec.branch,
      entry.path,
      signal,
    );
    const bytes = Buffer.byteLength(content, "utf8");
    writtenBytes += bytes;
    const target = vscode.Uri.joinPath(targetDir, ...relative.split("/"));
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.file(path.dirname(target.fsPath)),
    );
    await vscode.workspace.fs.writeFile(
      target,
      new TextEncoder().encode(content),
    );
    onProgress?.(index + 1, files.length);
  }
  const skillMdPath = `${SKILLS_GLOBAL_DIR}/${installName}/${SKILL_FILE_NAMES[0]}`;
  return {
    name: installName,
    files: files.length,
    bytes: writtenBytes,
    skillMdPath,
  };
}

export async function uninstallSkill(
  skillsDir: vscode.Uri,
  folder: string,
): Promise<void> {
  const raw = (folder || "").trim();
  if (!raw) throw new Error("No skill specified.");
  const safeName = sanitizeSkillName(raw);
  if (!safeName) throw new Error(`Invalid skill folder '${raw}'.`);
  const target = vscode.Uri.joinPath(skillsDir, safeName);
  const skillsPath = path.resolve(skillsDir.fsPath);
  const targetPath = path.resolve(target.fsPath);
  if (
    targetPath !== skillsPath &&
    !targetPath.startsWith(skillsPath + path.sep)
  )
    throw new Error("Skill path escapes the skills directory.");
  try {
    const stat = await vscode.workspace.fs.stat(target);
    if ((stat.type & vscode.FileType.Directory) === 0)
      throw new Error(`'${safeName}' is not a skill folder.`);
  } catch (error) {
    if (
      error instanceof vscode.FileSystemError &&
      error.code === "FileNotFound"
    )
      throw new Error(`Skill '${safeName}' is not installed.`);
    throw error;
  }
  await vscode.workspace.fs.delete(target, { recursive: true });
}

export function resolveInstallPath(
  source: string,
  skill: string,
  branch: string,
): {
  owner: string;
  repo: string;
  branch: string;
  folderPath: string | undefined;
  hintedName: string | undefined;
} {
  const reference = parsedGithubReference(source);
  if (!reference)
    throw new Error(
      `Invalid GitHub reference '${source}'. Use 'owner/repo' or a github.com URL.`,
    );
  return {
    owner: reference.owner,
    repo: reference.repo,
    branch: branch || reference.branch || "main",
    folderPath: reference.path || undefined,
    hintedName:
      skill ||
      (reference.path
        ? sanitizeSkillName(reference.path.split("/").pop() ?? "skill")
        : undefined),
  };
}

export async function skillsPromptBlock(
  skillsDir: vscode.Uri,
): Promise<string> {
  const installed = await listInstalledSkills(skillsDir);
  if (!installed.length) return "";
  return `Installed skills (global skills folder, load the SKILL.md file when the user wants to use one):\n${installed.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n")}`;
}

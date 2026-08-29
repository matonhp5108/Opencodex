import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";

export interface FileEntry {
  path: string;
  content: string;
}

export interface SymbolEntry {
  name: string;
  kind: string;
  line: number;
  path: string;
}

export interface ArchNode {
  id: string;
  label: string;
  kind: "file" | "package";
}

export interface ArchEdge {
  from: string;
  to: string;
  kind: string;
}

export interface ArchitectureMap {
  nodes: ArchNode[];
  edges: ArchEdge[];
}

export const DEFAULT_IGNORE = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".opencodex",
  ".worktrees",
  "coverage",
  ".next",
  ".turbo",
  "vendor",
  ".venv",
  "__pycache__",
]);

export function hashContent(content: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export interface ManifestEntry {
  path: string;
  size: number;
  mtime: number;
  hash: string;
}

export function buildManifest(
  entries: FileEntry[],
): Map<string, ManifestEntry> {
  const map = new Map<string, ManifestEntry>();
  for (const entry of entries) {
    const stat = { size: entry.content.length, mtime: 0 };
    map.set(entry.path, {
      path: entry.path,
      size: stat.size,
      mtime: stat.mtime,
      hash: hashContent(entry.content),
    });
  }
  return map;
}

export interface ManifestDiff {
  added: string[];
  changed: string[];
  removed: string[];
  unchanged: string[];
}

export function diffManifest(
  prev: Map<string, ManifestEntry>,
  next: Map<string, ManifestEntry>,
): ManifestDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  for (const [p, e] of next) {
    const before = prev.get(p);
    if (!before) added.push(p);
    else if (before.hash !== e.hash) changed.push(p);
    else unchanged.push(p);
  }
  for (const p of prev.keys()) if (!next.has(p)) removed.push(p);
  return { added, changed, removed, unchanged };
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "this",
  "that",
  "it",
  "as",
  "be",
  "by",
  "from",
  "at",
  "we",
  "you",
  "i",
  "if",
  "else",
  "then",
  "do",
  "not",
  "no",
  "yes",
  "function",
  "const",
  "let",
  "var",
  "return",
  "import",
  "export",
  "class",
  "interface",
  "type",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_$]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

const SYMBOL_PATTERNS: { kind: string; re: RegExp }[] = [
  {
    kind: "function",
    re: /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  },
  { kind: "const", re: /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=/g },
  { kind: "let", re: /(?:export\s+)?let\s+([A-Za-z_$][\w$]*)\s*=/g },
  { kind: "class", re: /(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g },
  { kind: "interface", re: /(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/g },
  { kind: "type", re: /(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/g },
  {
    kind: "function",
    re: /(?:public\s+|private\s+|pub\s+)?fn\s+([A-Za-z_$][\w$]*)/g,
  },
  { kind: "function", re: /\bdef\s+([A-Za-z_$][\w$]*)\s*\(/g },
];

export function extractSymbols(
  content: string,
  filePath: string,
): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  const lines = content.split("\n");
  for (const pattern of SYMBOL_PATTERNS) {
    const re = new RegExp(pattern.re.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) {
      const name = m[1];
      if (!name) continue;
      const upto = m.index;
      const line = content.slice(0, upto).split("\n").length;
      symbols.push({ name, kind: pattern.kind, line, path: filePath });
    }
  }
  const seen = new Set<string>();
  return symbols.filter((s) => {
    const key = `${s.path}:${s.line}:${s.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const IMPORT_PATTERNS: RegExp[] = [
  /import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  /export\s+[^'"]*?\s+from\s+['"]([^'"]+)['"]/g,
];

export function extractImports(content: string): string[] {
  const out: string[] = [];
  for (const re of IMPORT_PATTERNS) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(content))) out.push(m[1] ?? "");
  }
  return out;
}

function resolveImport(
  importer: string,
  spec: string,
  files: Map<string, boolean>,
): string | undefined {
  if (!spec.startsWith(".")) {
    const first = spec.split("/")[0] ?? spec;
    return `package:${first}`;
  }
  const dir = path.posix.dirname(importer);
  const base = path.posix.normalize(path.posix.join(dir, spec));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.json`,
    path.posix.join(base, "index.ts"),
    path.posix.join(base, "index.js"),
  ];
  for (const candidate of candidates)
    if (files.has(candidate)) return candidate;
  return undefined;
}

export class RepoIndex {
  private entries: FileEntry[] = [];
  private byPath = new Map<string, string>();
  private termIndex = new Map<string, Map<string, number>>();
  private symbols: SymbolEntry[] = [];
  private docFrequency = new Map<string, number>();
  private totalDocs = 0;

  constructor(entries: FileEntry[] = []) {
    this.ingest(entries);
  }

  ingest(entries: FileEntry[]): void {
    for (const entry of entries) {
      this.entries.push(entry);
      this.byPath.set(entry.path, entry.content);
    }
  }

  upsert(entry: FileEntry): void {
    this.entries = this.entries.filter((item) => item.path !== entry.path);
    this.entries.push(entry);
    this.byPath.set(entry.path, entry.content);
    this.termIndex.clear();
    this.symbols = [];
  }

  remove(filePath: string): void {
    this.entries = this.entries.filter((item) => item.path !== filePath);
    this.byPath.delete(filePath);
    this.termIndex.clear();
    this.symbols = [];
  }

  get files(): FileEntry[] {
    return this.entries;
  }

  indexSymbols(): SymbolEntry[] {
    this.symbols = [];
    for (const entry of this.entries)
      this.symbols.push(...extractSymbols(entry.content, entry.path));
    return this.symbols;
  }

  symbolSearch(query: string, topK = 25): SymbolEntry[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const scored = this.symbols
      .map((s) => ({ s, score: this.symbolScore(s, q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
    return scored.map((x) => x.s);
  }

  private symbolScore(s: SymbolEntry, q: string): number {
    const name = s.name.toLowerCase();
    let score = 0;
    if (name === q) score += 100;
    else if (name.startsWith(q)) score += 60;
    else if (name.includes(q)) score += 30;
    if (score > 0 && (s.kind === "function" || s.kind === "class")) score += 5;
    return score;
  }

  indexSemantic(): void {
    this.termIndex.clear();
    this.docFrequency.clear();
    this.totalDocs = this.entries.length;
    for (const entry of this.entries) {
      const tokens = tokenize(entry.content);
      const tf = new Map<string, number>();
      for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
      for (const [term, count] of tf) {
        let postings = this.termIndex.get(term);
        if (!postings) {
          postings = new Map<string, number>();
          this.termIndex.set(term, postings);
        }
        postings.set(entry.path, count);
      }
      for (const term of tf.keys())
        this.docFrequency.set(term, (this.docFrequency.get(term) ?? 0) + 1);
    }
  }

  semanticSearch(
    query: string,
    topK = 10,
  ): { path: string; score: number; snippet: string }[] {
    if (!this.termIndex.size) this.indexSemantic();
    const queryTerms = tokenize(query);
    if (!queryTerms.length) return [];
    const scores = new Map<string, number>();
    for (const term of queryTerms) {
      const postings = this.termIndex.get(term);
      if (!postings) continue;
      const idf = Math.log(
        (this.totalDocs + 1) / ((this.docFrequency.get(term) ?? 0) + 1),
      );
      for (const [filePath, tf] of postings)
        scores.set(filePath, (scores.get(filePath) ?? 0) + tf * idf);
    }
    return [...scores.entries()]
      .map(([filePath, score]) => ({
        path: filePath,
        score: Number(score.toFixed(3)),
        snippet: this.snippetFor(filePath, queryTerms),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }

  private snippetFor(filePath: string, terms: string[]): string {
    const content = this.byPath.get(filePath) ?? "";
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const lower = (lines[i] ?? "").toLowerCase();
      if (terms.some((t) => lower.includes(t)))
        return lines
          .slice(Math.max(0, i - 1), i + 2)
          .join(" / ")
          .slice(0, 200);
    }
    return content.slice(0, 120);
  }

  architectureMap(): ArchitectureMap {
    const files = new Map<string, boolean>();
    for (const entry of this.entries) files.set(entry.path, true);
    const nodes = new Map<string, ArchNode>();
    const edges: ArchEdge[] = [];
    for (const entry of this.entries) {
      nodes.set(entry.path, {
        id: entry.path,
        label: path.basename(entry.path),
        kind: "file",
      });
      for (const spec of extractImports(entry.content)) {
        const resolved = resolveImport(entry.path, spec, files);
        if (!resolved) continue;
        if (resolved.startsWith("package:")) {
          if (!nodes.has(resolved))
            nodes.set(resolved, {
              id: resolved,
              label: resolved.slice("package:".length),
              kind: "package",
            });
          edges.push({ from: entry.path, to: resolved, kind: "imports" });
        } else {
          edges.push({ from: entry.path, to: resolved, kind: "imports" });
        }
      }
    }
    return { nodes: [...nodes.values()], edges };
  }
}

export function scanWorkspace(
  root: string,
  ignore: Set<string> = DEFAULT_IGNORE,
  maxBytes = 250_000,
): FileEntry[] {
  const out: FileEntry[] = [];
  const walk = (dir: string): void => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (ignore.has(name)) continue;
      const full = path.join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile() && stat.size <= maxBytes) {
        try {
          const rel = path.relative(root, full);
          out.push({ path: rel, content: readFileSync(full, "utf8") });
        } catch {}
      }
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

export interface MemoryFact {
  id: string;
  text: string;
  source: string;
  line?: number;
  sourceHash?: string;
  valid: boolean;
  recordedAt: number;
}

export class SourceCitedMemory {
  private facts: MemoryFact[] = [];

  get all(): MemoryFact[] {
    return this.facts;
  }

  record(input: {
    text: string;
    source: string;
    line?: number;
    sourceHash?: string;
  }): MemoryFact {
    const fact: MemoryFact = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      text: input.text,
      source: input.source,
      line: input.line,
      sourceHash: input.sourceHash,
      valid: true,
      recordedAt: Date.now(),
    };
    this.facts.push(fact);
    return fact;
  }

  invalidate(sources: { path: string; hash: string }[]): number {
    const byPath = new Map(sources.map((s) => [s.path, s.hash]));
    let invalidated = 0;
    for (const fact of this.facts) {
      const current = byPath.get(fact.source);
      if (fact.sourceHash && current !== fact.sourceHash) {
        if (fact.valid) invalidated++;
        fact.valid = false;
      }
    }
    return invalidated;
  }

  pruneInvalid(): number {
    const before = this.facts.length;
    this.facts = this.facts.filter((f) => f.valid);
    return before - this.facts.length;
  }

  toJSON(): string {
    return JSON.stringify(this.facts, null, 2);
  }

  load(json: string): void {
    try {
      const parsed = JSON.parse(json) as MemoryFact[];
      if (Array.isArray(parsed))
        this.facts = parsed.filter(
          (f) =>
            f && typeof f.text === "string" && typeof f.source === "string",
        );
    } catch {
      this.facts = [];
    }
  }
}

export function saveMemoryJson(root: string, json: string): void {
  const dir = path.join(root, ".opencodex");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "memory-index.json"), json, "utf8");
}

export function loadMemoryJson(root: string): string | undefined {
  try {
    return readFileSync(
      path.join(root, ".opencodex", "memory-index.json"),
      "utf8",
    );
  } catch {
    return undefined;
  }
}

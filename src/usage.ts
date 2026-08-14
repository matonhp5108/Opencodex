import * as vscode from "vscode";
import type { UsageRecord } from "./types";

const USAGE_STORAGE_KEY = "opencodex.usage";
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RECORDS = 5000;
const RETENTION_MS = 90 * DAY_MS;

const FIRST_USE_KEY = "opencodex.firstUseAt";
const STAR_PROMPTED_KEY = "opencodex.starPrompted";
const GITHUB_URL = "https://github.com/matonhp5108/Opencodex";

export function markFirstUse(context: vscode.ExtensionContext): void {
  if (context.globalState.get<number>(FIRST_USE_KEY)) return;
  void context.globalState.update(FIRST_USE_KEY, Date.now());
}

export function maybePromptForStar(
  context: vscode.ExtensionContext,
  onPrompt?: (message: string) => void,
): void {
  if (context.globalState.get<boolean>(STAR_PROMPTED_KEY, false)) return;
  let firstUse = context.globalState.get<number>(FIRST_USE_KEY, 0);
  if (!firstUse) {
    firstUse = Date.now();
    void context.globalState.update(FIRST_USE_KEY, firstUse);
    return;
  }
  if (Date.now() - firstUse < DAY_MS) return;
  void context.globalState.update(STAR_PROMPTED_KEY, true);
  onPrompt?.("Enjoying Opencodex? Consider starring the repo.");
  void vscode.window
    .showInformationMessage(
      "Enjoying Opencodex? Consider starring the repo on GitHub.",
      "Star on GitHub",
    )
    .then((choice) => {
      if (choice === "Star on GitHub")
        void vscode.env.openExternal(vscode.Uri.parse(GITHUB_URL));
    });
}

export function loadUsage(context: vscode.ExtensionContext): UsageRecord[] {
  const stored = context.globalState.get<unknown[]>(USAGE_STORAGE_KEY, []);
  return Array.isArray(stored)
    ? stored.filter(isUsageRecord).sort((a, b) => a.timestamp - b.timestamp)
    : [];
}

function isUsageRecord(entry: unknown): entry is UsageRecord {
  const record = entry as Partial<UsageRecord>;
  return (
    typeof record?.model === "string" &&
    typeof record?.provider === "string" &&
    typeof record?.timestamp === "number" &&
    typeof record?.inputTokens === "number" &&
    typeof record?.outputTokens === "number"
  );
}

export function recordUsage(
  context: vscode.ExtensionContext,
  entry: Omit<UsageRecord, "timestamp">,
): void {
  const cutoff = Date.now() - RETENTION_MS;
  const records = loadUsage(context).filter(
    (record) => record.timestamp >= cutoff,
  );
  records.push({ ...entry, timestamp: Date.now() });
  void context.globalState.update(
    USAGE_STORAGE_KEY,
    records.slice(-MAX_RECORDS),
  );
}

export type Tokens = { input: number; output: number };
export type PeriodAggregate = {
  today: Tokens;
  yesterday: Tokens;
  week: Tokens;
  month: Tokens;
};
export type ModelAggregate = {
  model: string;
  provider: string;
  periods: PeriodAggregate;
};
export type UsageAggregate = {
  models: ModelAggregate[];
  totals: PeriodAggregate;
};

function emptyTokens(): Tokens {
  return { input: 0, output: 0 };
}
function emptyPeriod(): PeriodAggregate {
  return {
    today: emptyTokens(),
    yesterday: emptyTokens(),
    week: emptyTokens(),
    month: emptyTokens(),
  };
}
function addTokens(target: Tokens, input: number, output: number): void {
  target.input += input;
  target.output += output;
}

function startOfDay(timestamp: number): number {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function aggregateUsage(records: UsageRecord[]): UsageAggregate {
  const now = Date.now();
  const todayStart = startOfDay(now);
  const yesterdayStart = todayStart - DAY_MS;
  const weekStart = todayStart - 6 * DAY_MS;
  const monthStart = todayStart - 29 * DAY_MS;
  const byModel = new Map<string, ModelAggregate>();
  const totals = emptyPeriod();
  for (const record of records) {
    const timestamp = record.timestamp;
    const inToday = timestamp >= todayStart;
    const inYesterday = timestamp >= yesterdayStart && timestamp < todayStart;
    const inWeek = timestamp >= weekStart;
    const inMonth = timestamp >= monthStart;
    if (!inToday && !inYesterday && !inWeek && !inMonth) continue;
    let entry = byModel.get(record.model);
    if (!entry) {
      entry = {
        model: record.model,
        provider: record.provider,
        periods: emptyPeriod(),
      };
      byModel.set(record.model, entry);
    }
    if (inToday) {
      addTokens(entry.periods.today, record.inputTokens, record.outputTokens);
      addTokens(totals.today, record.inputTokens, record.outputTokens);
    }
    if (inYesterday) {
      addTokens(
        entry.periods.yesterday,
        record.inputTokens,
        record.outputTokens,
      );
      addTokens(totals.yesterday, record.inputTokens, record.outputTokens);
    }
    if (inWeek) {
      addTokens(entry.periods.week, record.inputTokens, record.outputTokens);
      addTokens(totals.week, record.inputTokens, record.outputTokens);
    }
    if (inMonth) {
      addTokens(entry.periods.month, record.inputTokens, record.outputTokens);
      addTokens(totals.month, record.inputTokens, record.outputTokens);
    }
  }
  const models = [...byModel.values()].sort((a, b) => {
    const totalA = a.periods.month.input + a.periods.month.output;
    const totalB = b.periods.month.input + b.periods.month.output;
    return totalB - totalA || a.model.localeCompare(b.model);
  });
  return { models, totals };
}

export type ScheduleKind = "interval" | "daily" | "cron" | "once";

export interface ScheduleSpec {
  kind: ScheduleKind;
  everyMs?: number;
  hour?: number;
  minute?: number;
  cron?: string;
  atMs?: number;
}

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  agentId?: string;
  schedule: ScheduleSpec;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
  createdAt: number;
}

export type HookEventName =
  | "beforeTool"
  | "afterTool"
  | "onAgentStart"
  | "onAgentEnd"
  | "onEdit"
  | "onCommand"
  | "onMessage";

export type HookAction = "allow" | "block" | "warn" | "log" | "requireApproval";

export interface HookMatcher {
  tool?: string;
  pathGlob?: string;
  contains?: string;
}

export interface HookRule {
  id: string;
  name: string;
  event: HookEventName;
  matcher?: HookMatcher;
  action: HookAction;
  message?: string;
  enabled: boolean;
}

export interface HookContext {
  event: HookEventName;
  tool?: string;
  path?: string;
  text?: string;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "§")
    .replace(/\*/g, "[^/]*")
    .replace(/§/g, "(?:.*/)?");
  return new RegExp(`^${escaped}$`);
}

export function matchGlob(glob: string, value: string): boolean {
  try {
    return globToRegExp(glob).test(value);
  } catch {
    return false;
  }
}

export function normalizeSchedule(input: {
  kind?: string;
  everyMs?: number;
  hour?: number;
  minute?: number;
  cron?: string;
  atMs?: number;
}): ScheduleSpec {
  const kind = (input.kind ?? "interval") as ScheduleKind;
  if (kind === "interval")
    return {
      kind,
      everyMs: Math.max(60_000, Math.floor(input.everyMs ?? 60 * 60 * 1000)),
    };
  if (kind === "daily")
    return {
      kind,
      hour: Math.min(23, Math.max(0, input.hour ?? 9)),
      minute: Math.min(59, Math.max(0, input.minute ?? 0)),
    };
  if (kind === "once") return { kind, atMs: input.atMs ?? Date.now() };
  if (kind === "cron" && typeof input.cron === "string" && input.cron.trim())
    return { kind, cron: input.cron.trim() };
  return { kind: "interval", everyMs: 60 * 60 * 1000 };
}

function cronFieldMatches(
  field: string,
  value: number,
  min: number,
  max: number,
): boolean {
  return field.split(",").some((part) => {
    const step = /^\*\/(\d+)$/.exec(part);
    if (step) return value % Math.max(1, Number(step[1])) === 0;
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) return value >= Number(range[1]) && value <= Number(range[2]);
    if (part === "*") return true;
    const number = Number(part);
    return (
      Number.isInteger(number) &&
      number >= min &&
      number <= max &&
      value === number
    );
  });
}

function nextCronAt(cron: string, fromMs: number): number {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return fromMs + 3_600_000;
  const [minute = "*", hour = "*", day = "*", month = "*", weekday = "*"] =
    fields;
  const candidate = new Date(fromMs);
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  for (let checked = 0; checked < 527_040; checked++) {
    if (
      cronFieldMatches(minute, candidate.getUTCMinutes(), 0, 59) &&
      cronFieldMatches(hour, candidate.getUTCHours(), 0, 23) &&
      cronFieldMatches(day, candidate.getUTCDate(), 1, 31) &&
      cronFieldMatches(month, candidate.getUTCMonth() + 1, 1, 12) &&
      cronFieldMatches(weekday, candidate.getUTCDay(), 0, 6)
    )
      return candidate.getTime();
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  return fromMs + 3_600_000;
}

export function nextRunAt(spec: ScheduleSpec, fromMs: number): number {
  if (spec.kind === "interval") return fromMs + (spec.everyMs ?? 3_600_000);
  if (spec.kind === "once") return spec.atMs ?? fromMs;
  if (spec.kind === "daily") {
    const from = new Date(fromMs);
    const next = new Date(from);
    next.setUTCHours(spec.hour ?? 9, spec.minute ?? 0, 0, 0);
    if (next.getTime() <= fromMs) next.setUTCDate(next.getUTCDate() + 1);
    return next.getTime();
  }
  if (spec.kind === "cron") return nextCronAt(spec.cron ?? "", fromMs);
  return fromMs + 3_600_000;
}

export function dueTasks(
  tasks: ScheduledTask[],
  nowMs: number,
): ScheduledTask[] {
  return tasks.filter((t) => t.enabled && (t.nextRunAt ?? 0) <= nowMs);
}

export function matchHook(rule: HookRule, context: HookContext): boolean {
  if (!rule.enabled) return false;
  if (rule.event !== context.event) return false;
  const m = rule.matcher;
  if (!m) return true;
  if (m.tool && m.tool !== context.tool) return false;
  if (m.pathGlob && (!context.path || !matchGlob(m.pathGlob, context.path)))
    return false;
  if (m.contains && (!context.text || !context.text.includes(m.contains)))
    return false;
  return true;
}

export interface HookDecision {
  triggered: boolean;
  action: HookAction;
  message: string;
}

export function evaluateHook(
  rule: HookRule,
  context: HookContext,
): HookDecision {
  const triggered = matchHook(rule, context);
  return {
    triggered,
    action: triggered ? rule.action : "allow",
    message: triggered ? (rule.message ?? rule.name) : "",
  };
}

export function evaluateHooks(
  rules: HookRule[],
  context: HookContext,
): HookDecision {
  let decision: HookDecision = {
    triggered: false,
    action: "allow",
    message: "",
  };
  for (const rule of rules) {
    const result = evaluateHook(rule, context);
    if (result.triggered) {
      if (result.action === "block") return result;
      decision = result;
    }
  }
  return decision;
}

export function normalizeHookRule(
  input: Partial<HookRule> & {
    name: string;
    event: HookEventName;
    action: HookAction;
  },
): HookRule {
  return {
    id:
      typeof input.id === "string" && input.id
        ? input.id
        : `hook-${Math.random().toString(36).slice(2, 8)}`,
    name: input.name.trim() || "Untitled hook",
    event: input.event,
    matcher: input.matcher
      ? {
          tool: input.matcher.tool,
          pathGlob: input.matcher.pathGlob,
          contains: input.matcher.contains,
        }
      : undefined,
    action: input.action,
    message: input.message,
    enabled: input.enabled !== false,
  };
}

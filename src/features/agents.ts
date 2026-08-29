export type AgentToolMode = "all" | "allowlist" | "denylist";

export interface AgentRouting {
  mode: "manual" | "keyword" | "always";
  triggers: string[];
}

export interface CustomAgentConfig {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  provider?: string;
  toolMode: AgentToolMode;
  allowedTools: string[];
  deniedTools: string[];
  skills: string[];
  mcpServers: string[];
  routing: AgentRouting;
  enabled: boolean;
  createdAt: number;
}

export const ALL_TOOLS = [
  "plan",
  "list_files",
  "read_file",
  "search_files",
  "write_file",
  "replace_text",
  "delete_file",
  "get_diagnostics",
  "run_command",
  "delegate_task",
  "terminal_start",
  "terminal_write",
  "terminal_read",
  "terminal_list",
  "terminal_stop",
  "memory_read",
  "memory_update",
  "skillsmp_search",
  "skillsmp_list_repo_skills",
  "skillsmp_get_skill",
  "skillsmp_install_skill",
  "skillsmp_list_installed",
  "web_search",
  "browser_launch",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_snapshot",
  "browser_screenshot",
  "browser_close",
  "worktree_create",
  "worktree_list",
  "worktree_merge",
  "worktree_remove",
  "worktree_run",
  "github_create_pr",
  "github_list_issues",
  "repo_search",
  "repo_architecture",
  "repo_memory_list",
  "repo_memory_record",
] as const;

export type KnownTool = (typeof ALL_TOOLS)[number];

function slugId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `agent-${base || "custom"}-${Math.random().toString(36).slice(2, 6)}`;
}

export function normalizeAgentConfig(
  input: Partial<CustomAgentConfig> & {
    name: string;
    description: string;
    systemPrompt: string;
  },
  existing: CustomAgentConfig[] = [],
): CustomAgentConfig {
  const id =
    typeof input.id === "string" && input.id
      ? input.id
      : existing.some((a) => a.name === input.name)
        ? slugId(`${input.name}-${existing.length}`)
        : slugId(input.name);
  const mode: AgentToolMode =
    input.toolMode === "allowlist" || input.toolMode === "denylist"
      ? input.toolMode
      : "all";
  const routingMode: AgentRouting["mode"] =
    input.routing?.mode === "keyword" || input.routing?.mode === "always"
      ? input.routing.mode
      : "manual";
  const triggers = Array.isArray(input.routing?.triggers)
    ? input
        .routing!.triggers.map((t) => String(t).toLowerCase())
        .filter(Boolean)
    : [];
  return {
    id,
    name: input.name.trim() || "Untitled agent",
    description: input.description.trim(),
    systemPrompt: input.systemPrompt,
    model: input.model?.trim() || undefined,
    provider: input.provider?.trim() || undefined,
    toolMode: mode,
    allowedTools: (input.allowedTools ?? []).filter((t) =>
      (ALL_TOOLS as readonly string[]).includes(t),
    ),
    deniedTools: (input.deniedTools ?? []).filter((t) =>
      (ALL_TOOLS as readonly string[]).includes(t),
    ),
    skills: input.skills ?? [],
    mcpServers: input.mcpServers ?? [],
    routing: { mode: routingMode, triggers },
    enabled: input.enabled !== false,
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function toolAllowed(
  agent: CustomAgentConfig,
  toolName: string,
): boolean {
  if (agent.deniedTools.includes(toolName)) return false;
  if (agent.toolMode === "all") return true;
  if (agent.toolMode === "allowlist")
    return agent.allowedTools.includes(toolName);
  return true;
}

export function effectiveTools(agent: CustomAgentConfig): string[] {
  return (ALL_TOOLS as readonly string[]).filter((tool) =>
    toolAllowed(agent, tool),
  );
}

export interface RoutedAgent {
  agent: CustomAgentConfig;
  score: number;
  reason: string;
}

export function routeAgent(
  message: string,
  agents: CustomAgentConfig[],
): RoutedAgent | null {
  const text = message.toLowerCase();
  const keywords = text.split(/[^a-z0-9_]+/i).filter(Boolean);
  let best: RoutedAgent | null = null;
  let always: RoutedAgent | null = null;
  for (const agent of agents) {
    if (!agent.enabled) continue;
    if (agent.routing.mode === "keyword") {
      let score = 0;
      const matched: string[] = [];
      for (const trigger of agent.routing.triggers) {
        if (text.includes(trigger)) {
          score += 2;
          matched.push(trigger);
        }
      }
      if (score > 0) {
        const candidate: RoutedAgent = {
          agent,
          score,
          reason: `matched ${matched.length} trigger(s): ${matched.join(", ")}`,
        };
        if (!best || candidate.score > best.score) best = candidate;
      }
    } else if (agent.routing.mode === "always") {
      always = { agent, score: -1, reason: "default agent" };
    }
  }
  return best ?? always;
}

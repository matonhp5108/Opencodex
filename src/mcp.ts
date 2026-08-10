import * as path from 'node:path';
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';

type HttpServer = { url: string; transport?: 'http' | 'sse'; headers?: Record<string, string> };
type StdioServer = { command: string; args?: string[]; env?: Record<string, string>; cwd?: string };
type McpServer = HttpServer | StdioServer;

export type McpConnection = {
  tools: Record<string, any>;
  instructions: string[];
  errors: string[];
  close(): Promise<void>;
};

function safeName(value: string): string {
  const safe = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return safe || 'server';
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return Object.fromEntries(entries);
}

export function expandEnvironment(values?: Record<string, string>, env: NodeJS.ProcessEnv = process.env): Record<string, string> | undefined {
  if (!values) return undefined;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key,
    value.replace(/\$\{env:([^}\r\n]+)\}/g, (_match, rawName: string) => env[rawName.trim()] ?? ''),
  ]));
}

export function parseMcpServers(raw: string): Record<string, McpServer> {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new Error(`MCP server configuration is not valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MCP server configuration must be a JSON object keyed by server name.');
  const result: Record<string, McpServer> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`MCP server '${name}' must be an object.`);
    const item = value as Record<string, unknown>;
    if (typeof item.url === 'string' && item.url.trim()) {
      result[name] = {
        url: item.url.trim(),
        transport: item.transport === 'sse' ? 'sse' : 'http',
        headers: stringRecord(item.headers),
      };
    } else if (typeof item.command === 'string' && item.command.trim()) {
      result[name] = {
        command: item.command.trim(),
        args: Array.isArray(item.args) ? item.args.filter((arg): arg is string => typeof arg === 'string') : undefined,
        env: stringRecord(item.env),
        cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
      };
    } else {
      throw new Error(`MCP server '${name}' needs either a url or command.`);
    }
  }
  return result;
}

export async function connectMcpServers(
  raw: string,
  workspaceRoot: string,
  approve: (title: string, detail: string) => Promise<void>,
): Promise<McpConnection> {
  const definitions = parseMcpServers(raw);
  const clients: MCPClient[] = [];
  const tools: Record<string, any> = {};
  const instructions: string[] = [];
  const errors: string[] = [];
  for (const [serverName, server] of Object.entries(definitions)) {
    try {
      const client = 'url' in server
        ? await createMCPClient({ transport: { type: server.transport ?? 'http', url: server.url, headers: expandEnvironment(server.headers) } })
        : await createMCPClient({
          transport: new Experimental_StdioMCPTransport({
            command: server.command,
            args: server.args,
            env: server.env ? { ...process.env, ...expandEnvironment(server.env) } as Record<string, string> : undefined,
            cwd: server.cwd ? path.resolve(workspaceRoot, server.cwd) : workspaceRoot,
          }),
        });
      clients.push(client);
      if (client.instructions?.trim()) instructions.push(`${serverName}: ${client.instructions.trim()}`);
      const serverTools = await client.tools();
      for (const [toolName, definition] of Object.entries(serverTools)) {
        const exposedName = `mcp_${safeName(serverName)}_${safeName(toolName)}`;
        const original = definition as any;
        tools[exposedName] = {
          ...original,
          description: `[MCP: ${serverName}] ${original.description ?? toolName}`,
          execute: async (input: unknown, options: unknown) => {
            await approve(`Use ${serverName}: ${toolName}?`, JSON.stringify(input ?? {}, null, 2));
            if (typeof original.execute !== 'function') throw new Error(`MCP tool '${toolName}' is not executable.`);
            return original.execute(input, options);
          },
        };
      }
    } catch (error) {
      errors.push(`${serverName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    tools,
    instructions,
    errors,
    close: async () => { await Promise.allSettled(clients.map(client => client.close())); },
  };
}

import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import * as vscode from "vscode";
import type {
  McpConnectionData,
  McpAuthConfig,
  McpConnection,
  McpOAuthTokens,
  McpToolSummary,
  McpConnectionStatus,
} from "./types";

type HttpServer = {
  url: string;
  transport?: "http" | "sse";
  headers?: Record<string, string>;
};
type StdioServer = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};
type McpServer = HttpServer | StdioServer;

function safeName(value: string): string {
  const safe = value
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return safe || "server";
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return Object.fromEntries(entries);
}

export function expandEnvironment(
  values?: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  if (!values) return undefined;
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      value.replace(
        /\$\{env:([^}\r\n]+)\}/g,
        (_match, rawName: string) => env[rawName.trim()] ?? "",
      ),
    ]),
  );
}

export function parseMcpServers(raw: string): Record<string, McpServer> {
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `MCP server configuration is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(
      "MCP server configuration must be a JSON object keyed by server name.",
    );
  const result: Record<string, McpServer> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`MCP server '${name}' must be an object.`);
    const item = value as Record<string, unknown>;
    if (typeof item.url === "string" && item.url.trim()) {
      result[name] = {
        url: item.url.trim(),
        transport: item.transport === "sse" ? "sse" : "http",
        headers: stringRecord(item.headers),
      };
    } else if (typeof item.command === "string" && item.command.trim()) {
      result[name] = {
        command: item.command.trim(),
        args: Array.isArray(item.args)
          ? item.args.filter((arg): arg is string => typeof arg === "string")
          : undefined,
        env: stringRecord(item.env),
        cwd: typeof item.cwd === "string" ? item.cwd : undefined,
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
      const client =
        "url" in server
          ? await createMCPClient({
              transport: {
                type: server.transport ?? "http",
                url: server.url,
                headers: expandEnvironment(server.headers),
              },
            })
          : await createMCPClient({
              transport: new Experimental_StdioMCPTransport({
                command: server.command,
                args: server.args,
                env: server.env
                  ? ({
                      ...process.env,
                      ...expandEnvironment(server.env),
                    } as Record<string, string>)
                  : undefined,
                cwd: server.cwd
                  ? path.resolve(workspaceRoot, server.cwd)
                  : workspaceRoot,
              }),
            });
      clients.push(client);
      if (client.instructions?.trim())
        instructions.push(`${serverName}: ${client.instructions.trim()}`);
      const serverTools = await client.tools();
      for (const [toolName, definition] of Object.entries(serverTools)) {
        const exposedName = `mcp_${safeName(serverName)}_${safeName(toolName)}`;
        const original = definition as any;
        tools[exposedName] = {
          ...original,
          description: `[MCP: ${serverName}] ${original.description ?? toolName}`,
          execute: async (input: unknown, options: unknown) => {
            await approve(
              `Use ${serverName}: ${toolName}?`,
              JSON.stringify(input ?? {}, null, 2),
            );
            if (typeof original.execute !== "function")
              throw new Error(`MCP tool '${toolName}' is not executable.`);
            return original.execute(input, options);
          },
        };
      }
    } catch (error) {
      errors.push(
        `${serverName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    tools,
    instructions,
    errors,
    close: async () => {
      await Promise.allSettled(clients.map((client) => client.close()));
    },
  };
}

export {
  type McpAuthType,
  type McpAuthConfig,
  type McpConnectionData,
} from "./types";

export async function saveMcpConnection(
  connection: McpConnectionData,
  context: vscode.ExtensionContext,
): Promise<void> {
  const existing = context.globalState.get<McpConnectionData[]>(
    "opencodex.mcpConnections",
    [],
  );
  const index = existing.findIndex((c) => c.name === connection.name);
  if (index >= 0) {
    existing[index] = connection;
  } else {
    existing.push(connection);
  }
  existing.sort((a, b) => a.order - b.order);
  await context.globalState.update("opencodex.mcpConnections", existing);
  if (connection.auth.type !== "oauth2")
    await context.secrets.delete(oauthTokenKey(connection.name));
}

export async function loadMcpConnections(
  context: vscode.ExtensionContext,
): Promise<McpConnectionData[]> {
  return context.globalState.get<McpConnectionData[]>(
    "opencodex.mcpConnections",
    [],
  );
}

export async function deleteMcpConnection(
  name: string,
  context: vscode.ExtensionContext,
): Promise<void> {
  const existing = await loadMcpConnections(context);
  const filtered = existing.filter((c) => c.name !== name);
  await context.globalState.update("opencodex.mcpConnections", filtered);
  await context.secrets.delete(oauthTokenKey(name));
}

const oauthTokenKey = (name: string) => `opencodex.mcpOAuth.tokens.${name}`;
const oauthPendingKey = (state: string) =>
  `opencodex.mcpOAuth.pending.${state}`;

type PendingOAuth = {
  name: string;
  oauth: NonNullable<McpAuthConfig["oauth2Config"]>;
  verifier: string;
  redirectUrl: string;
  resource: string;
};

function b64url(value: Buffer): string {
  return value.toString("base64url");
}

function oauthTokenRequest(
  oauth: NonNullable<McpAuthConfig["oauth2Config"]>,
  body: URLSearchParams,
): { headers: Record<string, string>; body: URLSearchParams } {
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
  if (oauth.clientSecret && oauth.tokenAuthMethod !== "client_secret_post")
    headers.Authorization = `Basic ${Buffer.from(`${oauth.clientId}:${oauth.clientSecret}`).toString("base64")}`;
  else {
    body.set("client_id", oauth.clientId ?? "");
    if (oauth.clientSecret) body.set("client_secret", oauth.clientSecret);
  }
  return { headers, body };
}

async function probeForAuthChallenge(url: string): Promise<string | undefined> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "opencodex", version: "0.0.0" },
        },
      }),
    });
    if (response.status === 401 || response.status === 403)
      return response.headers.get("www-authenticate") ?? "";
  } catch {}
  return undefined;
}

function resourceMetadataUrlFromChallenge(
  wwwAuthenticate: string | undefined,
  serverUrl: string,
): string {
  const match = wwwAuthenticate
    ? /resource_metadata\s*=\s*"?([^",]+)"?/i.exec(wwwAuthenticate)
    : null;
  if (match && match[1]) return match[1];
  return `${new URL(serverUrl).origin}/.well-known/oauth-protected-resource`;
}

async function fetchJson(
  url: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return undefined;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function discoverAuthorizationServers(
  serverUrl: string,
  wwwAuthenticate: string | undefined,
): Promise<string[]> {
  const metadata = await fetchJson(
    resourceMetadataUrlFromChallenge(wwwAuthenticate, serverUrl),
  );
  const servers =
    metadata && Array.isArray(metadata.authorization_servers)
      ? metadata.authorization_servers.filter(
          (s): s is string => typeof s === "string",
        )
      : [];
  return servers.length ? servers : [new URL(serverUrl).origin];
}

type AuthServerMetadata = {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
};

async function discoverAuthServerMetadata(
  issuer: string,
): Promise<AuthServerMetadata | undefined> {
  const base = issuer.replace(/\/+$/, "");
  for (const url of [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`,
  ]) {
    const metadata = await fetchJson(url);
    if (
      metadata &&
      typeof metadata.authorization_endpoint === "string" &&
      typeof metadata.token_endpoint === "string"
    ) {
      return {
        authorization_endpoint: metadata.authorization_endpoint,
        token_endpoint: metadata.token_endpoint,
        registration_endpoint:
          typeof metadata.registration_endpoint === "string"
            ? metadata.registration_endpoint
            : undefined,
        scopes_supported: Array.isArray(metadata.scopes_supported)
          ? metadata.scopes_supported.filter(
              (s): s is string => typeof s === "string",
            )
          : undefined,
      };
    }
  }
  return undefined;
}

async function registerDynamicClient(
  registrationEndpoint: string,
  redirectUri: string,
  clientName: string,
): Promise<{ clientId: string; clientSecret?: string } | undefined> {
  try {
    const response = await fetch(registrationEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_name: clientName,
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",

        application_type: "native",
      }),
    });
    if (!response.ok) return undefined;
    const payload = (await response.json().catch(() => undefined)) as
      | Record<string, unknown>
      | undefined;
    if (!payload || typeof payload.client_id !== "string") return undefined;
    return {
      clientId: payload.client_id,
      clientSecret:
        typeof payload.client_secret === "string"
          ? payload.client_secret
          : undefined,
    };
  } catch {
    return undefined;
  }
}

const MCP_OAUTH_REDIRECT_BASE = "https://opencodex-mcp.vercel.app";

function originOf(input: string): string {
  try {
    return new URL(input).origin;
  } catch {
    return MCP_OAUTH_REDIRECT_BASE;
  }
}

async function resolveRedirectUri(
  context: vscode.ExtensionContext,
  override?: string,
): Promise<string> {
  const base = override?.trim() ? originOf(override) : MCP_OAUTH_REDIRECT_BASE;
  const scheme = encodeURIComponent(vscode.env.uriScheme);
  const ext = encodeURIComponent(context.extension.id);
  return `${base}/callback/${scheme}/${ext}`;
}
export async function discoverMcpOAuth(
  serverUrl: string,
  redirectUri: string,
  wwwAuthenticate?: string,
): Promise<NonNullable<McpAuthConfig["oauth2Config"]> | undefined> {
  const challenge = wwwAuthenticate ?? (await probeForAuthChallenge(serverUrl));
  const issuers = await discoverAuthorizationServers(serverUrl, challenge);
  const callback = redirectUri;
  for (const issuer of issuers) {
    const metadata = await discoverAuthServerMetadata(issuer);
    if (!metadata) continue;
    let clientId: string | undefined;
    let clientSecret: string | undefined;
    if (metadata.registration_endpoint) {
      const registered = await registerDynamicClient(
        metadata.registration_endpoint,
        callback,
        "Opencodex (VS Code)",
      );
      if (registered) {
        clientId = registered.clientId;
        clientSecret = registered.clientSecret;
      }
    }
    if (!clientId) continue;
    return {
      authUrl: metadata.authorization_endpoint,
      tokenUrl: metadata.token_endpoint,
      clientId,
      clientSecret,
      tokenAuthMethod: clientSecret
        ? "client_secret_basic"
        : "client_secret_post",
      scope: metadata.scopes_supported?.join(" "),

      resource: serverUrl,
    };
  }
  return undefined;
}

async function ensureOAuthConfig(
  url: string,
  auth: McpAuthConfig,
  context: vscode.ExtensionContext,
  wwwAuthenticate: string | undefined,
  redirectUri: string,
): Promise<boolean> {
  const existing = auth.oauth2Config;
  const staleRedirect =
    existing?.redirectUri && existing.redirectUri !== redirectUri;
  if (
    existing?.authUrl &&
    existing.tokenUrl &&
    existing.clientId &&
    !staleRedirect
  ) {
    if (!existing.resource) existing.resource = url;
    return true;
  }
  const discovered = await discoverMcpOAuth(url, redirectUri, wwwAuthenticate);
  if (!discovered) return false;
  auth.type = "oauth2";
  auth.oauth2Config = { ...discovered, redirectUri };
  return true;
}

export async function beginMcpOAuth(
  connection: Pick<McpConnectionData, "name" | "auth">,
  context: vscode.ExtensionContext,
  redirectUri: string,
): Promise<void> {
  const oauth = connection.auth.oauth2Config;
  if (!oauth?.authUrl || !oauth.tokenUrl || !oauth.clientId)
    throw new Error(
      "OAuth requires an authorization URL, token URL, and client ID.",
    );
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const callback = redirectUri;
  const authorizationUrl = new URL(oauth.authUrl);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", oauth.clientId);
  authorizationUrl.searchParams.set("redirect_uri", callback);
  authorizationUrl.searchParams.set("code_challenge", challenge);
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  authorizationUrl.searchParams.set("state", state);
  if (oauth.scope) authorizationUrl.searchParams.set("scope", oauth.scope);
  if (oauth.resource)
    authorizationUrl.searchParams.set("resource", oauth.resource);
  await context.globalState.update(oauthPendingKey(state), {
    name: connection.name,
    oauth,
    verifier,
    redirectUrl: callback,
    resource: oauth.resource ?? "",
  } satisfies PendingOAuth);
  const authorizationUri = vscode.Uri.parse(authorizationUrl.toString());
  const opened = await vscode.env.openExternal(authorizationUri);
  if (!opened)
    throw new Error(
      "VS Code could not open your browser for OAuth authorization.",
    );
}

export async function beginMcpOAuthAuto(
  connection: Pick<McpConnectionData, "name" | "auth"> & { url: string },
  context: vscode.ExtensionContext,
  wwwAuthenticate?: string,
): Promise<NonNullable<McpAuthConfig["oauth2Config"]> | undefined> {
  const redirectUri = await resolveRedirectUri(
    context,
    connection.auth.oauth2Config?.redirectUri,
  );
  const ok = await ensureOAuthConfig(
    connection.url,
    connection.auth,
    context,
    wwwAuthenticate,
    redirectUri,
  );
  if (!ok) return undefined;
  await beginMcpOAuth(connection, context, redirectUri);
  return connection.auth.oauth2Config;
}

export async function finishMcpOAuth(
  uri: vscode.Uri,
  context: vscode.ExtensionContext,
): Promise<string> {
  const params = new URLSearchParams(uri.query);
  const state = params.get("state");
  const code = params.get("code");
  if (!state) throw new Error("OAuth callback is missing state.");
  const pending = context.globalState.get<PendingOAuth>(oauthPendingKey(state));
  await context.globalState.update(oauthPendingKey(state), undefined);
  if (!pending)
    throw new Error(
      "This OAuth request has expired or was started by another VS Code window.",
    );
  if (params.get("error"))
    throw new Error(
      params.get("error_description") ||
        `Authorization failed: ${params.get("error")}`,
    );
  if (!code)
    throw new Error("OAuth callback is missing an authorization code.");
  if (!pending.oauth.clientId)
    throw new Error(
      "OAuth request is missing its client ID. Start the connection again.",
    );
  const tokenParams: Record<string, string> = {
    grant_type: "authorization_code",
    code,
    redirect_uri: pending.redirectUrl,
    code_verifier: pending.verifier,
  };
  if (pending.resource) tokenParams.resource = pending.resource;
  const request = oauthTokenRequest(
    pending.oauth,
    new URLSearchParams(tokenParams),
  );
  const response = await fetch(pending.oauth.tokenUrl, {
    method: "POST",
    ...request,
  });
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok || typeof payload.access_token !== "string")
    throw new Error(
      typeof payload.error_description === "string"
        ? payload.error_description
        : `Token exchange failed (HTTP ${response.status}).`,
    );
  const tokens: McpOAuthTokens = {
    access_token: payload.access_token,
    token_type:
      typeof payload.token_type === "string" ? payload.token_type : "Bearer",
    refresh_token:
      typeof payload.refresh_token === "string"
        ? payload.refresh_token
        : undefined,
    scope: typeof payload.scope === "string" ? payload.scope : undefined,
    expires_at:
      typeof payload.expires_in === "number"
        ? Date.now() + payload.expires_in * 1000
        : undefined,
  };
  await context.secrets.store(
    oauthTokenKey(pending.name),
    JSON.stringify(tokens),
  );
  return pending.name;
}

async function oauthAccessToken(
  connection: McpConnectionData,
  context: vscode.ExtensionContext,
): Promise<string> {
  const raw = await context.secrets.get(oauthTokenKey(connection.name));
  if (!raw)
    throw new Error(
      "OAuth authorization required. Open Settings, edit this MCP server, and choose Connect OAuth.",
    );
  const tokens = JSON.parse(raw) as McpOAuthTokens;
  if (!tokens.access_token)
    throw new Error(
      "Saved OAuth token is invalid. Reconnect this MCP server in Settings.",
    );
  if (!tokens.expires_at || tokens.expires_at > Date.now() + 60_000)
    return tokens.access_token;
  const oauth = connection.auth.oauth2Config;
  if (!tokens.refresh_token || !oauth?.tokenUrl || !oauth.clientId)
    throw new Error(
      "OAuth token expired. Reconnect this MCP server in Settings.",
    );
  const refreshParams: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  };

  if (oauth.resource) refreshParams.resource = oauth.resource;
  const request = oauthTokenRequest(oauth, new URLSearchParams(refreshParams));
  const response = await fetch(oauth.tokenUrl, { method: "POST", ...request });
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  if (!response.ok || typeof payload.access_token !== "string")
    throw new Error(
      "OAuth token refresh failed. Reconnect this MCP server in Settings.",
    );
  const refreshed: McpOAuthTokens = {
    ...tokens,
    access_token: payload.access_token,
    refresh_token:
      typeof payload.refresh_token === "string"
        ? payload.refresh_token
        : tokens.refresh_token,
    expires_at:
      typeof payload.expires_in === "number"
        ? Date.now() + payload.expires_in * 1000
        : undefined,
  };
  await context.secrets.store(
    oauthTokenKey(connection.name),
    JSON.stringify(refreshed),
  );
  return refreshed.access_token;
}

function summarizeTools(
  serverName: string,
  tools: Record<string, any>,
): McpToolSummary[] {
  return Object.entries(tools).map(([toolName, definition]) => ({
    toolName,
    exposedName: `mcp_${safeName(serverName)}_${safeName(toolName)}`,
    description:
      typeof (definition as any)?.description === "string"
        ? (definition as any).description
        : undefined,
  }));
}

export async function testMcpConnection(
  url: string,
  transport: "http" | "sse" = "http",
  authType: string,
  auth?: McpAuthConfig,
  context?: vscode.ExtensionContext,
  name = "MCP server",
): Promise<{
  success: boolean;
  error?: string;
  tools?: string[];
  toolDetails?: McpToolSummary[];
  authorizationStarted?: boolean;
  discoveredOAuth?: McpAuthConfig["oauth2Config"];
}> {
  const persistDiscoveredOAuth = async (
    discovered: NonNullable<McpAuthConfig["oauth2Config"]>,
  ) => {
    if (!context) return;
    const existing = (await loadMcpConnections(context)).find(
      (c) => c.name === name,
    );
    if (!existing) return;
    await saveMcpConnection(
      {
        ...existing,
        auth: { ...existing.auth, type: "oauth2", oauth2Config: discovered },
      },
      context,
    );
  };
  try {
    const headers: Record<string, string> = {};
    if (auth && auth.type !== "none") {
      switch (auth.type) {
        case "bearer":
          if (!auth.token) throw new Error("Bearer token is required");
          headers["Authorization"] = `Bearer ${auth.token}`;
          break;
        case "basic":
          if (!auth.username || !auth.password)
            throw new Error(
              "Username and password are required for Basic Auth",
            );
          headers["Authorization"] =
            `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
          break;
        case "api-key":
          if (!auth.apiKey) throw new Error("API key is required");
          headers["X-API-Key"] = auth.apiKey;
          break;
        case "custom":
          if (auth.customHeaders) Object.assign(headers, auth.customHeaders);
          break;
        case "oauth2":
          if (!context)
            throw new Error(
              "OAuth is unavailable because extension context is missing.",
            );
          try {
            headers["Authorization"] =
              `Bearer ${await oauthAccessToken({ name, description: "", url, transport, auth, enabled: true, order: 0 }, context)}`;
          } catch (error) {
            if (!String(error).includes("authorization required")) throw error;

            const discovered = await beginMcpOAuthAuto(
              { name, auth, url },
              context,
            );
            if (!discovered)
              throw new Error(
                "OAuth requires an authorization URL, token URL, and client ID.",
              );
            await persistDiscoveredOAuth(discovered);
            return {
              success: false,
              authorizationStarted: true,
              error: `Opened a sign-in window for ${name}. Complete sign-in in your browser, then test again.`,
              discoveredOAuth: discovered,
            };
          }
          break;
        case "header":
          if (auth.customHeaders) Object.assign(headers, auth.customHeaders);
          break;
      }
    }
    const client = await createMCPClient({
      transport: { type: transport, url, headers },
    });
    const tools = await client.tools();
    await client.close();
    return {
      success: true,
      tools: Object.keys(tools),
      toolDetails: summarizeTools(name, tools),
    };
  } catch (error) {
    if (context && (!auth || auth.type === "none" || auth.type === "oauth2")) {
      const challenge = await probeForAuthChallenge(url);
      if (challenge !== undefined) {
        try {
          const nextAuth: McpAuthConfig = auth
            ? { ...auth, type: "oauth2" }
            : { type: "oauth2" };
          const discovered = await beginMcpOAuthAuto(
            { name, auth: nextAuth, url },
            context,
            challenge,
          );
          if (discovered) {
            await persistDiscoveredOAuth(discovered);
            return {
              success: false,
              authorizationStarted: true,
              error: `${name} requires sign-in. Opened a sign-in window — complete it in your browser, then test again.`,
              discoveredOAuth: discovered,
            };
          }
        } catch (oauthError) {
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function checkMcpConnectionStatuses(
  context: vscode.ExtensionContext,
): Promise<McpConnectionStatus[]> {
  const connections = await loadMcpConnections(context);
  const statuses: McpConnectionStatus[] = [];
  for (const connection of connections) {
    statuses.push(
      connection.enabled === false
        ? { name: connection.name, state: "disabled" }
        : await probeMcpConnectionStatus(connection, context),
    );
  }
  return statuses;
}

async function probeMcpConnectionStatus(
  connection: McpConnectionData,
  context: vscode.ExtensionContext,
): Promise<McpConnectionStatus> {
  try {
    const headers: Record<string, string> = {};
    const auth = connection.auth;
    if (auth && auth.type !== "none") {
      switch (auth.type) {
        case "bearer":
          if (!auth.token)
            return {
              name: connection.name,
              state: "error",
              error: "Bearer token is required",
            };
          headers["Authorization"] = `Bearer ${auth.token}`;
          break;
        case "basic":
          if (!auth.username || !auth.password)
            return {
              name: connection.name,
              state: "error",
              error: "Username and password are required",
            };
          headers["Authorization"] =
            `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
          break;
        case "api-key":
          if (!auth.apiKey)
            return {
              name: connection.name,
              state: "error",
              error: "API key is required",
            };
          headers["X-API-Key"] = auth.apiKey;
          break;
        case "custom":
        case "header":
          if (auth.customHeaders) Object.assign(headers, auth.customHeaders);
          break;
        case "oauth2": {
          const raw = await context.secrets.get(oauthTokenKey(connection.name));
          if (!raw)
            return {
              name: connection.name,
              state: "auth_required",
              error: "Not signed in yet.",
            };
          try {
            headers["Authorization"] =
              `Bearer ${await oauthAccessToken(connection, context)}`;
          } catch (error) {
            return {
              name: connection.name,
              state: "auth_required",
              error: error instanceof Error ? error.message : String(error),
            };
          }
          break;
        }
      }
    }
    const client = await createMCPClient({
      transport: { type: connection.transport, url: connection.url, headers },
    });
    const tools = await client.tools();
    await client.close();
    return {
      name: connection.name,
      state: "ok",
      toolCount: Object.keys(tools).length,
      tools: summarizeTools(connection.name, tools),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/401|unauthor/i.test(message))
      return { name: connection.name, state: "auth_required", error: message };
    return { name: connection.name, state: "error", error: message };
  }
}

export async function connectToMcpConnections(
  connections: McpConnectionData[],
  workspaceRoot: string,
  approve: (title: string, detail: string) => Promise<void>,
  context: vscode.ExtensionContext,
): Promise<McpConnection> {
  const clients: MCPClient[] = [];
  const tools: Record<string, any> = {};
  const instructions: string[] = [];
  const errors: string[] = [];

  for (const connection of connections.filter((c) => c.enabled)) {
    try {
      const headers: Record<string, string> = {};
      if (connection.auth && connection.auth.type !== "none") {
        switch (connection.auth.type) {
          case "bearer":
            if (!connection.auth.token)
              throw new Error("Bearer token is required");
            headers["Authorization"] = `Bearer ${connection.auth.token}`;
            break;
          case "basic":
            if (!connection.auth.username || !connection.auth.password)
              throw new Error(
                "Username and password are required for Basic Auth",
              );
            headers["Authorization"] =
              `Basic ${Buffer.from(`${connection.auth.username}:${connection.auth.password}`).toString("base64")}`;
            break;
          case "api-key":
            if (!connection.auth.apiKey) throw new Error("API key is required");
            headers["X-API-Key"] = connection.auth.apiKey;
            break;
          case "custom":
          case "header":
            if (connection.auth.customHeaders)
              Object.assign(headers, connection.auth.customHeaders);
            break;
          case "oauth2":
            try {
              headers["Authorization"] =
                `Bearer ${await oauthAccessToken(connection, context)}`;
            } catch (error) {
              if (!String(error).includes("authorization required"))
                throw error;
              const discovered = await beginMcpOAuthAuto(connection, context);
              if (discovered)
                await saveMcpConnection(
                  {
                    ...connection,
                    auth: {
                      ...connection.auth,
                      type: "oauth2",
                      oauth2Config: discovered,
                    },
                  },
                  context,
                );
              throw new Error(
                `sign-in required — a browser window was opened, authorize the app and reconnect`,
              );
            }
            if (connection.auth.customHeaders)
              Object.assign(headers, connection.auth.customHeaders);
            break;
        }
      }

      const client = await createMCPClient({
        transport: { type: connection.transport, url: connection.url, headers },
      });

      clients.push(client);

      if (client.instructions?.trim()) {
        instructions.push(`${connection.name}: ${client.instructions.trim()}`);
      }

      const serverTools = await client.tools();
      for (const [toolName, definition] of Object.entries(serverTools)) {
        const exposedName = `mcp_${safeName(connection.name)}_${safeName(toolName)}`;
        const original = definition as any;
        tools[exposedName] = {
          ...original,
          description: `[MCP: ${connection.name}] ${original.description ?? toolName}`,
          execute: async (input: unknown, options: unknown) => {
            await approve(
              `Use ${connection.name}: ${toolName}?`,
              JSON.stringify(input ?? {}, null, 2),
            );
            if (typeof original.execute !== "function")
              throw new Error(`MCP tool '${toolName}' is not executable.`);
            return original.execute(input, options);
          },
        };
      }
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);

      if (
        (!connection.auth || connection.auth.type === "none") &&
        /401|unauthor/i.test(message)
      ) {
        try {
          const discovered = await beginMcpOAuthAuto(
            { ...connection, auth: { ...connection.auth, type: "oauth2" } },
            context,
          );
          if (discovered) {
            await saveMcpConnection(
              {
                ...connection,
                auth: { type: "oauth2", oauth2Config: discovered },
              },
              context,
            );
            message =
              "requires sign-in — a browser window was opened, authorize the app and reconnect";
          }
        } catch {}
      }
      errors.push(`${connection.name}: ${message}`);
    }
  }

  return {
    tools,
    instructions,
    errors,

    close: async () => {
      await Promise.allSettled(clients.map((client) => client.close()));
    },
  };
}

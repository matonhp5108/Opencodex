export type WebMessage =
  | { type: "ready" }
  | {
      type: "send";
      text: string;
      conversationId?: string;
      context?: ComposerContext;
    }
  | { type: "stop" }
  | { type: "newConversation" }
  | { type: "openConversation"; id: string }
  | { type: "archiveConversation"; id: string }
  | { type: "deleteConversation"; id: string }
  | { type: "restoreCheckpoint"; conversationId: string; itemId: string }
  | { type: "copyText"; text: string }
  | { type: "steerQueued"; conversationId: string }
  | { type: "removeQueued"; conversationId: string }
  | { type: "setKey" }
  | { type: "selectModel"; model: string; provider?: string }
  | { type: "requestSettings" }
  | {
      type: "saveSettings";
      maxSteps: number;
      approvalMode: string;
      searxngUrl: string;
      systemPrompt: string;
      provider: string;
      apiKey: string;
      extraFreeModels: string;
      baseUrl: string;
      onlyDefaultModels: boolean;
      confirmDelete: boolean;
      initialSetup?: boolean;
    }
  | { type: "removeApiKey"; provider: string }
  | {
      type: "saveCustomProvider";
      id?: string;
      name: string;
      baseUrl: string;
      needsApiKey: boolean;
      apiKey?: string;
    }
  | { type: "deleteCustomProvider"; id: string }
  | { type: "resetSettings" }
  | { type: "openFile"; path: string }
  | { type: "chooseContext" }
  | { type: "openMemory" }
  | { type: "revealInOS" }
  | { type: "revealSkill"; folder: string }
  | { type: "retryMessage"; conversationId: string }
  | { type: "requestUsage" }
  | { type: "requestMarketplace" }
  | { type: "requestMarketplaceInstalled" }
  | { type: "marketplaceTop"; sortBy?: "stars" | "recent" }
  | {
      type: "marketplaceSearch";
      query: string;
      limit: number;
      sortBy: "stars" | "recent";
    }
  | { type: "marketplaceListRepo"; source: string; branch?: string }
  | {
      type: "marketplacePreview";
      source: string;
      path?: string;
      branch?: string;
    }
  | {
      type: "marketplaceInstall";
      source: string;
      skill?: string;
      branch?: string;
      key?: string;
    }
  | {
      type: "marketplaceInstallProgress";
      key: string;
      done: number;
      total: number;
    }
  | { type: "marketplaceUninstall"; folder: string }
  | {
      type: "notifyResponse";
      id: number;
      choice: "ok" | "secondary" | "cancel";
    }
  | {
      type: "toast";
      id: number;
      title: string;
      message: string;
      kind: "info" | "attention";
    }
  | {
      type: "nativeNotify";
      message: string;
      detail?: string;
      kind: "info" | "warning" | "error";
    }
  | { type: "requestAddMcp" }
  | { type: "showAddMcp"; connection?: McpConnectionData }
  | {
      type: "saveMcpConnection";
      connection: McpConnectionData;
      silent?: boolean;
    }
  | {
      type: "testMcpConnection";
      url: string;
      transport?: McpTransportType;
      authType: string;
      auth?: McpAuthConfig;
      name?: string;
    }
  | { type: "deleteMcpConnection"; name: string }
  | { type: "reorderMcpConnections"; connections: McpConnectionData[] }
  | { type: "fetchMcpConnections" }
  | { type: "mcpConnections"; connections: McpConnectionData[] }
  | {
      type: "mcpConnectionTestResult";
      success: boolean;
      error?: string;
      tools?: string[];
      toolDetails?: McpToolSummary[];
      authorizationStarted?: boolean;
      discoveredOAuth?: NonNullable<McpAuthConfig["oauth2Config"]>;
    }
  | { type: "mcpConnectionSaved"; name: string }
  | { type: "mcpConnectionDeleted"; name: string }
  | { type: "mcpConnectionsReordered" }
  | { type: "checkMcpConnections" }
  | { type: "mcpConnectionStatuses"; statuses: McpConnectionStatus[] };

export type McpToolSummary = {
  toolName: string;
  exposedName: string;
  description?: string;
};

export type McpConnectionStatus = {
  name: string;
  state: "ok" | "auth_required" | "error" | "disabled";
  error?: string;
  toolCount?: number;
  tools?: McpToolSummary[];
};

export type WorkItem = {
  kind: "reasoning" | "task" | "plan";
  text: string;
  done?: boolean;
  title?: string;
  steps?: string[];
  activeStep?: number;
  doneSteps?: number[];
  interrupted?: boolean;
  manual?: boolean;
};

export type TranscriptItem = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  kind?: "error";
  gitTree?: string;
  work?: WorkItem[];
  seconds?: number;
};

export type Conversation = {
  id: string;
  title: string;
  items: TranscriptItem[];
  archived: boolean;
  createdAt: number;
  updatedAt: number;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  conversations: Conversation[];
  activeConversationId: string;
  createdAt: number;
  updatedAt: number;
};

export type ProviderModelGroup = {
  providerId: string;
  providerName: string;
  configured: boolean;
  models: string[];
  error?: string;
};

export type ApprovalMode = "ask" | "edits" | "autonomous";

export type ContextAttachment = {
  kind: "file" | "folder";
  path: string;
};

export type ComposerContext = {
  includeActiveFile?: boolean;
  includeSelection?: boolean;
  activeFile?: string;
  selectionLines?: string;
  attachments?: ContextAttachment[];
};

export type UsageRecord = {
  model: string;
  provider: string;
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
};

export interface AppConfig {
  model: string;
  provider: string;
  apiKey: string;
  baseUrl: string;
  maxSteps: number;
  approvalMode: ApprovalMode;
  searxngUrl: string;
  systemPrompt: string;
  mcpServers: string;
  extraFreeModels: string[];
  onlyDefaultModels: boolean;
}

export type McpAuthType =
  | "none"
  | "bearer"
  | "basic"
  | "api-key"
  | "custom"
  | "oauth2"
  | "header";

export type McpAuthConfig = {
  type: McpAuthType;
  token?: string;
  username?: string;
  password?: string;
  apiKey?: string;
  customHeaders?: Record<string, string>;
  oauth2Config?: {
    clientId?: string;
    clientSecret?: string;
    tokenAuthMethod?: "client_secret_basic" | "client_secret_post";
    tokenUrl: string;
    authUrl: string;
    scope?: string;
    resource?: string;
    redirectUri?: string;
  };
};

export type McpOAuthTokens = {
  access_token: string;
  token_type: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
};

export type McpTransportType = "http" | "sse";

export type McpConnectionData = {
  name: string;
  description: string;
  url: string;
  transport: McpTransportType;
  auth: McpAuthConfig;
  enabled: boolean;
  order: number;
  mode?: "url" | "tunnel";
};

export type StandardMcpServer = HttpServer | StdioServer;

export interface HttpServer {
  url: string;
  transport?: "http" | "sse";
  headers?: Record<string, string>;
}

export interface StdioServer {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpServer {
  url?: string;
  command?: string;
  transport?: "http" | "sse";
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  headers?: Record<string, string>;
}

export interface ParsedMcpServer {
  [key: string]: McpServer;
}

export interface McpConnection {
  tools: Record<string, any>;
  instructions: string[];
  errors: string[];
  close(): Promise<void>;
}

export const MAX_FILE_BYTES = 250_000;
export const MAX_TOOL_OUTPUT = 40_000;
export const MAX_PERSISTED_REASONING = 3_000;

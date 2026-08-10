export type WebMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string; conversationId?: string }
  | { type: 'stop' }
  | { type: 'newConversation' }
  | { type: 'openConversation'; id: string }
  | { type: 'archiveConversation'; id: string }
  | { type: 'deleteConversation'; id: string }
  | { type: 'restoreCheckpoint'; conversationId: string; itemId: string }
  | { type: 'copyText'; text: string }
  | { type: 'steerQueued'; conversationId: string }
  | { type: 'removeQueued'; conversationId: string }
  | { type: 'setKey' }
  | { type: 'selectModel'; model: string; provider?: string }
  | { type: 'requestSettings' }
  | { type: 'saveSettings'; maxSteps: number; approvalMode: string; searxngUrl: string; systemPrompt: string; provider: string; apiKey: string; extraFreeModels: string; baseUrl: string; onlyDefaultModels: boolean; confirmDelete: boolean; initialSetup?: boolean }
  | { type: 'removeApiKey'; provider: string }
  | { type: 'resetSettings' }
  | { type: 'openFile'; path: string }
  | { type: 'revealInOS' }
  | { type: 'revealSkill'; folder: string }
  | { type: 'retryMessage'; conversationId: string }
  | { type: 'requestUsage' }
  | { type: 'requestMarketplace' }
  | { type: 'requestMarketplaceInstalled' }
  | { type: 'marketplaceTop'; sortBy?: 'stars' | 'recent' }
  | { type: 'marketplaceSearch'; query: string; limit: number; sortBy: 'stars' | 'recent' }
  | { type: 'marketplaceListRepo'; source: string; branch?: string }
  | { type: 'marketplacePreview'; source: string; path?: string; branch?: string }
  | { type: 'marketplaceInstall'; source: string; skill?: string; branch?: string; key?: string }
  | { type: 'marketplaceInstallProgress'; key: string; done: number; total: number }
  | { type: 'marketplaceUninstall'; folder: string }
  | { type: 'notifyResponse'; id: number; choice: 'ok' | 'secondary' | 'cancel' }
  | { type: 'toast'; id: number; title: string; message: string; kind: 'info' | 'attention' };

export type WorkItem = {
  kind: 'reasoning' | 'task' | 'plan';
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
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
  kind?: 'error';
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

export type ApprovalMode = 'ask' | 'edits' | 'autonomous';

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
  extraFreeModels: string[];
  onlyDefaultModels: boolean;
}

export const MAX_FILE_BYTES = 250_000;
export const MAX_TOOL_OUTPUT = 40_000;
export const MAX_PERSISTED_REASONING = 3_000;

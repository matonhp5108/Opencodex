export interface Provider {
  id: string;
  name: string;
  baseURL: string;
  needsApiKey: boolean;
  acceptsApiKey?: boolean;
  apiKeyEnvVar?: string;
  apiKeyUrl?: string;
  freeSuffix?: string;
  extraFree?: string[];
  freeModels?: string[];
  parseModels?: (body: unknown) => string[];
  isLocal?: boolean;
}

const NON_TEXT = /(?:^|[^a-z0-9])(?:vision|image|audio|speech|voice|tts|stt|asr|whisper|embed(?:dings?)?|rerank|moderation|transcri|imagen|dall-?e|flux|sora|veo|midjourney|stable-diffusion|4v|vl)(?:[^a-z0-9]|$)/i;

function isTextModel(id: string): boolean {
  return !NON_TEXT.test(id);
}

function modelIds(body: unknown): string[] {
  const record = body as { data?: Array<{ id?: unknown }> };
  return (record.data ?? [])
    .map(item => (typeof item.id === 'string' ? item.id.replace(/^models\//, '') : ''))
    .filter(Boolean);
}

const GROQ_FREE = (body: unknown): string[] => modelIds(body).sort();

const GEMINI_FREE = (body: unknown): string[] =>
  modelIds(body).filter(id => /^(gemini-2\.[05]-|gemma-)/.test(id)).sort();

function filterFreeModels(provider: Provider, ids: string[]): string[] {
  const knownFree = new Set(provider.freeModels ?? []);
  return [...new Set(ids.filter(id =>
    (provider.freeSuffix && id.endsWith(provider.freeSuffix)) ||
    provider.extraFree?.includes(id) ||
    knownFree.has(id),
  ))].sort();
}

export const PROVIDERS: Record<string, Provider> = {
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    baseURL: 'https://opencode.ai/zen/v1',
    needsApiKey: false,
    acceptsApiKey: true,
    apiKeyUrl: 'https://console.opencode.ai/',
    freeSuffix: '-free',
    extraFree: ['big-pickle'],
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    needsApiKey: true,
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    apiKeyUrl: 'https://openrouter.ai/keys',
    freeSuffix: ':free',
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    needsApiKey: true,
    apiKeyEnvVar: 'GROQ_API_KEY',
    apiKeyUrl: 'https://console.groq.com/keys',
    parseModels: GROQ_FREE,
  },
  cerebras: {
    id: 'cerebras',
    name: 'Cerebras',
    baseURL: 'https://api.cerebras.ai/v1',
    needsApiKey: true,
    apiKeyEnvVar: 'CEREBRAS_API_KEY',
    apiKeyUrl: 'https://cloud.cerebras.ai',
    freeModels: ['llama-3.3-70b'],
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    needsApiKey: true,
    apiKeyEnvVar: 'GEMINI_API_KEY',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    parseModels: GEMINI_FREE,
    freeModels: [
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.5-pro',
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-2.5-flash-preview-09-2025',
    ],
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral',
    baseURL: 'https://api.mistral.ai/v1',
    needsApiKey: true,
    apiKeyEnvVar: 'MISTRAL_API_KEY',
    apiKeyUrl: 'https://console.mistral.ai/api-keys',
    freeModels: ['mistral-small-latest', 'open-mistral-nemo', 'ministral-3b-latest'],
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama (local)',
    baseURL: 'http://localhost:11434/v1',
    needsApiKey: false,
    apiKeyUrl: 'https://ollama.com',
    isLocal: true,
  },
};

export function getProvider(id: string | undefined): Provider {
  return (id && PROVIDERS[id]) || PROVIDERS.opencode!;
}

export function listProviders(): Provider[] {
  return Object.values(PROVIDERS);
}

export async function fetchProviderModels(provider: Provider, apiKey: string, extraFree: string[] = [], baseURL: string = provider.baseURL): Promise<string[]> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (provider.needsApiKey) {
    if (!apiKey) {
      const env = provider.apiKeyEnvVar ? ` or set the ${provider.apiKeyEnvVar} environment variable` : '';
      throw new Error(`${provider.name} requires an API key. Open Settings and paste your key${env}.`);
    }
    headers.authorization = `Bearer ${apiKey}`;
  }
  const response = await fetch(`${baseURL}/models`, { headers, signal: AbortSignal.timeout(10_000) });
  const bodyText = await response.text().catch(() => '');
  const keyHint = /api[ _-]?key/i.test(bodyText) && /invalid|not valid|valid api key|unauthorized|rejected|please pass|400|401|403/i.test(bodyText);
  if (response.status === 401 || response.status === 403 || (response.status === 400 && keyHint)) {
    throw new Error(`${provider.name} rejected the API key (HTTP ${response.status}). Check the key in Settings.`);
  }
  if (!response.ok) {
    const detail = bodyText.trim().slice(0, 200);
    throw new Error(`${provider.name} returned HTTP ${response.status} while listing models${detail ? `: ${detail}` : '.'}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error(`${provider.name} returned an unreadable response while listing models.`);
  }
  let models = provider.parseModels ? provider.parseModels(body) : filterFreeModels(provider, modelIds(body));
  if (!models.length && provider.freeModels?.length) models = provider.freeModels;
  if (!models.length && provider.isLocal) models = modelIds(body);
  models = models.filter(isTextModel);
  if (extraFree.length) models = [...new Set([...models, ...extraFree])].sort();
  if (!models.length) throw new Error(`${provider.name} currently lists no free models.`);
  return models;
}

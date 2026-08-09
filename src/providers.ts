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

export type ModelEntry = { id: string; raw?: Record<string, unknown> };

function modelEntries(body: unknown): ModelEntry[] {
  const record = body as { data?: Array<Record<string, unknown> | null | undefined> };
  const result: ModelEntry[] = [];
  for (const item of record.data ?? []) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id.replace(/^models\//, '') : '';
    if (id) result.push({ id, raw: item });
  }
  return result;
}

function modelIds(body: unknown): string[] {
  return modelEntries(body).map(entry => entry.id);
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

export function isCompatibleModel(provider: Provider, id: string, entry?: ModelEntry, capabilities?: Map<string, Set<string>>): boolean {
  if (!isTextModel(id)) return false;
  if (provider.id === 'openrouter' && entry?.raw) {
    const raw = entry.raw;
    const parameters = raw.supported_parameters;
    if (Array.isArray(parameters) && !parameters.includes('tools')) return false;
    const outputs = (raw.architecture as { output_modalities?: unknown } | undefined)?.output_modalities;
    if (Array.isArray(outputs) && !outputs.includes('text')) return false;
  }
  if (provider.id === 'ollama' && capabilities) {
    const caps = capabilities.get(id) ?? capabilities.get(id.replace(/:latest$/, ''));
    if (caps) return caps.has('tools') && caps.has('completion');
  }
  return true;
}

async function fetchOllamaCapabilities(baseURL: string): Promise<Map<string, Set<string>> | undefined> {
  try {
    const apiBase = baseURL.replace(/\/+$/, '').replace(/\/v1$/i, '');
    const response = await fetch(`${apiBase}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return undefined;
    const body = (await response.json().catch(() => null)) as { models?: Array<{ name?: unknown; model?: unknown; capabilities?: unknown }> } | null;
    const models = body?.models;
    if (!Array.isArray(models)) return undefined;
    const map = new Map<string, Set<string>>();
    for (const model of models) {
      const caps = Array.isArray(model.capabilities)
        ? new Set(model.capabilities.filter((cap): cap is string => typeof cap === 'string'))
        : undefined;
      if (!caps || caps.size === 0) continue;
      for (const key of [model.name, model.model]) {
        if (typeof key === 'string' && key) map.set(key.replace(/:latest$/, ''), caps);
      }
    }
    return map.size > 0 ? map : undefined;
  } catch {
    return undefined;
  }
}

export const PROVIDERS: Record<string, Provider> = {
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    baseURL: 'https://opencode.ai/zen/v1',
    needsApiKey: false,
    freeSuffix: '-free',
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
  const entries = modelEntries(body);
  let models: string[];
  if (provider.parseModels) {
    models = provider.parseModels(body);
  } else {
    models = filterFreeModels(provider, entries.map(entry => entry.id));
  }
  if (!models.length && provider.freeModels?.length) models = provider.freeModels;
  if (!models.length && provider.isLocal) models = entries.map(entry => entry.id);
  const capabilities = provider.id === 'ollama' && provider.isLocal ? await fetchOllamaCapabilities(baseURL) : undefined;
  const entryById = new Map(entries.map(entry => [entry.id, entry]));
  models = models.filter(id => isCompatibleModel(provider, id, entryById.get(id), capabilities));
  if (extraFree.length) models = [...new Set([...models, ...extraFree])].sort();
  if (!models.length) throw new Error(`${provider.name} currently lists no compatible models.`);
  return models;
}

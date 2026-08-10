import { isCompatibleModel, listProviders } from '../src/providers.ts';

const providerConfigured = (provider, apiKeys, baseUrls) => {
  if (provider.isLocal) return Boolean(baseUrls[baseUrlKey(provider.id)]);
  if (!provider.needsApiKey) return true;
  return Boolean(apiKeys[provider.id] || (provider.apiKeyEnvVar ? process.env[provider.apiKeyEnvVar] : ''));
};

const baseUrlKey = id => `opencodex.baseUrl.${id}`;

const assert = (v, msg) => { if (!v) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok -', msg); };

const providers = listProviders();
const byId = Object.fromEntries(providers.map(p => [p.id, p]));
const keys = { gemini: 'secret', openrouter: 'secret' };
const savedBaseUrls = { [baseUrlKey('ollama')]: 'http://localhost:11434/v1' };

assert(providerConfigured(byId.opencode, {}, {}) === true, 'opencode (keyless) always configured');
assert((byId.opencode.acceptsApiKey ?? byId.opencode.needsApiKey) === false, 'opencode no longer accepts an API key');
assert(byId.opencode.freeSuffix === '-free', 'opencode resolves its free tier live from the -free suffix');
assert((byId.opencode.freeModels?.length ?? 0) === 0, 'opencode has no hardcoded model list');
assert(byId.mistral.freeModels?.length > 0, 'mistral keeps a curated fallback (API exposes no free marker)');

const or = byId.openrouter;
assert(isCompatibleModel(or, 'vendor/model:free', { raw: { supported_parameters: ['temperature', 'tools'], architecture: { output_modalities: ['text'] } } }) === true, 'openrouter: tools+text model passes');
assert(isCompatibleModel(or, 'vendor/model:free', { raw: { supported_parameters: ['temperature'], architecture: { output_modalities: ['text'] } } }) === false, 'openrouter: model without tool support rejected');
assert(isCompatibleModel(or, 'vendor/model:free', { raw: { supported_parameters: ['tools'], architecture: { output_modalities: ['image'] } } }) === false, 'openrouter: image-only output rejected');
assert(isCompatibleModel(byId.ollama, 'llama3:8b', undefined, new Map([['llama3:8b', new Set(['completion', 'tools'])]])) === true, 'ollama: completion+tools model passes');
assert(isCompatibleModel(byId.ollama, 'some-model', undefined, new Map([['some-model', new Set(['completion'])]])) === false, 'ollama: model without tools rejected');
assert(isCompatibleModel(byId.ollama, 'some-model', undefined, undefined) === true, 'ollama: unknown capabilities fall back to pass');
assert(isCompatibleModel(byId.opencode, 'deepseek-v4-flash-free', undefined, undefined) === true, 'opencode: -free model passes compatibility');
assert(isCompatibleModel(byId.opencode, 'whisper-large-v3', undefined, undefined) === false, 'non-text model rejected everywhere');
assert(providerConfigured(byId.ollama, {}, {}) === false, 'ollama (local) unconfigured without saved URL');
assert(providerConfigured(byId.ollama, {}, savedBaseUrls) === true, 'ollama (local) configured once URL saved');
assert(providerConfigured(byId.gemini, {}, {}) === false, 'gemini unconfigured without key');
assert(providerConfigured(byId.gemini, keys, {}) === true, 'gemini configured once key is saved');
assert(providerConfigured(byId.openrouter, {}, {}) === false, 'openrouter unconfigured without key');
assert(providerConfigured(byId.openrouter, keys, {}) === true, 'openrouter configured once key is saved');
assert(providerConfigured(byId.groq, keys, {}) === false, 'groq stays unconfigured (no key for it)');

const config = { onlyDefaultModels: true, provider: 'gemini' };
const targets = config.onlyDefaultModels ? [byId.gemini] : providers.filter(p => providerConfigured(p, keys, savedBaseUrls));
assert(targets.length === 1 && targets[0].id === 'gemini', 'onlyDefaultModels=true -> default provider only');
const targetsAll = providers.filter(p => providerConfigured(p, keys, savedBaseUrls)).map(p => p.id);
assert(targetsAll.includes('opencode') && targetsAll.includes('gemini') && targetsAll.includes('openrouter') && targetsAll.includes('ollama'), 'onlyDefaultModels=false -> every configured provider');
const unconfigured = providers.filter(p => !providerConfigured(p, keys, {})).map(p => p.id);
assert(byId.ollama.isLocal && unconfigured.includes('ollama'), 'local providers without a saved URL are skipped (invisible) in the picker');

const groupSort = (groups, defaultId) => groups.sort((a, b) => (a.providerId === defaultId ? -1 : b.providerId === defaultId ? 1 : a.providerName.localeCompare(b.providerName)));
const sorted = groupSort([
  { providerId: 'ollama', providerName: 'Ollama (local)' },
  { providerId: 'gemini', providerName: 'Google Gemini' },
  { providerId: 'opencode', providerName: 'OpenCode' },
], 'gemini').map(g => g.providerId);
assert(sorted.join(',') === 'gemini,ollama,opencode', 'default provider first, rest alphabetical by name');

const groups = [
  { providerId: 'opencode', models: ['deepseek-v4-flash-free'] },
  { providerId: 'gemini', models: ['gemini-2.5-flash'] },
];
assert(groups.some(g => g.models.includes('gemini-2.5-flash')) === true, 'selected model present -> kept');
assert(groups.some(g => g.models.includes('old-model')) === false, 'stale selected model -> cleared');

console.log(process.exitCode ? 'LOGIC CHECK FAILED' : 'LOGIC CHECK OK');

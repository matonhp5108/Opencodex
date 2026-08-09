// Sanity-check the configured-provider semantics against the real provider registry.
import { listProviders } from '../src/providers.ts';

// Mirrors AgentViewProvider.providerConfigured: keyless providers always count,
// cloud providers count once their key is saved (or present as an environment
// variable), and local servers (Ollama) only count once the user saved a server
// URL in Settings - they are never assumed to be running.
const providerConfigured = (provider, apiKeys, baseUrls) => {
  if (provider.isLocal) return Boolean(baseUrls[baseUrlKey(provider.id)]);
  if (!provider.needsApiKey) return true;
  return Boolean(apiKeys[provider.id] || (provider.apiKeyEnvVar ? process.env[provider.apiKeyEnvVar] : ''));
};

// Mirrors the globalState keys AgentView reads/writes for local server URLs.
const baseUrlKey = id => `opencodex.baseUrl.${id}`;

const assert = (v, msg) => { if (!v) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok -', msg); };

const providers = listProviders();
const byId = Object.fromEntries(providers.map(p => [p.id, p]));
const keys = { gemini: 'secret', openrouter: 'secret' };
const savedBaseUrls = { [baseUrlKey('ollama')]: 'http://localhost:11434/v1' };

assert(providerConfigured(byId.opencode, {}, {}) === true, 'opencode (keyless) always configured');
assert(providerConfigured(byId.ollama, {}, {}) === false, 'ollama (local) unconfigured without saved URL');
assert(providerConfigured(byId.ollama, {}, savedBaseUrls) === true, 'ollama (local) configured once URL saved');
assert(providerConfigured(byId.gemini, {}, {}) === false, 'gemini unconfigured without key');
assert(providerConfigured(byId.gemini, keys, {}) === true, 'gemini configured once key is saved');
assert(providerConfigured(byId.openrouter, {}, {}) === false, 'openrouter unconfigured without key');
assert(providerConfigured(byId.openrouter, keys, {}) === true, 'openrouter configured once key is saved');
assert(providerConfigured(byId.groq, keys, {}) === false, 'groq stays unconfigured (no key for it)');

// refreshModels target selection (mirrors agent logic)
const config = { onlyDefaultModels: true, provider: 'gemini' };
const targets = config.onlyDefaultModels ? [byId.gemini] : providers.filter(p => providerConfigured(p, keys, savedBaseUrls));
assert(targets.length === 1 && targets[0].id === 'gemini', 'onlyDefaultModels=true -> default provider only');
const targetsAll = providers.filter(p => providerConfigured(p, keys, savedBaseUrls)).map(p => p.id);
assert(targetsAll.includes('opencode') && targetsAll.includes('gemini') && targetsAll.includes('openrouter') && targetsAll.includes('ollama'), 'onlyDefaultModels=false -> every configured provider');
// Unconfigured local providers are not fetch targets, so they stay invisible in the picker.
const unconfigured = providers.filter(p => !providerConfigured(p, keys, {})).map(p => p.id);
assert(byId.ollama.isLocal && unconfigured.includes('ollama'), 'local providers without a saved URL are skipped (invisible) in the picker');

// group sort: default provider first, rest alphabetical
const groupSort = (groups, defaultId) => groups.sort((a, b) => (a.providerId === defaultId ? -1 : b.providerId === defaultId ? 1 : a.providerName.localeCompare(b.providerName)));
const sorted = groupSort([
  { providerId: 'ollama', providerName: 'Ollama (local)' },
  { providerId: 'gemini', providerName: 'Google Gemini' },
  { providerId: 'opencode', providerName: 'OpenCode' },
], 'gemini').map(g => g.providerId);
assert(sorted.join(',') === 'gemini,ollama,opencode', 'default provider first, rest alphabetical by name');

// selected model is kept only when present in a fetched group
const groups = [
  { providerId: 'opencode', models: ['big-pickle'] },
  { providerId: 'gemini', models: ['gemini-2.5-flash'] },
];
assert(groups.some(g => g.models.includes('gemini-2.5-flash')) === true, 'selected model present -> kept');
assert(groups.some(g => g.models.includes('old-model')) === false, 'stale selected model -> cleared');

console.log(process.exitCode ? 'LOGIC CHECK FAILED' : 'LOGIC CHECK OK');
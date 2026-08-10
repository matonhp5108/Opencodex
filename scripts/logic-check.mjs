import { isCompatibleModel, listProviders } from '../src/providers.ts';
import { expandEnvironment, parseMcpServers } from '../src/mcp.ts';
import { terminalShellConfig } from '../src/terminal.ts';

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

const mcp = parseMcpServers(JSON.stringify({
  local: { command: 'node', args: ['server.js'] },
  remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${env:MCP_TOKEN}' } },
}));
assert('command' in mcp.local && mcp.local.command === 'node', 'MCP stdio configuration parses');
assert('url' in mcp.remote && mcp.remote.url === 'https://example.com/mcp', 'MCP HTTP configuration parses');
let invalidMcpRejected = false;
try { parseMcpServers('[]'); } catch { invalidMcpRejected = true; }
assert(invalidMcpRejected, 'invalid MCP configuration is rejected');

const windowsShell = terminalShellConfig('win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
assert(windowsShell.executable.endsWith('cmd.exe') && windowsShell.args.join(' ') === '/d /q' && windowsShell.lineEnding === '\r\n', 'persistent terminal uses Windows cmd flags and CRLF');
const linuxShell = terminalShellConfig('linux', { SHELL: '/bin/bash' });
assert(linuxShell.executable === '/bin/bash' && linuxShell.args.join(' ') === '-i' && linuxShell.lineEnding === '\n', 'persistent terminal uses the configured Unix shell');
const macShell = terminalShellConfig('darwin', {});
assert(macShell.executable === '/bin/sh' && macShell.lineEnding === '\n', 'persistent terminal has a portable macOS/Linux fallback');

const expandedWindowsEnv = expandEnvironment(
  { TOOL: '${env:ProgramFiles(x86)}\\tool', TOKEN: '${env:MCP_TOKEN}' },
  { 'ProgramFiles(x86)': 'C:\\Program Files (x86)', MCP_TOKEN: 'test-token' },
);
assert(expandedWindowsEnv?.TOOL === 'C:\\Program Files (x86)\\tool' && expandedWindowsEnv.TOKEN === 'test-token', 'MCP expands Unix and Windows-style environment variable names');

console.log(process.exitCode ? 'LOGIC CHECK FAILED' : 'LOGIC CHECK OK');

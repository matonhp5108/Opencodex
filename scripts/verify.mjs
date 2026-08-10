import { readFileSync } from 'node:fs';

const raw = readFileSync('src/webview.ts', 'utf8');
const match = raw.match(/<script nonce="\$\{nonce\}">([\s\S]*?)<\/script>/);
if (!match) throw new Error('script block not found');
const js = match[1]
  .replaceAll('${gitTracked}', 'true')
  .replaceAll('${markUri}', 'mark')
  .replaceAll('${nonce}', 'x');
await import('node:child_process').then(({ execFileSync }) => {
  execFileSync(process.execPath, ['--check', '--input-type=module', '-'], { input: js, stdio: 'pipe' });
  console.log('webview JS: syntax OK');
});

const src = readFileSync('src/providers.ts', 'utf8');
const nonTextMatch = src.match(/const NON_TEXT = (.*);/);
if (!nonTextMatch) throw new Error('NON_TEXT regex not found');
const NON_TEXT = new Function(`return ${nonTextMatch[1]}`)();
const isText = id => !NON_TEXT.test(id);

const cases = [
  ['gemini-2.5-flash', true],
  ['gemini-2.5-flash-image', false],
  ['gemini-2.0-flash', true],
  ['gemma-3-27b-it', true],
  ['whisper-large-v3-turbo', false],
  ['nomic-embed-text', false],
  ['text-embedding-3-small', false],
  ['llama-3.2-11b-vision-instruct', false],
  ['mistral-small-latest', true],
  ['gpt-4o', true],
  ['qwen2.5-vl-7b', false],
  ['glm-4v', false],
  ['flux-1-schnell', false],
  ['claude-3.5-sonnet:free', true],
  ['deepseek/deepseek-chat-v3:free', true],
  ['grok-3-mini', true],
  ['imagen-3.0-generate', false],
  ['llama-3.3-70b', true],
];
let failed = 0;
for (const [id, expected] of cases) {
  const got = isText(id);
  if (got !== expected) { failed++; console.log(`FAIL ${id}: expected ${expected}, got ${got}`); }
}
if (failed) throw new Error(`${failed} filter case(s) failed`);
console.log(`text filter: ${cases.length} cases OK`);

if (raw.includes('Toggle active file context')) throw new Error('active-file context chip is still present');
if (!raw.includes('projectIndicatorName.textContent=editorContext.activeFile||projectIndicatorFolder')) {
  throw new Error('project indicator does not prefer the active file path');
}
if (!raw.includes('includeActiveFile:true')) throw new Error('active-file context is not always enabled');
console.log('active-file context UI: path indicator and always-on delivery OK');

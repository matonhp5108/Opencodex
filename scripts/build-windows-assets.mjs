import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePng = join(root, 'media', 'opencodex-notification.png');
const outDir = join(root, 'native', 'windows');
const outIco = join(outDir, 'opencodex.ico');

mkdirSync(outDir, { recursive: true });

const resized = join(tmpdir(), `opencodex-icon-${Date.now()}.png`);
try {
  execFileSync('sips', ['-z', '256', '256', sourcePng, '--out', resized], { stdio: 'pipe' });
} catch {
  copyFileSync(sourcePng, resized);
}

const png = readFileSync(resized);
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(1, 4);

const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0);
entry.writeUInt8(0, 1);
entry.writeUInt8(0, 2);
entry.writeUInt8(0, 3);
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12);

writeFileSync(outIco, Buffer.concat([header, entry, png]));
rmSync(resized, { force: true });
console.log(`Wrote ${outIco}`);

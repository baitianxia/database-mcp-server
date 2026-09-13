import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDirectory, '..');
const output = path.join(root, 'release-baseline.json');
const ignored = new Set(['node_modules', 'dist', '.git', '.pnpm-store', '.mcp.json']);

async function walk(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.isFile() && entry.name !== 'release-baseline.json') files.push(full);
  }
  return files;
}

const files = [];
for (const fullPath of await walk(root)) {
  const relative = path.relative(root, fullPath).split(path.sep).join('/');
  const digest = crypto.createHash('sha256').update(await fs.readFile(fullPath)).digest('hex');
  files.push({ path: relative, sha256: digest });
}
files.sort((left, right) => left.path.localeCompare(right.path));
const material = files.map((file) => `${file.sha256}  ${file.path}`).join('\n');
const revision = crypto.createHash('sha256').update(material).digest('hex');
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const document = {
  baselineVersion: 1,
  product: packageJson.name,
  packageVersion: packageJson.version,
  revision,
  generatedAt: new Date().toISOString(),
  source: 'local content digest (supplemental to the Git commit)',
  files,
};
await fs.writeFile(output, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(`${output}\n${revision}`);

#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(root, 'dist', 'src', 'cli.js'))) {
  console.error(`token-inspectour is not built yet. From ${root} run:\n\n  npm install\n\nthen try again (npm install compiles the TypeScript sources into dist/).`);
  process.exit(1);
}
const { main } = await import('../dist/src/cli.js');
main(process.argv.slice(2)).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});

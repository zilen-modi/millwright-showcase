#!/usr/bin/env node
// Validate every Autopilot config file against its Zod schema. Run before a session or in
// CI to catch drift (bad mode, missing _default rate, malformed JSON) with a clear message.
//
// Usage:  node millwright/scripts/validate-config.mjs   (or: npm run validate)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ConfigSchema, CostModelSchema, QueueSchema, RepoManifestSchema } from '../schemas.mjs';

const CONFIG = join(dirname(fileURLToPath(import.meta.url)), '..', 'config');
const checks = [
  ['config.json', ConfigSchema],
  ['cost-model.json', CostModelSchema],
  ['queue.json', QueueSchema],
  ['repo-manifest.json', RepoManifestSchema],
];

let ok = true;
for (const [file, schema] of checks) {
  const path = join(CONFIG, file);
  try {
    const res = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (res.success) {
      console.log(`✓ ${file}`);
    } else {
      ok = false;
      console.error(`✗ ${file}`);
      for (const i of res.error.issues) console.error(`    - ${i.path.join('.') || '(root)'}: ${i.message}`);
    }
  } catch (e) {
    ok = false;
    console.error(`✗ ${file} — ${e.message}`);
  }
}
console.log(ok ? '\nAll config valid.' : '\nConfig validation FAILED.');
process.exit(ok ? 0 : 1);

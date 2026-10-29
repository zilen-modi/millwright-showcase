// Where the headless secrets live. One answer, shared by everything that needs them.
//
// This exists because the project was renamed and the file moved with it, but the code did not:
// `scripts/jira.mjs` and `dashboard/server.mjs` each hardcoded `config/autopilot.env`, so the
// panel reported "NPM_TOKEN not found" while pointing at a filename that no longer described
// reality. It only kept working because the old file was still lying around — deleting it, the
// obvious tidy-up after a rename, would have broken Jira auth everywhere.
//
// So: resolve by trying, newest name first, and let callers report the path they actually used
// rather than a name baked into a string.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Candidate filenames, in preference order. Add to the front when the project is renamed. */
export const ENV_FILENAMES = ['millwright.env', 'autopilot.env'];

/**
 * The secrets file to read, or the preferred path when none exists yet (so an error message can
 * name the file the operator should create).
 *
 * @param {string} root repo root
 * @returns {{ path: string, exists: boolean, legacy: boolean }}
 */
export function resolveEnvFile(root) {
  const dir = join(root, 'config');
  for (const [index, name] of ENV_FILENAMES.entries()) {
    const path = join(dir, name);
    if (existsSync(path)) return { path, exists: true, legacy: index > 0 };
  }
  return { path: join(dir, ENV_FILENAMES[0]), exists: false, legacy: false };
}

/** The matching `.example`, for "copy this and fill it in" messages. */
export function resolveEnvExample(root) {
  const dir = join(root, 'config');
  for (const name of ENV_FILENAMES) {
    const path = join(dir, `${name}.example`);
    if (existsSync(path)) return path;
  }
  return join(dir, `${ENV_FILENAMES[0]}.example`);
}

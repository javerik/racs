// Fails unless both libraries carry the RACS version (Cargo.toml), ng-racs-ui peer-depends on the
// same ng-racs-core minor, and, on a tag (CI_COMMIT_TAG / GITHUB_REF_NAME or the first argument),
// the tag names that version.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const cargo = readFileSync(join(web, '../Cargo.toml'), 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
const pkg = (name) => JSON.parse(readFileSync(join(web, 'projects', name, 'package.json'), 'utf8'));
const core = pkg('ng-racs-core');
const ui = pkg('ng-racs-ui');
const tag = process.argv[2] ?? process.env.CI_COMMIT_TAG ?? (process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined);

const errors = [];
if (core.version !== cargo) errors.push(`ng-racs-core is ${core.version}, Cargo.toml ${cargo}`);
if (ui.version !== cargo) errors.push(`ng-racs-ui is ${ui.version}, Cargo.toml ${cargo}`);
if (ui.peerDependencies?.['ng-racs-core'] !== `~${cargo}`) {
  errors.push(`ng-racs-ui peer-depends on ng-racs-core ${ui.peerDependencies?.['ng-racs-core']}, expected ~${cargo}`);
}
if (tag && tag.replace(/^v/, '') !== cargo) errors.push(`tag ${tag} does not name version ${cargo}`);
if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log(`ng-racs-core and ng-racs-ui ${cargo}${tag ? ` (tag ${tag})` : ''}`);

// #3458 (part of #3444): the assistant environment's setup script, run for
// real with bash. A local directory stands in for the download host. No
// browser, no server. The point is that it fails closed: a tampered or missing
// file leaves nothing installed and a non-zero exit, so the session never starts.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROGRAM_FILES, buildSetupScript } from '../scripts/assistant-environment-lib.mjs';
import { finish } from './helpers.mjs';

let pass = true;
const check = (ok, msg) => { if (!ok) { pass = false; console.log(`FAIL check: ${msg}`); } };
const sha = (text) => createHash('sha256').update(text).digest('hex');
const COMMIT = 'b'.repeat(40);
const CONTENT = Object.fromEntries(PROGRAM_FILES.map((name) => [name, `// ${name}\nconsole.log('${name}');\n`]));
const SUMS = Object.fromEntries(PROGRAM_FILES.map((name) => [name, sha(CONTENT[name])]));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-env-'));
const script = path.join(tmp, 'setup.sh');
fs.writeFileSync(script, buildSetupScript({ commit: COMMIT, files: SUMS }));

const run = (source, install) => spawnSync('bash', [script], { encoding: 'utf8', env: { ...process.env, ASSISTANT_PROGRAMS_BASE: `file://${source}`, ASSISTANT_DIR: install } });
const makeSource = (overrides = {}) => {
  const dir = fs.mkdtempSync(path.join(tmp, 'src-'));
  for (const name of PROGRAM_FILES) fs.writeFileSync(path.join(dir, name), overrides[name] ?? CONTENT[name]);
  return dir;
};
const freshInstall = () => path.join(fs.mkdtempSync(path.join(tmp, 'dst-')), 'assistant');

check(spawnSync('bash', ['-n', script]).status === 0, 'bash accepts the generated script as valid syntax');

// Installs read-only; a second run changes nothing.
{
  const source = makeSource();
  const install = freshInstall();
  const first = run(source, install);
  check(first.status === 0, `first run succeeds (${first.stderr.trim().slice(0, 200)})`);
  check(JSON.stringify(fs.readdirSync(install).sort()) === JSON.stringify(['.commit', ...PROGRAM_FILES].sort()), 'the install holds the commit marker and exactly the programs');
  check(fs.readFileSync(path.join(install, '.commit'), 'utf8').trim() === COMMIT, 'the commit marker names the pinned commit');
  check((fs.statSync(path.join(install, 'assistant-shift.mjs')).mode & 0o222) === 0, 'installed files are read-only');
  const second = run(source, install);
  check(second.status === 0 && /already at/.test(second.stdout), `a second run is a no-op (${second.stdout.trim()})`);
}

// Tampered file: fail closed.
{
  const source = makeSource({ 'assistant-reply.mjs': 'process.exit(0) // not what was reviewed\n' });
  const install = freshInstall();
  const result = run(source, install);
  check(result.status !== 0 && /checksum mismatch/.test(result.stderr), `a tampered file fails with a checksum message (${result.stderr.trim().slice(0, 200)})`);
  check(!fs.existsSync(install), 'nothing is installed after a tampered download');
}

// Missing file: fail closed.
{
  const source = makeSource();
  fs.rmSync(path.join(source, 'assistant-shift.mjs'));
  const install = freshInstall();
  check(run(source, install).status !== 0 && !fs.existsSync(install), 'a missing download fails and installs nothing');
}

// An edited install is replaced by the pinned files.
{
  const source = makeSource();
  const install = freshInstall();
  run(source, install);
  fs.chmodSync(install, 0o755);
  fs.chmodSync(path.join(install, 'assistant-lib.mjs'), 0o644);
  fs.writeFileSync(path.join(install, 'assistant-lib.mjs'), '// edited in place\n');
  const again = run(source, install);
  check(again.status === 0 && fs.readFileSync(path.join(install, 'assistant-lib.mjs'), 'utf8') === CONTENT['assistant-lib.mjs'], `an edited install is restored (${again.stderr.trim().slice(0, 200)})`);
}

spawnSync('chmod', ['-R', 'u+w', tmp]);
fs.rmSync(tmp, { recursive: true, force: true });
await finish({ close: async () => {} }, { pass, label: '#3458: the assistant environment setup script installs only checksummed files and fails closed' });

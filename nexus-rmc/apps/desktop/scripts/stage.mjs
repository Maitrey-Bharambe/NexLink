/**
 * Stages everything the installer ships besides the UI:
 *   stage/server  — control server source + production node_modules + @nexus/protocol
 *   stage/agent   — NexLinkAgent.exe (if it was built with `npm run build:agent`)
 * electron-builder copies these into <install>/resources (see package.json "build").
 */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(desktop, '..', '..');
const stage = path.join(desktop, 'stage');
const cp = (from, to) => fs.cpSync(from, to, { recursive: true });

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(stage, 'server'), { recursive: true });
fs.mkdirSync(path.join(stage, 'agent'), { recursive: true });

// Server: source + a package.json without workspace/dev dependencies.
cp(path.join(repo, 'apps', 'server', 'src'), path.join(stage, 'server', 'src'));
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'apps', 'server', 'package.json'), 'utf8'));
delete pkg.dependencies['@nexus/protocol'];
delete pkg.devDependencies;
pkg.scripts = { start: 'node src/index.js' };
fs.writeFileSync(path.join(stage, 'server', 'package.json'), JSON.stringify(pkg, null, 2));
console.log('Installing server production dependencies…');
execSync('npm install --omit=dev --no-audit --no-fund --no-package-lock', { cwd: path.join(stage, 'server'), stdio: 'inherit' });
cp(path.join(repo, 'packages', 'protocol'), path.join(stage, 'server', 'node_modules', '@nexus', 'protocol'));
fs.rmSync(path.join(stage, 'server', 'node_modules', '@nexus', 'protocol', 'src', 'index.test.js'), { force: true });

// Agent installer offered to managed PCs from the hub.
const agentExe = path.join(repo, 'apps', 'agent', 'dist', 'NexLinkAgent.exe');
if (fs.existsSync(agentExe)) {
  fs.copyFileSync(agentExe, path.join(stage, 'agent', 'NexLinkAgent.exe'));
  console.log('Staged NexLinkAgent.exe');
} else {
  console.warn('NexLinkAgent.exe not found — run `npm run build:agent` first to bundle it.');
}
console.log(`Staged into ${stage}`);

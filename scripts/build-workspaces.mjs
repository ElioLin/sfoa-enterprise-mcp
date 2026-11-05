import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Yarn's resolved workspace graph includes local dev dependencies and excludes
 * version-mismatched packages installed from the registry. Keep those semantics. */
export function buildOrder(workspaces) {
  const order = [], active = new Set(), done = new Set();
  function visit(name) {
    if (done.has(name)) return;
    if (!workspaces[name]) throw new Error(`Missing workspace dependency: ${name}`);
    if (active.has(name)) throw new Error(`Workspace dependency cycle: ${[...active, name].join(' -> ')}`);
    active.add(name);
    for (const dependency of workspaces[name].workspaceDependencies) visit(dependency);
    active.delete(name);
    done.add(name);
    order.push(name);
  }
  for (const name of Object.keys(workspaces)) visit(name);
  return order;
}

export function buildWorkspaces(root, yarnPath) {
  if (!yarnPath) throw new Error('Run this command through yarn build (Yarn Classic).');
  // Launch Yarn's JS entry with the current Node, including on Windows. No shell
  // concatenation, platform-specific .cmd execution, or new build dependency.
  const info = spawnSync(process.execPath, [yarnPath, '--silent', 'workspaces', 'info', '--json'], {
    cwd: root, encoding: 'utf8', windowsHide: true,
  });
  if (info.error) throw info.error;
  if (info.status !== 0) {
    process.stderr.write(info.stderr ?? '');
    return info.status ?? 1;
  }
  const workspaces = JSON.parse(info.stdout);
  const order = buildOrder(workspaces);
  const skipped = [];
  for (const name of order) {
    const manifest = JSON.parse(readFileSync(resolve(root, workspaces[name].location, 'package.json'), 'utf8'));
    if (!manifest.scripts?.build) {
      skipped.push(name);
      continue;
    }
    console.log(`Building ${name}`);
    const result = spawnSync(process.execPath, [yarnPath, 'workspace', name, 'run', 'build'], {
      cwd: root, stdio: 'inherit', windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
  }
  console.log(`Built ${order.length - skipped.length} workspaces; no build script: ${skipped.join(', ') || '(none)'}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = buildWorkspaces(process.cwd(), process.env.npm_execpath); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}

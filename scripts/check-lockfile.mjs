import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { projectRoot, workspaceInfo } from './build-workspaces.mjs';

// Yarn Classic can resolve missing workspace selectors during a frozen install without saving them.
// Check exact manifest selectors as well; a satisfying range entry is not the same lock key.
export function lockedSelectors(text) {
  const selectors = new Set();
  for (const line of text.split(/\r?\n/u)) {
    if (!line || /^\s|^#/u.test(line) || !line.endsWith(':')) continue;
    const header = line.slice(0, -1);
    let index = 0;
    while (index < header.length) {
      while (header[index] === ' ' || header[index] === ',') index += 1;
      const start = index;
      if (header[index] === '"') {
        index += 1;
        while (index < header.length && header[index] !== '"') {
          if (header[index] === '\\') index += 1;
          index += 1;
        }
        index += 1;
        selectors.add(JSON.parse(header.slice(start, index)));
      } else {
        while (index < header.length && header[index] !== ',') index += 1;
        selectors.add(header.slice(start, index).trim());
      }
    }
  }
  return selectors;
}

export function missingSelectors(manifests, selectors) {
  const missing = [];
  for (const { name, manifest, localDependencies = [] } of manifests) {
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [dependency, version] of Object.entries(manifest[section] ?? {})) {
        if (localDependencies.includes(dependency)) continue;
        const selector = `${dependency}@${version}`;
        if (!selectors.has(selector)) missing.push(`${name}: ${selector}`);
      }
    }
  }
  return missing;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const info = workspaceInfo();
    const manifests = [{ name: 'root', manifest: JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) }];
    for (const [name, entry] of Object.entries(info)) manifests.push({
      name, manifest: JSON.parse(readFileSync(path.join(projectRoot, entry.location, 'package.json'), 'utf8')),
      localDependencies: entry.workspaceDependencies,
    });
    const missing = missingSelectors(manifests, lockedSelectors(readFileSync(path.join(projectRoot, 'yarn.lock'), 'utf8')));
    if (missing.length) throw new Error(`Missing exact lock selectors (${missing.length}):\n${missing.join('\n')}`);
    process.stdout.write(`Lock selectors cover root and all ${Object.keys(info).length} workspaces.\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolves the SFoA monorepo root from a module located below packages/<name>.
 * The result is independent of the process working directory.
 */
export function resolveSfoaProjectRoot(moduleUrl: string | URL = import.meta.url): string {
  const modulePath = path.normalize(fileURLToPath(moduleUrl));
  const marker = `${path.sep}packages${path.sep}`;
  const markerIndex = modulePath.toLocaleLowerCase('en-US').lastIndexOf(marker);
  if (markerIndex <= 0) {
    throw new Error('Cannot resolve the SFoA project root: module is not below packages/<name>.');
  }
  return path.resolve(modulePath.slice(0, markerIndex));
}

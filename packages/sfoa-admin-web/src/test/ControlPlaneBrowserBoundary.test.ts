import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest serves modules over its own scheme, so `import.meta.url` is not a file: URL here.
// The package test script runs from the package root; the positive control below fails loudly
// if that ever stops being true.
const SRC = path.resolve(process.cwd(), 'src');

/**
 * The package root barrel re-exports `admin-service.js`, whose top level imports `node:crypto`.
 * In a browser that is fatal: Vite replaces node builtins with a shim that throws on property
 * access, so merely loading the barrel kills the module graph and the Console renders blank.
 *
 * Two things make this failure quiet, which is why it needs a test rather than care:
 * the production build tree-shakes the unused re-export away, so `yarn build` is green, and
 * jsdom runs in Node, so the unit suite is green too. It only appears in a real browser.
 *
 * `@sfoa/control-plane/contracts` and `@sfoa/control-plane/admin-contracts` are pure zod plus
 * types and stay importable; so does a type-only import from the root, which is erased.
 */
const STATIC = /(?:^|\n)[\t ]*(import|export)[\t ]+(type[\t ]+)?([^;]*?)from[\t ]*(['"])@sfoa\/control-plane\4/gu;
const DYNAMIC = /import\([\t ]*['"]@sfoa\/control-plane['"][\t ]*\)/gu;
// Held in a constant so this file's own offender messages cannot match the patterns above and
// report the guard as a violation of itself.
const BARE = '@sfoa/control-plane';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry): string[] => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/u.test(entry.name) ? [full] : [];
  });
}

describe('ADR-0034 Console browser boundary', () => {
  it('allows only type-only or subpath imports from @sfoa/control-plane', () => {
    const files = sourceFiles(SRC);
    // Positive control: a walk that silently returned nothing would pass vacuously.
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((file) => file.endsWith('consoleModules.ts'))).toBe(true);

    const offenders: string[] = [];
    for (const file of files) {
      const where = path.relative(SRC, file);
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(STATIC)) {
        // Group 2 is present only for `import type` / `export type`, which the compiler erases.
        if (match[2] === undefined) offenders.push(`${where}: ${match[1]} ... from '${BARE}'`);
      }
      for (const _match of text.matchAll(DYNAMIC)) {
        offenders.push(`${where}: dynamic import('${BARE}')`);
      }
    }

    expect(offenders).toEqual([]);
  });
});

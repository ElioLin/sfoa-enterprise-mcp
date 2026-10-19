import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Ask Yarn Classic, rather than approximating its workspace globs or prerelease semver rules.
export function yarnInvocation(args) {
  if (process.env.npm_execpath?.endsWith('.js')) {
    return { command: process.execPath, args: [process.env.npm_execpath, ...args], shell: false };
  }
  return { command: process.platform === 'win32' ? 'yarn.cmd' : 'yarn', args, shell: process.platform === 'win32' };
}

export function workspaceInfo(root = projectRoot) {
  const invocation = yarnInvocation(['--silent', 'workspaces', 'info', '--json']);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: root, shell: invocation.shell, encoding: 'utf8', windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Yarn workspace discovery failed (${result.status}): ${result.stderr}`);
  return JSON.parse(result.stdout);
}

export function loadBuildGraph(root = projectRoot, info = workspaceInfo(root)) {
  const graph = new Map();
  for (const [name, entry] of Object.entries(info).sort(([a], [b]) => a.localeCompare(b))) {
    const directory = path.resolve(root, entry.location);
    const manifest = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (manifest.name !== name) throw new Error(`Workspace name mismatch: ${name} at ${directory}`);
    graph.set(name, { name, directory, manifest, dependencies: new Set(entry.workspaceDependencies) });
  }
  const ownerOf = (filename) => [...graph.values()].find((entry) => {
    const relative = path.relative(entry.directory, filename);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  });
  for (const entry of graph.values()) {
    const addPathDependency = (filename, source) => {
      if (!existsSync(filename)) throw new Error(`${entry.name}: missing ${source} ${filename}`);
      const owner = ownerOf(filename);
      if (!owner) throw new Error(`${entry.name}: ${source} is outside discovered workspaces: ${filename}`);
      if (owner.name !== entry.name) entry.dependencies.add(owner.name);
      return owner;
    };
    const configs = readdirSync(entry.directory).filter((name) => /^tsconfig(?:\..+)?\.json$/u.test(name));
    if (configs.length > 0) {
      const ts = createRequire(path.join(entry.directory, 'package.json'))('typescript');
      const visited = new Set();
      const readConfig = (filename) => {
        if (visited.has(filename)) return;
        visited.add(filename);
        const result = ts.parseConfigFileTextToJson(filename, readFileSync(filename, 'utf8'));
        if (result.error) throw new Error(`${entry.name}: invalid TypeScript config ${filename}`);
        for (const reference of result.config.references ?? []) {
          let target = path.resolve(path.dirname(filename), reference.path);
          if (existsSync(target) && statSync(target).isDirectory()) target = path.join(target, 'tsconfig.json');
          addPathDependency(target, 'TypeScript reference');
        }
        for (const parent of [result.config.extends ?? []].flat()) {
          if (parent.startsWith('.')) {
            let target = path.resolve(path.dirname(filename), parent);
            if (!target.endsWith('.json')) target += '.json';
            readConfig(target);
          }
        }
      };
      for (const config of configs) readConfig(path.join(entry.directory, config));
    }
    const visitedTasks = new Set();
    const readWireit = (taskName) => {
      if (visitedTasks.has(taskName)) return;
      visitedTasks.add(taskName);
      for (const dependency of entry.manifest.wireit?.[taskName]?.dependencies ?? []) {
        const spec = typeof dependency === 'string' ? dependency : dependency.script;
        const separator = spec.lastIndexOf(':');
        if (separator < 0) readWireit(spec);
        else {
          const target = path.resolve(entry.directory, spec.slice(0, separator));
          const owner = addPathDependency(path.join(target, 'package.json'), 'Wireit dependency');
          const script = spec.slice(separator + 1);
          if (!owner.manifest.scripts?.[script]) throw new Error(`${entry.name}: missing Wireit script ${spec}`);
        }
      }
    };
    // Include build lifecycle prerequisites without replacing the package's own lifecycle.
    for (const task of ['prebuild', 'build', 'postbuild']) readWireit(task);
  }
  return graph;
}

export function planBuilds(graph, targets = [...graph.keys()]) {
  const ordered = [];
  const done = new Set();
  const visiting = [];
  const visit = (name) => {
    if (done.has(name)) return;
    const entry = graph.get(name);
    if (!entry) throw new Error(`Missing workspace: ${name}`);
    if (visiting.includes(name)) throw new Error(`Build dependency cycle: ${[...visiting, name].join(' -> ')}`);
    visiting.push(name);
    for (const dependency of [...entry.dependencies].sort()) visit(dependency);
    visiting.pop();
    done.add(name);
    ordered.push(entry);
  };
  for (const target of [...targets].sort()) visit(target);
  return ordered;
}

export async function executeBuilds(plan, run = runWorkspaceBuild) {
  for (const entry of plan) {
    if (!entry.manifest.scripts?.build) {
      // Asset/config-only workspaces remain visible in the complete plan.
      process.stdout.write(`[BUILD] ${entry.name}: no build script; nothing to execute\n`);
      continue;
    }
    process.stdout.write(`[BUILD] ${entry.name}\n`);
    const code = await run(entry);
    if (code !== 0) {
      const error = new Error(`Build failed: ${entry.name} (exit ${code})`);
      error.exitCode = code;
      throw error;
    }
  }
}

function runWorkspaceBuild(entry) {
  const invocation = yarnInvocation(['workspace', entry.name, 'run', 'build']);
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: projectRoot, shell: invocation.shell, stdio: 'inherit', windowsHide: true,
    });
    const stop = (signal) => child.kill(signal);
    const interrupt = () => stop('SIGINT');
    const terminate = () => stop('SIGTERM');
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    const cleanup = () => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
    };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('exit', (code) => { cleanup(); resolve(code ?? 1); });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const printPlan = args.includes('--plan');
    const targetIndex = args.indexOf('--target');
    if (args.some((arg, index) => arg !== '--plan' && arg !== '--target' && !(targetIndex >= 0 && index === targetIndex + 1))) {
      throw new Error('Usage: build-workspaces.mjs [--target sfoa|<workspace>] [--plan]');
    }
    if (targetIndex >= 0 && !args[targetIndex + 1]) throw new Error('--target requires a workspace or sfoa');
    const graph = loadBuildGraph();
    const target = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
    const targets = target === 'sfoa' ? [...graph.keys()].filter((name) => name.startsWith('@sfoa/'))
      : target ? [target] : [...graph.keys()];
    const plan = planBuilds(graph, targets);
    process.stdout.write(`[BUILD] ${plan.length}/${graph.size} workspaces: ${plan.map((entry) => entry.name).join(' -> ')}\n`);
    if (!printPlan) await executeBuilds(plan);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error.exitCode ?? 1;
  }
}

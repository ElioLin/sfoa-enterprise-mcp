import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  findProjectRoot,
  loadProjectEnvironment,
  parseCliArguments,
  readWorkspacePackages,
  runCommand,
  sanitizeForOutput,
} from './lib/project.mjs';

export async function createProjectSnapshot(projectRoot, environment) {
  const rootManifest = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const packages = await readWorkspacePackages(projectRoot);
  const migrations = (await readdir(path.join(projectRoot, 'packages', 'sfoa-control-plane', 'migrations')))
    .filter((name) => /^\d+_.+\.sql$/u.test(name)).sort();
  const [branch, commit, status] = await Promise.all([
    runCommand('git', ['branch', '--show-current'], { cwd: projectRoot }),
    runCommand('git', ['rev-parse', '--short', 'HEAD'], { cwd: projectRoot }),
    runCommand('git', ['status', '--porcelain=v1'], { cwd: projectRoot }),
  ]);
  const officialCatalog = await readFile(path.join(projectRoot, 'packages', 'sfoa-mcp-server', 'src', 'official-tool-catalog.ts'), 'utf8');
  const dmlProvider = await readFile(path.join(projectRoot, 'packages', 'mcp-provider-sfoa-dml', 'src', 'provider.ts'), 'utf8');
  const contextProvider = await readFile(path.join(projectRoot, 'packages', 'mcp-provider-sfoa-context', 'src', 'provider.ts'), 'utf8');
  const agentCapabilities = await readFile(path.join(projectRoot, 'packages', 'sfoa-agent-playbook', 'src', 'capabilities.ts'), 'utf8');
  return Object.freeze(sanitizeForOutput({
    generatedAt: new Date().toISOString(),
    repository: {
      root: projectRoot,
      branch: branch.ok ? branch.stdout : null,
      commit: commit.ok ? commit.stdout : null,
      dirtyEntries: status.ok ? status.stdout.split(/\r?\n/u).filter(Boolean).length : null,
    },
    workspace: {
      rootName: rootManifest.name,
      patterns: rootManifest.workspaces?.packages ?? [],
      nohoist: rootManifest.workspaces?.nohoist ?? [],
      packages,
    },
    rootScripts: Object.freeze(Object.fromEntries(Object.entries(rootManifest.scripts ?? {}).sort(([left], [right]) => left.localeCompare(right, 'en-US')))),
    migrations: Object.freeze(migrations),
    toolCatalog: {
      officialPolicyNames: Object.freeze(extractNamedTools(officialCatalog)),
      sfoaDmlTools: Object.freeze(extractObjectKeys(dmlProvider, 'SFOA_DML_TOOL_OPERATIONS')),
      sfoaContextTools: Object.freeze(extractObjectKeys(contextProvider, 'SFOA_CONTEXT_TOOL_ROLES')),
      agentInfrastructureTools: Object.freeze(extractStringArray(agentCapabilities, 'AGENT_INFRASTRUCTURE_TOOL_NAMES')),
      evidenceSources: Object.freeze([
        'packages/sfoa-mcp-server/src/official-tool-catalog.ts',
        'packages/mcp-provider-sfoa-dml/src/provider.ts',
        'packages/mcp-provider-sfoa-context/src/provider.ts',
        'packages/sfoa-agent-playbook/src/capabilities.ts',
      ]),
    },
  }, environment));
}

function extractNamedTools(source) {
  return [...new Set([...source.matchAll(/\bname:\s*'([^']+)'/gu)].map((match) => match[1]))].sort();
}

function extractObjectKeys(source, constantName) {
  const body = new RegExp(`(?:export\\s+)?const\\s+${constantName}[^=]*=\\s*(?:Object\\.freeze\\()?\\s*\\{([\\s\\S]*?)\\}\\)?`, 'u').exec(source)?.[1] ?? '';
  return [...body.matchAll(/^\s*([a-z][a-z0-9_]*)\s*:/gmu)].map((match) => match[1]).sort();
}

function extractStringArray(source, constantName) {
  const body = new RegExp(`(?:export\\s+)?const\\s+${constantName}[^=]*=\\s*(?:Object\\.freeze\\()?\\[([\\s\\S]*?)\\](?:\\))?`, 'u').exec(source)?.[1] ?? '';
  return [...body.matchAll(/'([^']+)'/gu)].map((match) => match[1]).sort();
}

async function main() {
  const arguments_ = parseCliArguments(process.argv.slice(2));
  const projectRoot = arguments_['project-root'] ? path.resolve(String(arguments_['project-root'])) : await findProjectRoot();
  const environment = await loadProjectEnvironment(projectRoot);
  process.stdout.write(`${JSON.stringify(await createProjectSnapshot(projectRoot, environment), null, 2)}\n`);
}

const isCli = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isCli) main().catch((error) => {
  process.stderr.write(`[project-snapshot] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

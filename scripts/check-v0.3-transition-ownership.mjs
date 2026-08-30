import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(option('repo-root') ?? process.cwd());
const repositoryRealRoot = await realpath(repositoryRoot);
const manifestPath = resolveOptionPath(option('manifest') ?? 'resources/authority/v0.3-transition-ownership-v1.json');
const completedThrough = requiredOption('completed-through');
const diagnosticsFile = option('diagnostics-file');

// 背景：全仓当前无法通过普通 build，但 transition gate 自身必须能在干净检出中独立运行。
// 目的：package script 先单独编译纯 tooling 模块，本脚本只加载该编译产物并对真实 tsc 输出执行门禁。
// 上下文：该模块不进入 package root exports，也不授予任何业务写入能力。
const toolingModulePath = new URL('../dist/src/tooling/diagnostic-ownership.js', import.meta.url);
const {
  canonicalRepositoryRelativePath,
  evaluateTransitionOwnership,
  extractExplicitPlanPaths,
  findUnparsedTypeScriptDiagnosticLines,
  parseTypeScriptDiagnosticHeadlines,
} = await import(toolingModulePath.href);

const manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
const ownership = await loadOwnership(manifest);
const diagnosticsText = diagnosticsFile === undefined
  ? runTypeScriptCompiler()
  : await readFile(resolveOptionPath(diagnosticsFile), 'utf8');
const unparsedDiagnosticLines = findUnparsedTypeScriptDiagnosticLines(diagnosticsText);
if (unparsedDiagnosticLines.length > 0) {
  fail(`TRANSITION_OWNERSHIP_UNPARSED_DIAGNOSTIC: ${unparsedDiagnosticLines[0]}`);
}
const diagnostics = parseTypeScriptDiagnosticHeadlines(diagnosticsText);
const result = evaluateTransitionOwnership({
  completedThrough,
  diagnostics,
  ownership,
  baselineDiagnosticCounts: manifest.baseline.diagnosticCounts,
});

const output = {
  schemaVersion: 1,
  completedThrough,
  diagnostics: result.diagnostics,
  files: result.files,
  futureOwned: summarize(result.futureOwned),
  pastOwner: summarize(result.pastOwnerDiagnostics),
  unowned: summarize(result.unownedDiagnostics),
  executionBlocked: summarize(result.executionBlockedDiagnostics),
  openOwnership: { entries: result.openPastOwnership.length },
  closedWithDiagnostics: summarize(result.closedDiagnostics),
  regressions: result.regressions,
};
process.stdout.write(`${JSON.stringify(output)}\n`);
process.exit(result.ok ? 0 : 1);

function option(name) {
  const prefix = `--${name}=`;
  const matches = process.argv.slice(2).filter((argument) => argument.startsWith(prefix));
  if (matches.length > 1) fail(`TRANSITION_OWNERSHIP_DUPLICATE_OPTION: --${name}`);
  return matches[0]?.slice(prefix.length);
}

function requiredOption(name) {
  const value = option(name);
  if (!value) fail(`TRANSITION_OWNERSHIP_MISSING_OPTION: --${name}`);
  return value;
}

function resolveOptionPath(value) {
  return isAbsolute(value) ? value : resolve(repositoryRoot, value);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('TRANSITION_OWNERSHIP_MANIFEST_INVALID: root');
  }
  if (value.schemaVersion !== 1) fail('TRANSITION_OWNERSHIP_MANIFEST_INVALID: schemaVersion');
  if (!value.baseline || typeof value.baseline !== 'object' || Array.isArray(value.baseline)) {
    fail('TRANSITION_OWNERSHIP_MANIFEST_INVALID: baseline');
  }
  if (
    !Array.isArray(value.planFiles)
    || !Array.isArray(value.overlapOwners)
    || !Array.isArray(value.supplemental)
    || !Array.isArray(value.closed)
  ) {
    fail('TRANSITION_OWNERSHIP_MANIFEST_INVALID: ownership arrays');
  }
  const counts = value.baseline.diagnosticCounts;
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    fail('TRANSITION_OWNERSHIP_MANIFEST_INVALID: diagnosticCounts');
  }
  const countEntries = Object.entries(counts);
  if (countEntries.some(([, count]) => !Number.isSafeInteger(count) || count < 0)) {
    fail('TRANSITION_OWNERSHIP_MANIFEST_INVALID: diagnostic count');
  }
  for (const [path] of countEntries) canonicalManifestPath(path, 'baseline diagnostic path');
  const diagnosticTotal = countEntries.reduce((total, [, count]) => total + count, 0);
  if (diagnosticTotal !== value.baseline.diagnostics || countEntries.length !== value.baseline.files) {
    fail('TRANSITION_OWNERSHIP_MANIFEST_INVALID: baseline totals');
  }
  return value;
}

async function loadOwnership(manifestValue) {
  const phaseOrder = new Map(
    ['P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09']
      .map((phase, index) => [phase, index]),
  );
  const planClaims = new Map();
  const supplementalActions = new Set([
    'REPAIR',
    'MIGRATE_OR_DELETE',
    'EXCLUDE_UNCHANGED',
  ]);
  for (const row of manifestValue.planFiles) {
    if (!row || typeof row !== 'object' || typeof row.owner !== 'string' || typeof row.path !== 'string') {
      fail('TRANSITION_OWNERSHIP_MANIFEST_INVALID: planFiles row');
    }
    const currentOrder = phaseOrder.get(row.owner);
    if (currentOrder === undefined || row.owner === 'P01') {
      fail(`TRANSITION_OWNERSHIP_MANIFEST_INVALID: plan owner ${row.owner}`);
    }
    const planDocumentPath = canonicalManifestPath(row.path, 'planFiles path');
    const markdown = await readRepositoryPlan(planDocumentPath);
    for (const path of extractExplicitPlanPaths(markdown)) {
      const owners = planClaims.get(path) ?? new Set();
      owners.add(row.owner);
      planClaims.set(path, owners);
    }
  }

  const overlapOwners = new Map();
  for (const row of manifestValue.overlapOwners) {
    if (
      !row
      || typeof row !== 'object'
      || typeof row.path !== 'string'
      || typeof row.owner !== 'string'
      || !phaseOrder.has(row.owner)
      || row.owner === 'P01'
    ) {
      fail('TRANSITION_OWNERSHIP_MANIFEST_INVALID: overlapOwners row');
    }
    const path = canonicalManifestPath(row.path, 'overlap owner path');
    if (overlapOwners.has(path)) {
      fail(`TRANSITION_OWNERSHIP_DUPLICATE_OVERLAP_OWNER: ${path}`);
    }
    overlapOwners.set(path, row.owner);
  }

  const planned = new Map();
  for (const [path, owners] of planClaims) {
    const ownerClaims = [...owners];
    const explicitOwner = overlapOwners.get(path);
    if (ownerClaims.length > 1 && explicitOwner === undefined) {
      fail(`TRANSITION_OWNERSHIP_AMBIGUOUS_PLAN_PATH: ${path}`);
    }
    if (explicitOwner !== undefined && !owners.has(explicitOwner)) {
      fail(`TRANSITION_OWNERSHIP_INVALID_OVERLAP_OWNER: ${path} -> ${explicitOwner}`);
    }
    if (ownerClaims.length === 1 && explicitOwner !== undefined) {
      fail(`TRANSITION_OWNERSHIP_UNEXPECTED_OVERLAP_OWNER: ${path}`);
    }
    const owner = explicitOwner ?? ownerClaims[0];
    if (owner === undefined) fail(`TRANSITION_OWNERSHIP_MISSING_PLAN_OWNER: ${path}`);
    planned.set(path, { path, owner, action: 'REPAIR' });
    overlapOwners.delete(path);
  }
  const unusedOverlapPath = overlapOwners.keys().next().value;
  if (unusedOverlapPath !== undefined) {
    fail(`TRANSITION_OWNERSHIP_UNKNOWN_OVERLAP_PATH: ${unusedOverlapPath}`);
  }

  for (const row of manifestValue.supplemental) {
    if (
      !row
      || typeof row !== 'object'
      || typeof row.path !== 'string'
      || typeof row.owner !== 'string'
      || typeof row.action !== 'string'
    ) {
      fail('TRANSITION_OWNERSHIP_MANIFEST_INVALID: supplemental row');
    }
    if (!phaseOrder.has(row.owner) || row.owner === 'P01') {
      fail(`TRANSITION_OWNERSHIP_MANIFEST_INVALID: supplemental owner ${row.owner}`);
    }
    if (!supplementalActions.has(row.action)) {
      fail(`TRANSITION_OWNERSHIP_MANIFEST_INVALID: supplemental action ${row.action}`);
    }
    const path = canonicalManifestPath(row.path, 'supplemental path');
    if (planned.has(path)) {
      fail(`TRANSITION_OWNERSHIP_DUPLICATE_PATH: ${path}`);
    }
    planned.set(path, { ...row, path });
  }

  const closedPaths = new Set();
  for (const rawPath of manifestValue.closed) {
    if (typeof rawPath !== 'string' || rawPath.length === 0) {
      fail('TRANSITION_OWNERSHIP_MANIFEST_INVALID: closed path');
    }
    const path = canonicalManifestPath(rawPath, 'closed path');
    if (closedPaths.has(path)) {
      fail(`TRANSITION_OWNERSHIP_DUPLICATE_CLOSED_PATH: ${path}`);
    }
    closedPaths.add(path);
    const existing = planned.get(path);
    if (!existing) fail(`TRANSITION_OWNERSHIP_UNKNOWN_CLOSED_PATH: ${path}`);
    planned.set(path, { ...existing, action: 'CLOSED' });
  }
  return [...planned.values()];
}

function canonicalManifestPath(value, context) {
  let canonical;
  try {
    canonical = canonicalRepositoryRelativePath(value);
  } catch {
    fail(`TRANSITION_OWNERSHIP_INVALID_REPOSITORY_PATH: ${context}: ${value}`);
  }
  if (canonical !== value) {
    fail(`TRANSITION_OWNERSHIP_NON_CANONICAL_PATH: ${context}: ${value}`);
  }
  return canonical;
}

async function readRepositoryPlan(path) {
  const candidate = resolve(repositoryRoot, path);
  const actual = await realpath(candidate);
  const relativePath = relative(repositoryRealRoot, actual);
  if (
    relativePath === '..'
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    fail(`TRANSITION_OWNERSHIP_PLAN_PATH_OUTSIDE_REPOSITORY: ${path}`);
  }
  return readFile(actual, 'utf8');
}

function runTypeScriptCompiler() {
  const tscPath = require.resolve('typescript/lib/tsc.js');
  const result = spawnSync(process.execPath, [
    tscPath,
    '-p',
    resolve(repositoryRoot, 'tsconfig.json'),
    '--noEmit',
    '--pretty',
    'false',
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`TRANSITION_OWNERSHIP_TSC_FAILED: ${result.error.message}`);
  if (result.signal) fail(`TRANSITION_OWNERSHIP_TSC_SIGNAL: ${result.signal}`);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status === 0) return output;
  if (result.status !== 2 || parseTypeScriptDiagnosticHeadlines(output).length === 0) {
    process.stderr.write(output);
    fail(`TRANSITION_OWNERSHIP_TSC_FAILED: exit ${result.status}`);
  }
  return output;
}

function summarize(groups) {
  return {
    diagnostics: groups.reduce((total, group) => total + group.count, 0),
    files: groups.length,
  };
}

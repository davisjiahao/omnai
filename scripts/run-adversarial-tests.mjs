import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

const sourceDirectory = resolve('test');
const compiledDirectory = resolve('dist/test');
const tag = '[adversarial]';
const runnableCalls = new Set(['describe', 'it', 'test']);
const declarationModifiers = new Set(['only', 'skip', 'todo']);
const summaryKeys = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];

async function relativeFilesUnder(directory, suffix) {
  const files = [];
  async function visit(currentDirectory, prefix) {
    let entries;
    try {
      entries = await readdir(currentDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const relativeName = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await visit(resolve(currentDirectory, entry.name), relativeName);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        files.push(relativeName);
      }
    }
  }
  await visit(directory, '');
  return files;
}

function isTestDeclarationCall(expression) {
  if (ts.isIdentifier(expression)) return runnableCalls.has(expression.text);
  if (!ts.isPropertyAccessExpression(expression)) return false;
  if (runnableCalls.has(expression.name.text)) return true;
  return declarationModifiers.has(expression.name.text) && isTestDeclarationCall(expression.expression);
}

function hasAdversarialDeclaration(contents, scriptKind) {
  const sourceFile = ts.createSourceFile(
    'adversarial-discovery',
    contents,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  let found = false;
  function visit(node) {
    if (found) return;
    if (
      ts.isCallExpression(node)
      && isTestDeclarationCall(node.expression)
      && node.arguments.length > 0
      && (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
      && node.arguments[0].text.startsWith(tag)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

function fail(message, output = '') {
  if (output.length > 0) process.stderr.write(output.endsWith('\n') ? output : `${output}\n`);
  console.error(message);
  process.exit(1);
}

function parseTapSummary(output) {
  const summary = Object.fromEntries(summaryKeys.map((key) => [key, undefined]));
  for (const line of output.split(/\r?\n/u)) {
    const match = /^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/u.exec(line);
    if (match) summary[match[1]] = Number(match[2]);
  }
  if (summaryKeys.some((key) => !Number.isSafeInteger(summary[key]))) return undefined;
  return summary;
}

function matchingPassCount(output) {
  return output.split(/\r?\n/u).filter((line) => (
    /^\s*ok\s+\d+\s+-\s+\[adversarial\]/u.test(line)
    && !/#\s*(?:SKIP|TODO)\b/iu.test(line)
  )).length;
}

const sourceNames = await relativeFilesUnder(sourceDirectory, '.test.ts');
const taggedSources = [];
for (const name of sourceNames) {
  const contents = await readFile(resolve(sourceDirectory, name), 'utf8');
  if (hasAdversarialDeclaration(contents, ts.ScriptKind.TS)) taggedSources.push(name);
}

const taggedSourceSet = new Set(taggedSources);
const compiledNames = await relativeFilesUnder(compiledDirectory, '.test.js');
const compiledNameSet = new Set(compiledNames);
for (const name of compiledNames) {
  const contents = await readFile(resolve(compiledDirectory, name), 'utf8');
  const sourceName = name.replace(/\.js$/u, '.ts');
  if (
    hasAdversarialDeclaration(contents, ts.ScriptKind.JS)
    && !taggedSourceSet.has(sourceName)
  ) {
    fail(`Stale compiled [adversarial] marker: ${name} has no tagged source declaration`);
  }
}

if (taggedSources.length === 0) {
  fail(`No runnable [adversarial] source tests found under ${sourceDirectory}`);
}

for (const sourceName of taggedSources) {
  const compiledName = sourceName.replace(/\.ts$/u, '.js');
  if (!compiledNameSet.has(compiledName)) {
    fail(`Missing compiled counterpart for tagged source ${sourceName}`);
  }
}

console.error(`Adversarial source files: ${taggedSources.length}`);
const aggregate = Object.fromEntries(summaryKeys.map((key) => [key, 0]));
const childEnvironment = { ...process.env };
delete childEnvironment.NODE_TEST_CONTEXT;

for (const sourceName of taggedSources) {
  const compiledName = sourceName.replace(/\.ts$/u, '.js');
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=tap',
      '--test-name-pattern=\\[adversarial\\]',
      resolve(compiledDirectory, compiledName),
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: childEnvironment,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error) fail(`Unable to execute tagged source ${sourceName}: ${result.error.message}`, output);
  const summary = parseTapSummary(output);
  if (!summary) fail(`Tagged source ${sourceName} produced no complete TAP summary`, output);
  const matchingPasses = matchingPassCount(output);
  if (
    result.status !== 0
    || summary.fail !== 0
    || summary.cancelled !== 0
    || summary.skipped !== 0
    || summary.todo !== 0
  ) {
    fail(`Tagged source ${sourceName} failed adversarial TAP requirements`, output);
  }
  if (matchingPasses === 0 || summary.tests === 0 || summary.pass === 0) {
    fail(`Tagged source ${sourceName} contributed zero passing [adversarial] tests`, output);
  }
  for (const key of summaryKeys) aggregate[key] += summary[key];
  console.error(
    `${sourceName}: tests ${summary.tests}, pass ${summary.pass}, fail ${summary.fail}, `
    + `cancelled ${summary.cancelled}, skipped ${summary.skipped}, todo ${summary.todo}`,
  );
}

console.error(
  `Adversarial aggregate: files ${taggedSources.length}, tests ${aggregate.tests}, `
  + `pass ${aggregate.pass}, fail ${aggregate.fail}, cancelled ${aggregate.cancelled}, `
  + `skipped ${aggregate.skipped}, todo ${aggregate.todo}`,
);

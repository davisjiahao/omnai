import { spawnSync } from 'node:child_process';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const repositoryRoot = process.cwd();
const source = resolve(repositoryRoot, 'native/verified-fd-provider/verified_fd_provider.c');
const compiler = '/usr/bin/cc';
const productionOutput = resolve(repositoryRoot, 'dist/native/verified_fd_provider.node');
const testHarness = process.argv.slice(2).includes('--test-harness');

if (process.argv.slice(2).some((argument) => argument !== '--test-harness')) {
  fail('BUILD_NATIVE_PROVIDER_ARGUMENTS: only --test-harness is accepted');
}

if (testHarness) {
  await buildPrivateHarness();
} else {
  await compileShared(productionOutput, []);
}

async function buildPrivateHarness() {
  const buildIdentity = basename(repositoryRoot).replace(/[^A-Za-z0-9._-]/gu, '_');
  const root = join(tmpdir(), `omnai-verified-fd-provider-${buildIdentity}`);
  const candidateRoot = join(root, 'candidates');
  const controlRoot = join(root, 'control');
  const localCandidate = join(candidateRoot, 'usr/local/bin/git');
  const systemCandidate = join(candidateRoot, 'usr/bin/git');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await compileShared(join(root, 'verified_fd_provider_test.node'), [
    '-DVERIFIED_PROVIDER_TESTING=1',
    quotedDefine('VERIFIED_PROVIDER_CANDIDATE_LOCAL', localCandidate),
    quotedDefine('VERIFIED_PROVIDER_CANDIDATE_SYSTEM', systemCandidate),
    quotedDefine('VERIFIED_PROVIDER_CONTROL_ROOT', controlRoot),
  ]);
  await compileExecutable(join(root, 'safe-git'), [
    '-DVERIFIED_PROVIDER_FIXTURE_SAFE=1',
    quotedDefine('VERIFIED_PROVIDER_CONTROL_ROOT', controlRoot),
  ]);
  await compileExecutable(join(root, 'malicious-git'), [
    '-DVERIFIED_PROVIDER_FIXTURE_MALICIOUS=1',
    quotedDefine('VERIFIED_PROVIDER_CONTROL_ROOT', controlRoot),
  ]);
  await makeFifo(join(root, 'fifo-git'));
}

async function compileShared(output, defines) {
  await compile(output, [
    '-std=c11',
    '-O2',
    '-fPIC',
    '-shared',
    '-Wall',
    '-Wextra',
    '-Werror',
    '-pthread',
    ...defines,
    source,
  ]);
}

async function compileExecutable(output, defines) {
  await compile(output, [
    '-std=c11',
    '-O2',
    '-Wall',
    '-Wextra',
    '-Werror',
    ...defines,
    source,
  ]);
}

async function compile(output, argumentsBeforeOutput) {
  await mkdir(resolve(output, '..'), { recursive: true });
  const temporary = `${output}.tmp-${process.pid}`;
  await rm(temporary, { force: true });
  const result = spawnSync(compiler, [...argumentsBeforeOutput, '-o', temporary], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined || result.status !== 0) {
    await rm(temporary, { force: true });
    fail(`BUILD_NATIVE_PROVIDER_COMPILE: ${result.error?.message ?? result.stderr.trim()}`);
  }
  await rename(temporary, output);
}

async function makeFifo(output) {
  await rm(output, { force: true });
  const result = spawnSync('/usr/bin/mkfifo', [output], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error !== undefined || result.status !== 0) {
    fail(`BUILD_NATIVE_PROVIDER_FIFO: ${result.error?.message ?? result.stderr.trim()}`);
  }
}

function quotedDefine(name, value) {
  if (!value.startsWith('/') || value.includes('"') || value.includes('\\')) {
    fail(`BUILD_NATIVE_PROVIDER_DEFINE: ${name}`);
  }
  return `-D${name}="${value}"`;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

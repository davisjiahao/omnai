import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DefaultArtifactClient } from '@actions/artifact';

if (process.env.GITHUB_ACTIONS !== 'true') {
  console.log('Temporary dependency relay only runs inside GitHub Actions.');
  process.exit(0);
}

const repository = 'davisjiahao/omnai';
const baselineSha = '14479f4d02f49ca132f76774791552fc59bc6037';
const rawBase = `https://raw.githubusercontent.com/${repository}/${baselineSha}`;
const relayRoot = await mkdtemp(join(tmpdir(), 'omnai-dependency-relay-'));
const baselineDir = join(relayRoot, 'baseline');
const executionDir = join(relayRoot, 'execution');
const nodeMajor = process.versions.node.split('.')[0];
const npmExecPath = process.env.npm_execpath;

if (!npmExecPath) {
  throw new Error('npm_execpath is unavailable inside npm postinstall');
}

async function restoreManifest(directory, fileName) {
  const response = await fetch(`${rawBase}/${fileName}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${fileName} from ${baselineSha}: ${response.status}`);
  }
  await writeFile(join(directory, fileName), await response.text());
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: {
      ...process.env,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
    },
    stdio: 'inherit',
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status}`);
  }
}

function runNpm(args, cwd) {
  run(process.execPath, [npmExecPath, ...args], cwd);
}

async function writeChecksum(archivePath, checksumPath) {
  const digest = createHash('sha256')
    .update(await readFile(archivePath))
    .digest('hex');
  await writeFile(checksumPath, `${digest}  ${basename(archivePath)}\n`);
}

await Promise.all([
  mkdir(baselineDir, { recursive: true }),
  mkdir(executionDir, { recursive: true }),
]);
await Promise.all([
  restoreManifest(baselineDir, 'package.json'),
  restoreManifest(baselineDir, 'package-lock.json'),
  restoreManifest(executionDir, 'package.json'),
  restoreManifest(executionDir, 'package-lock.json'),
]);

const artifact = new DefaultArtifactClient();

runNpm(['ci'], baselineDir);
const baselineArchive = join(relayRoot, 'omnai-baseline-dependencies.tgz');
const baselineChecksum = join(relayRoot, 'omnai-baseline-dependencies.sha256');
run('tar', ['-czf', baselineArchive, 'node_modules'], baselineDir);
await writeChecksum(baselineArchive, baselineChecksum);
const baselineUpload = await artifact.uploadArtifact(
  `omnai-baseline-node-${nodeMajor}`,
  [baselineArchive, baselineChecksum],
  relayRoot,
  { retentionDays: 1 },
);
console.log(`Uploaded baseline artifact ${baselineUpload.id} (${baselineUpload.size} bytes)`);

runNpm(
  ['install', 'xstate@^5.19.0', '@agentclientprotocol/sdk@^1.0.0'],
  executionDir,
);
const executionArchive = join(relayRoot, 'omnai-execution-dependencies.tgz');
const executionChecksum = join(relayRoot, 'omnai-execution-dependencies.sha256');
run(
  'tar',
  ['-czf', executionArchive, 'package.json', 'package-lock.json', 'node_modules'],
  executionDir,
);
await writeChecksum(executionArchive, executionChecksum);
const executionUpload = await artifact.uploadArtifact(
  `omnai-execution-node-${nodeMajor}`,
  [executionArchive, executionChecksum],
  relayRoot,
  { retentionDays: 1 },
);
console.log(`Uploaded execution artifact ${executionUpload.id} (${executionUpload.size} bytes)`);

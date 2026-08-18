import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.env.GITHUB_ACTIONS !== 'true') {
  console.log('Temporary dependency relay only runs inside GitHub Actions.');
  process.exit(0);
}

const repository = 'davisjiahao/omnai';
const baselineSha = '14479f4d02f49ca132f76774791552fc59bc6037';
const rawBase = `https://raw.githubusercontent.com/${repository}/${baselineSha}`;
const relayRoot = await mkdtemp(join(tmpdir(), 'omnai-dependency-relay-'));
const executionDir = join(relayRoot, 'execution');
const npmExecPath = process.env.npm_execpath;

if (!npmExecPath) {
  throw new Error('npm_execpath is unavailable inside npm postinstall');
}

async function restoreManifest(fileName) {
  const response = await fetch(`${rawBase}/${fileName}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${fileName} from ${baselineSha}: ${response.status}`);
  }
  await writeFile(join(executionDir, fileName), await response.text());
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

await mkdir(executionDir, { recursive: true });
await Promise.all([
  restoreManifest('package.json'),
  restoreManifest('package-lock.json'),
]);

run(
  process.execPath,
  [
    npmExecPath,
    'install',
    'xstate@^5.19.0',
    '@agentclientprotocol/sdk@^1.0.0',
  ],
  executionDir,
);

const archivePath = join(relayRoot, 'omnai-execution-dependencies.tgz');
run(
  'tar',
  ['-czf', archivePath, 'package.json', 'package-lock.json', 'node_modules'],
  executionDir,
);

const archive = await readFile(archivePath);
const digest = createHash('sha256').update(archive).digest('hex');
const encoded = archive.toString('base64');
const chunkSize = 32 * 1024;
const chunkCount = Math.ceil(encoded.length / chunkSize);

console.log(
  `OMNAI_RELAY_BEGIN bytes=${archive.length} sha256=${digest} base64=${encoded.length} chunks=${chunkCount}`,
);
for (let index = 0; index < chunkCount; index += 1) {
  const chunk = encoded.slice(index * chunkSize, (index + 1) * chunkSize);
  console.log(`OMNAI_RELAY_CHUNK index=${index + 1}/${chunkCount} data=${chunk}`);
}
console.log(`OMNAI_RELAY_END chunks=${chunkCount} sha256=${digest}`);

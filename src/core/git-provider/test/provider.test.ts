import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { before, beforeEach, test } from 'node:test';
import { TextDecoder } from 'node:util';
import {
  freezeProvider,
  type NativeProviderResult,
} from '../native-binding.js';
import {
  acquireGitProvider,
  GitProviderError,
  mapBeforeOwnerProviderFailure,
  runGit,
} from '../provider.js';
import {
  controlRoot,
  acquirePrivateProviderInWorker,
  executePrivateProviderInWorker,
  expectedEnvironment,
  installSafeLocalCandidate,
  installFifoLocalCandidate,
  loadPrivateNativeProvider,
  localCandidatePath,
  makeLocalCandidateDirectory,
  makeLocalCandidateGroupWritable,
  makeLocalCandidateMagicLinkComponent,
  makeLocalCandidateNonRootOwned,
  makeLocalCandidateSymlinkComponent,
  makeLocalCandidateWorldWritable,
  privateAddonPath,
  privateNativeRoot,
  readControl,
  replaceLocalCandidateWithMalicious,
  resetNativeFixture,
  setControl,
  waitForControl,
} from './provider-race-harness.js';

const utf8 = new TextDecoder('utf-8', { fatal: true });
const SHA_A = `sha256:${'a'.repeat(64)}`;

async function assertRecordedChildReaped(): Promise<void> {
  const child = (await readControl('last-child-pid')).trim();
  assert.match(child, /^[1-9][0-9]*$/u);
  assert.equal((await readControl('last-reaped-child-pid')).trim(), child);
  const recordedStartTime = processStartTime(await readControl('last-child-stat'));
  try {
    const current = await readFile(`/proc/${child}/stat`, 'utf8');
    assert.notEqual(
      processStartTime(current),
      recordedStartTime,
      `direct child identity ${child}:${recordedStartTime} still exists after provider return`,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function processStartTime(stat: string): string {
  const commandEnd = stat.lastIndexOf(')');
  assert.ok(commandEnd >= 0, 'proc stat command framing is missing');
  const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/u);
  const startTime = fieldsAfterCommand[19];
  assert.match(startTime ?? '', /^[0-9]+$/u, 'proc stat starttime is missing');
  return startTime as string;
}

before(async () => {
  assert.equal(process.platform, 'linux');
  assert.equal(process.getuid?.(), 0, 'native adversarial fixture requires root ownership');
  assert.ok(loadPrivateNativeProvider());
});

beforeEach(async () => {
  await resetNativeFixture();
});

test('production acquire uses only a compiled fixed candidate and returns a frozen strict binding', () => {
  const binding = acquireGitProvider();
  assert.equal(Object.isFrozen(binding), true);
  assert.equal(binding.schemaVersion, 1);
  assert.equal(binding.environmentProtocol, 'SANITIZED_GIT_ENV_V1');
  assert.equal(binding.executionProtocol, 'VERIFIED_FD_EXECVEAT_V1');
  assert.ok(['/usr/local/bin/git', '/usr/bin/git'].includes(binding.executableCandidatePath));
  assert.match(binding.executableRawBytesHash, /^sha256:[0-9a-f]{64}$/u);
  assert.match(binding.gitVersion, /^[0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?$/u);
  assert.match(binding.bindingHash, /^sha256:[0-9a-f]{64}$/u);
});

test('production execute uses the retained provider for repository discovery', () => {
  const binding = acquireGitProvider();
  const result = runGit(binding, {
    repositoryRoot: process.cwd(),
    args: ['rev-parse', '--show-toplevel'],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim(), resolve(process.cwd()));
});

test('native executable hash equals independently hashed raw candidate bytes', async () => {
  const binding = acquireGitProvider();
  const bytes = await readFile(binding.executableCandidatePath);
  const expected = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  assert.equal(binding.executableRawBytesHash, expected);
});

test('binding hash and every strict field are revalidated before execute', () => {
  const binding = acquireGitProvider();
  const tampered = { ...binding, gitVersion: '99.99.99' };
  assert.throws(
    () => runGit(tampered, { repositoryRoot: process.cwd(), args: ['--version'] }),
    (error: unknown) => error instanceof GitProviderError && error.code === 'GIT_PROVIDER_UNAVAILABLE',
  );
});

test('canonical version decoding rejects extra lines and noncanonical framing', () => {
  const values = [
    'git version 2.51.1',
    'git version 2.51.1\nextra\n',
    'Git version 2.51.1\n',
    'git version 02.51.1\n',
    'git version 2.51\n',
    'git version 2.51.1\u0000\n',
  ];
  for (const stdout of values) {
    const native: NativeProviderResult = {
      candidatePath: '/usr/bin/git',
      realPath: '/usr/bin/git',
      bytesHash: SHA_A,
      stdout: Buffer.from(stdout),
    };
    assert.throws(() => freezeProvider(native), /GIT_PROVIDER_UNAVAILABLE/u);
  }
});

test('absent fixed candidates fail before owner with the exact public code', () => {
  const native = loadPrivateNativeProvider();
  assert.throws(
    () => native.acquire(),
    (failure: unknown) => {
      const mapped = mapBeforeOwnerProviderFailure(failure);
      return mapped instanceof GitProviderError && mapped.code === 'GIT_PROVIDER_UNAVAILABLE';
    },
  );
});

test('acquire rejects a symlink path component', async () => {
  await makeLocalCandidateSymlinkComponent();
  assert.throws(() => loadPrivateNativeProvider().acquire(), /VERIFIED_PROVIDER_OPEN_CANDIDATE/u);
});

test('acquire rejects a procfs magic-link component', async () => {
  const close = await makeLocalCandidateMagicLinkComponent();
  try {
    assert.throws(() => loadPrivateNativeProvider().acquire(), /VERIFIED_PROVIDER_OPEN_CANDIDATE/u);
  } finally {
    await close();
  }
});

test('acquire rejects a non-root owner', async () => {
  await installSafeLocalCandidate();
  await makeLocalCandidateNonRootOwned();
  assert.throws(() => loadPrivateNativeProvider().acquire(), /VERIFIED_PROVIDER_VERIFY_METADATA/u);
});

test('acquire rejects group-writable executable bytes', async () => {
  await installSafeLocalCandidate();
  await makeLocalCandidateGroupWritable();
  assert.throws(() => loadPrivateNativeProvider().acquire(), /VERIFIED_PROVIDER_VERIFY_METADATA/u);
});

test('acquire rejects world-writable executable bytes', async () => {
  await installSafeLocalCandidate();
  await makeLocalCandidateWorldWritable();
  assert.throws(() => loadPrivateNativeProvider().acquire(), /VERIFIED_PROVIDER_VERIFY_METADATA/u);
});

test('acquire rejects a non-regular candidate node', async () => {
  await makeLocalCandidateDirectory();
  assert.throws(() => loadPrivateNativeProvider().acquire(), /VERIFIED_PROVIDER_VERIFY_METADATA/u);
});

test('acquire rejects a FIFO without waiting for a writer', async () => {
  await installFifoLocalCandidate();
  const acquisition = acquirePrivateProviderInWorker();
  const blocked = Symbol('blocked');
  const observed = await Promise.race([
    acquisition,
    new Promise<typeof blocked>((resolveBlocked) => setTimeout(() => resolveBlocked(blocked), 500)),
  ]);
  if (observed === blocked) {
    const writer = await open(localCandidatePath, 'w');
    assert.ok(writer);
    await writer.close();
    await acquisition;
  }
  assert.notEqual(observed, blocked, 'native acquire blocked opening a FIFO without a writer');
  assert.deepEqual(observed, { ok: false, code: 'VERIFIED_PROVIDER_VERIFY_METADATA' });
});

test('missing openat2 support fails closed without a pathname fallback', async () => {
  await installSafeLocalCandidate();
  await setControl('missing-openat2');
  assert.throws(() => loadPrivateNativeProvider().acquire(), /VERIFIED_PROVIDER_OPEN_CANDIDATE/u);
});

test('native acquire rejects invalid Git version framing before publishing a handle', async () => {
  await installSafeLocalCandidate();
  await setControl('invalid-version');
  assert.throws(() => loadPrivateNativeProvider().acquire(), /VERIFIED_PROVIDER_VERSION/u);
});

test('swap before execute is rejected by retained-fd stability before any child bytes exist', async () => {
  await installSafeLocalCandidate();
  const native = loadPrivateNativeProvider();
  native.acquire();
  await replaceLocalCandidateWithMalicious();

  assert.throws(
    () => native.execute({ repositoryRoot: '/', args: ['emit-safe'] }),
    /VERIFIED_PROVIDER_HASH_BYTES/u,
  );
  await assert.rejects(readControl('malicious-executed'), { code: 'ENOENT' });
});

test('swap during child wait never executes replacement and rejects captured output', async () => {
  await installSafeLocalCandidate();
  const native = loadPrivateNativeProvider();
  native.acquire();

  const execution = executePrivateProviderInWorker(['block-until-release']);
  await waitForControl('child-started');
  await replaceLocalCandidateWithMalicious();
  await setControl('child-release');

  assert.deepEqual(await execution, {
    ok: false,
    code: 'VERIFIED_PROVIDER_REOPEN_AND_COMPARE',
  });
  await assert.rejects(readControl('malicious-executed'), { code: 'ENOENT' });
});

test('poisoned parent variables cannot alter the exact thirteen-entry child environment', async () => {
  await installSafeLocalCandidate();
  const native = loadPrivateNativeProvider();
  native.acquire();

  const poison = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'alias.pwn',
    GIT_CONFIG_VALUE_0: '!false',
    GIT_ASKPASS: '/definitely/not/used',
    HOME: '/poisoned',
    LANG: 'poisoned',
    LD_PRELOAD: '/definitely/not/used.so',
  } as const;
  const searchVariable = ['PA', 'TH'].join('');
  const previous = new Map<string, string | undefined>();
  const poisonedEntries: ReadonlyArray<readonly [string, string]> = [
    ...Object.entries(poison),
    [searchVariable, '/poisoned'],
  ];
  for (const [key, value] of poisonedEntries) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    const result = native.execute({ repositoryRoot: '/', args: ['print-environment'] });
    assert.equal(result.exitCode, 0);
    assert.equal(utf8.decode(result.stderr), '');
    assert.deepEqual(JSON.parse(utf8.decode(result.stdout)), expectedEnvironment);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('bounded pipes reject output overflow instead of returning a prefix', async () => {
  await installSafeLocalCandidate();
  const native = loadPrivateNativeProvider();
  native.acquire();
  assert.throws(
    () => native.execute({ repositoryRoot: '/', args: ['overflow-output'] }),
    /VERIFIED_PROVIDER_OUTPUT_LIMIT/u,
  );
});

test('continuous output cannot starve overflow rejection and the total wait bound', async () => {
  await installSafeLocalCandidate();
  const native = loadPrivateNativeProvider();
  native.acquire();
  await setControl('hold-drain-after-overflow');
  const execution = executePrivateProviderInWorker(['overflow-output']);
  const blocked = Symbol('blocked');
  const observed = await Promise.race([
    execution,
    new Promise<typeof blocked>((resolveBlocked) => setTimeout(() => resolveBlocked(blocked), 500)),
  ]);
  if (observed === blocked) {
    await setControl('release-drain-after-overflow');
    await execution;
  }
  assert.notEqual(observed, blocked, 'continuous output kept drain_pipe from returning to timeout cleanup');
  assert.deepEqual(observed, { ok: false, code: 'VERIFIED_PROVIDER_OUTPUT_LIMIT' });
});

test('bounded wait terminates a non-completing child and returns no output', async () => {
  await installSafeLocalCandidate();
  const native = loadPrivateNativeProvider();
  native.acquire();
  await setControl('short-timeout');
  assert.throws(
    () => native.execute({ repositoryRoot: '/', args: ['never-complete'] }),
    /VERIFIED_PROVIDER_WAIT/u,
  );
});

test('bounded wait also covers output pipes retained by a completed child descendant', async () => {
  await installSafeLocalCandidate();
  const native = loadPrivateNativeProvider();
  native.acquire();
  await setControl('short-timeout');
  assert.throws(
    () => native.execute({ repositoryRoot: '/', args: ['descendant-holds-pipes'] }),
    /VERIFIED_PROVIDER_WAIT/u,
  );
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 500));
  await assert.rejects(readControl('descendant-survived-timeout'), { code: 'ENOENT' });
});

test('a signaled leader is kept as the process-group anchor until its closed-pipe descendant is terminated', async () => {
  await installSafeLocalCandidate();
  const native = loadPrivateNativeProvider();
  native.acquire();
  await setControl('record-child-pid');
  assert.throws(
    () => native.execute({ repositoryRoot: '/', args: ['signaled-leader-closed-descendant'] }),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'VERIFIED_PROVIDER_WAIT',
  );
  await assertRecordedChildReaped();
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 500));
  await assert.rejects(readControl('descendant-survived-signaled-leader'), { code: 'ENOENT' });
});

test('postcheck failure terminates a closed-pipe descendant before reaping its successful leader', async () => {
  await installSafeLocalCandidate();
  const native = loadPrivateNativeProvider();
  native.acquire();
  await setControl('record-child-pid');
  const execution = executePrivateProviderInWorker(['postcheck-closed-descendant']);
  await waitForControl('postcheck-child-started');
  await replaceLocalCandidateWithMalicious();
  await setControl('postcheck-child-release');
  assert.deepEqual(await execution, {
    ok: false,
    code: 'VERIFIED_PROVIDER_REOPEN_AND_COMPARE',
  });
  await assertRecordedChildReaped();
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 500));
  await assert.rejects(readControl('descendant-survived-postcheck'), { code: 'ENOENT' });
});

test('successful postcheck also terminates a closed-pipe descendant before accepting output', async () => {
  await installSafeLocalCandidate();
  const native = loadPrivateNativeProvider();
  native.acquire();
  await setControl('record-child-pid');
  const execution = executePrivateProviderInWorker(['postcheck-closed-descendant']);
  await waitForControl('postcheck-child-started');
  await setControl('postcheck-child-release');
  assert.deepEqual(await execution, {
    ok: true,
    result: {
      exitCode: 0,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
    },
  });
  await assertRecordedChildReaped();
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 500));
  await assert.rejects(readControl('descendant-survived-postcheck'), { code: 'ENOENT' });
});

test('EINTR while observing and reaping a child is retried without changing a Git result', async () => {
  await installSafeLocalCandidate();
  const native = loadPrivateNativeProvider();
  native.acquire();
  await setControl('record-child-pid');
  await setControl('interrupt-waitid-twice');
  await setControl('interrupt-waitpid-twice');
  const result = native.execute({ repositoryRoot: '/', args: ['emit-safe'] });
  assert.equal(result.exitCode, 0);
  assert.equal(utf8.decode(result.stdout), 'safe descriptor output\n');
  await assertRecordedChildReaped();
});

test('exec setup failure writes an exact error record after EINTR and always reaps the child', async () => {
  await installSafeLocalCandidate();
  const native = loadPrivateNativeProvider();
  native.acquire();
  await setControl('record-child-pid');
  await setControl('force-child-setup-failure');
  await setControl('interrupt-child-error-write');
  await setControl('partial-child-error-write');
  assert.throws(
    () => native.execute({ repositoryRoot: '/', args: ['emit-safe'] }),
    /VERIFIED_PROVIDER_EXECUTE_FD: native provider rejected operation \(errno=95\)/u,
  );
  await assertRecordedChildReaped();
});

test('acquire and execute reject extra callback-shaped arguments without observation', async () => {
  await installSafeLocalCandidate();
  let observations = 0;
  const unexpected = { observe: () => { observations += 1; } };
  assert.throws(() => loadPrivateNativeProvider().acquire(unexpected), /VERIFIED_PROVIDER_ARGUMENTS/u);
  assert.equal(observations, 0);
  await rm(controlRoot, { recursive: true, force: true });
  await rm(localCandidatePath, { force: true });
  assert.equal(observations, 0);
  assert.ok(privateAddonPath.startsWith(privateNativeRoot));
});

test('native execute rejects every caller-provided candidate-location field', async () => {
  await installSafeLocalCandidate();
  const native = loadPrivateNativeProvider();
  native.acquire();
  const input = {
    repositoryRoot: '/',
    args: ['emit-safe'],
    executablePath: '/tmp/attacker-controlled-git',
  };
  assert.throws(
    () => (native.execute as (value: unknown) => unknown)(input),
    /VERIFIED_PROVIDER_ARGUMENTS/u,
  );
});

test('native execute rejects non-enumerable and symbol own keys on inputs and argument arrays', async () => {
  await installSafeLocalCandidate();
  const native = loadPrivateNativeProvider();
  native.acquire();
  const hiddenInput = Object.defineProperty(
    { repositoryRoot: '/', args: ['emit-safe'] },
    'hiddenCandidatePath',
    { value: '/tmp/attacker-controlled-git' },
  );
  const symbolInput = {
    repositoryRoot: '/',
    args: ['emit-safe'],
    [Symbol('candidatePath')]: '/tmp/attacker-controlled-git',
  };
  const hiddenArguments = Object.defineProperty(['emit-safe'], 'hiddenArgument', { value: 'attacker' });
  const symbolArguments = Object.assign(['emit-safe'], { [Symbol('argument')]: 'attacker' });
  for (const input of [
    hiddenInput,
    symbolInput,
    { repositoryRoot: '/', args: hiddenArguments },
    { repositoryRoot: '/', args: symbolArguments },
  ]) {
    assert.throws(
      () => (native.execute as (value: unknown) => unknown)(input),
      /VERIFIED_PROVIDER_ARGUMENTS/u,
    );
  }
});

test('TypeScript strict boundaries reject hidden and symbol keys instead of projecting them away', () => {
  const binding = acquireGitProvider();
  const hiddenInput = Object.defineProperty(
    { repositoryRoot: process.cwd(), args: ['--version'] },
    'hiddenCandidatePath',
    { value: '/tmp/attacker-controlled-git' },
  );
  const symbolInput = {
    repositoryRoot: process.cwd(),
    args: ['--version'],
    [Symbol('candidatePath')]: '/tmp/attacker-controlled-git',
  };
  const hiddenArguments = Object.defineProperty(['--version'], 'hiddenArgument', { value: 'attacker' });
  const symbolArguments = Object.assign(['--version'], { [Symbol('argument')]: 'attacker' });
  for (const input of [
    hiddenInput,
    symbolInput,
    { repositoryRoot: process.cwd(), args: hiddenArguments },
    { repositoryRoot: process.cwd(), args: symbolArguments },
  ]) {
    assert.throws(
      () => runGit(binding, input),
      (error: unknown) => error instanceof GitProviderError && error.code === 'GIT_PROVIDER_UNAVAILABLE',
    );
  }

  const hiddenBinding = Object.defineProperty({ ...binding }, 'hiddenField', { value: 'attacker' });
  const symbolBinding = { ...binding, [Symbol('bindingField')]: 'attacker' };
  for (const candidate of [hiddenBinding, symbolBinding]) {
    assert.throws(
      () => runGit(candidate, { repositoryRoot: process.cwd(), args: ['--version'] }),
      (error: unknown) => error instanceof GitProviderError && error.code === 'GIT_PROVIDER_UNAVAILABLE',
    );
  }

  const nativeResult = {
    candidatePath: '/usr/bin/git',
    realPath: '/usr/bin/git',
    bytesHash: SHA_A,
    stdout: Buffer.from('git version 2.51.1\n'),
  } satisfies NativeProviderResult;
  const hiddenNativeResult = Object.defineProperty({ ...nativeResult }, 'hiddenField', { value: 'attacker' });
  const symbolNativeResult = { ...nativeResult, [Symbol('nativeField')]: 'attacker' };
  assert.throws(() => freezeProvider(hiddenNativeResult), /GIT_PROVIDER_UNAVAILABLE/u);
  assert.throws(() => freezeProvider(symbolNativeResult), /GIT_PROVIDER_UNAVAILABLE/u);
});

test('native execute rejects embedded NUL instead of truncating repository or arguments', async () => {
  await installSafeLocalCandidate();
  const native = loadPrivateNativeProvider();
  native.acquire();
  assert.throws(
    () => native.execute({ repositoryRoot: '/\u0000attacker-root', args: ['emit-safe'] }),
    /VERIFIED_PROVIDER_ARGUMENTS/u,
  );
  assert.throws(
    () => native.execute({ repositoryRoot: '/', args: ['emit-safe\u0000attacker-suffix'] }),
    /VERIFIED_PROVIDER_ARGUMENTS/u,
  );
});

test('bounded failure paths close every parent pipe descriptor', async () => {
  await installSafeLocalCandidate();
  const native = loadPrivateNativeProvider();
  native.acquire();
  const before = (await readdir('/proc/self/fd')).length;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.throws(
      () => native.execute({ repositoryRoot: '/', args: ['overflow-output'] }),
      /VERIFIED_PROVIDER_OUTPUT_LIMIT/u,
    );
  }
  await setControl('short-timeout');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.throws(
      () => native.execute({ repositoryRoot: '/', args: ['never-complete'] }),
      /VERIFIED_PROVIDER_WAIT/u,
    );
  }
  const after = (await readdir('/proc/self/fd')).length;
  assert.ok(after <= before + 1, `descriptor count grew from ${before} to ${after}`);
});

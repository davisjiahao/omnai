# AI Workspace VS Code Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a desktop VS Code extension that creates, resumes, displays, and safely finishes one requirement workspace containing Git worktrees from multiple independent repositories so one Codex IDE chat can work across them.

**Architecture:** A thin VS Code adapter owns prompts, commands, folder opening, and the Tree View. Platform-neutral services own configuration, Git process execution, durable state, context generation, creation transactions, rollback, resume, and finish behavior; all dependencies cross explicit TypeScript interfaces so core behavior is unit- and integration-testable without an Extension Host.

**Tech Stack:** TypeScript 7.0.2, Node.js 20.19+, VS Code Extension API 1.102, esbuild 0.28.2, Vitest 4.1.10, Mocha 11.8.0 with `@vscode/test-electron` 3.1.0, YAML 2.9.0, Zod 4.4.3, and the system Git CLI.

## Global Constraints

- The implementation target is a desktop workspace extension; do not implement a web extension or background daemon.
- Set `engines.vscode` to `^1.102.0`, development `engines.node` to `>=20.19.0`, and compile to ES2022/CommonJS.
- Use only stable VS Code APIs; do not enable proposed APIs or depend on undocumented Codex command IDs.
- Runtime dependencies are limited to `yaml@2.9.0` and `zod@4.4.3`; Git remains an external executable.
- Every Git/process call must use an executable plus argument array with `shell: false`; never build a shell command string.
- Support macOS, Linux, and Windows path/process behavior.
- A requirement ID is unique under one `workspaceRoot`; all selected repositories use the same rendered branch name.
- Every repository selects its own base ref, defaulting to that repository's remote trunk.
- Open the common requirement parent directory in a new VS Code window; do not generate a multi-root `.code-workspace` file.
- Keep each child as an independent Git repository with independent commit, push, and PR history.
- Never auto-clone, auto-commit, auto-push, create a PR, delete a pre-existing branch, or force-remove a worktree.
- Store no credentials in YAML, `.ai-workspace.json`, `AGENTS.md`, logs, or error messages.
- On repeated requirement IDs, resume the recorded workspace instead of creating duplicates.
- Use TDD for every behavior task and finish every task with the listed focused tests, full checks, and a commit.

## Execution Prerequisite

The current artifact directory is not a valid Git repository. Before executing Task 1, choose a real repository for the extension and copy both approved documents into it:

```text
docs/superpowers/specs/2026-08-14-vscode-multi-repo-codex-worktree-extension-design.md
docs/superpowers/plans/2026-08-14-vscode-multi-repo-codex-worktree-extension.md
```

Initialize a new repository only after the user authorizes that location. Once it has an initial documentation commit, use `superpowers:using-git-worktrees` to create the isolated implementation worktree before changing source files.

## Reference Documents

- Product design: `docs/superpowers/specs/2026-08-14-vscode-multi-repo-codex-worktree-extension-design.md`
- [VS Code Extension API](https://code.visualstudio.com/api/)
- [VS Code commands](https://code.visualstudio.com/api/extension-guides/command)
- [VS Code extension testing](https://code.visualstudio.com/api/working-with-extensions/testing-extension)
- [VS Code extension bundling](https://code.visualstudio.com/api/working-with-extensions/bundling-extension)
- [VS Code Git worktrees](https://code.visualstudio.com/docs/sourcecontrol/branches-worktrees)
- [Codex IDE extension](https://learn.chatgpt.com/docs/codex/ide)
- [Codex project-folder behavior](https://learn.chatgpt.com/docs/projects)
- [Codex `AGENTS.md`](https://learn.chatgpt.com/docs/agent-configuration/agents-md)

## Planned File Structure

```text
.
├── .github/workflows/ci.yml
├── .gitignore
├── .vscodeignore
├── CHANGELOG.md
├── README.md
├── esbuild.mjs
├── package-lock.json
├── package.json
├── tsconfig.json
├── tsconfig.vscode-test.json
├── vitest.config.ts
├── src/
│   ├── extension.ts
│   ├── domain/
│   │   ├── errors.ts
│   │   ├── types.ts
│   │   ├── validation.ts
│   │   └── validation.test.ts
│   ├── config/
│   │   ├── config-schema.ts
│   │   ├── config-service.ts
│   │   └── config-service.test.ts
│   ├── git/
│   │   ├── command-runner.ts
│   │   ├── command-runner.test.ts
│   │   ├── git-client.ts
│   │   ├── git-client.test.ts
│   │   ├── repository-service.ts
│   │   └── repository-service.test.ts
│   ├── state/
│   │   ├── state-schema.ts
│   │   ├── state-store.ts
│   │   └── state-store.test.ts
│   ├── context/
│   │   ├── agents-generator.ts
│   │   └── agents-generator.test.ts
│   ├── workspace/
│   │   ├── creation-planner.ts
│   │   ├── creation-planner.test.ts
│   │   ├── workspace-orchestrator.ts
│   │   ├── workspace-orchestrator.test.ts
│   │   ├── workspace-lifecycle.ts
│   │   └── workspace-lifecycle.test.ts
│   └── ui/
│       ├── codex-integration.ts
│       ├── codex-integration.test.ts
│       ├── command-controller.ts
│       ├── command-controller.test.ts
│       ├── new-requirement-wizard.ts
│       ├── new-requirement-wizard.test.ts
│       ├── vscode-ui.ts
│       ├── workspace-tree-provider.ts
│       └── workspace-tree-provider.test.ts
└── test/
    ├── helpers/git-fixture.ts
    ├── integration/multi-repo-workspace.test.ts
    └── vscode/
        ├── runTest.ts
        └── suite/
            ├── extension.test.ts
            └── index.ts
```

The files are split by responsibility: no UI module executes Git, no Git module imports `vscode`, and the orchestrator depends only on typed ports.

---

### Task 1: Bootstrap the Extension and Domain Contract

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `esbuild.mjs`
- Create: `.gitignore`
- Create: `src/extension.ts`
- Create: `src/domain/errors.ts`
- Create: `src/domain/types.ts`
- Create: `src/domain/validation.ts`
- Test: `src/domain/validation.test.ts`

**Interfaces:**
- Consumes: none.
- Produces: `AiWorkspaceError`, `Requirement`, `WorkspaceStatus`, `RepositoryStatus`, `EffectiveConfig`, `EffectiveRepositoryConfig`, `normalizeRequirementId(raw)`, `renderBranchName(pattern, requirementId)`, and `assertPathInside(root, candidate)`.

- [ ] **Step 1: Create package and compiler metadata**

Create `package.json` with this initial content; later UI tasks add command and view contributions:

```json
{
  "name": "ai-workspace",
  "displayName": "AI Workspace",
  "description": "Create one VS Code requirement workspace from worktrees across multiple Git repositories.",
  "version": "0.1.0",
  "publisher": "ai-workspace-tools",
  "license": "UNLICENSED",
  "engines": {
    "vscode": "^1.102.0",
    "node": ">=20.19.0"
  },
  "categories": ["Other", "SCM Providers"],
  "extensionKind": ["workspace"],
  "main": "./dist/extension.js",
  "scripts": {
    "build": "node esbuild.mjs",
    "watch": "node esbuild.mjs --watch",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "check": "npm run typecheck && npm test",
    "vscode:prepublish": "npm run build -- --production",
    "package": "npm run check && npm run build -- --production && vsce package"
  },
  "dependencies": {
    "yaml": "2.9.0",
    "zod": "4.4.3"
  },
  "devDependencies": {
    "@types/mocha": "10.0.10",
    "@types/node": "20.19.43",
    "@types/vscode": "1.102.0",
    "@vscode/test-electron": "3.1.0",
    "@vscode/vsce": "3.9.2",
    "esbuild": "0.28.2",
    "mocha": "11.8.0",
    "typescript": "7.0.2",
    "vitest": "4.1.10"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true,
    "types": ["node", "vscode", "vitest/globals"]
  },
  "include": ["src/**/*.ts", "vitest.config.ts"]
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['test/vscode/**', 'node_modules/**', 'dist/**'],
    testTimeout: 30_000
  }
});
```

Create `esbuild.mjs` with `src/extension.ts` as the bundled CommonJS entry, `vscode` as external, `dist/extension.js` as output, source maps outside production, and argument parsing for `--watch` and `--production`.

Use this esbuild body:

```js
import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const context = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'info'
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
```

Create `.gitignore`:

```text
node_modules/
dist/
out-test/
.vscode-test/
coverage/
*.vsix
```

Run `npm install` and commit the generated `package-lock.json`.

- [ ] **Step 2: Write failing domain validation tests**

Create `src/domain/validation.test.ts`:

```ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertPathInside,
  normalizeRequirementId,
  renderBranchName
} from './validation';

describe('normalizeRequirementId', () => {
  it('trims and accepts a portable requirement id', () => {
    expect(normalizeRequirementId(' REQ-123 ')).toBe('REQ-123');
  });

  it.each(['../REQ-1', 'REQ/1', '.', '..', 'CON', 'CON.txt', 'REQ.'])('rejects %s', value => {
    expect(() => normalizeRequirementId(value)).toThrow();
  });
});

it('renders one shared branch name', () => {
  expect(renderBranchName('feature/{requirementId}', 'REQ-123'))
    .toBe('feature/REQ-123');
});

it('rejects a target outside the workspace root', () => {
  const root = path.resolve('/safe/root');
  expect(() => assertPathInside(root, path.resolve('/outside/REQ-1'))).toThrow();
});
```

- [ ] **Step 3: Run the test and verify the expected failure**

Run: `npm test -- src/domain/validation.test.ts`

Expected: FAIL because `./validation` does not exist.

- [ ] **Step 4: Implement domain errors, types, and validation**

Create `src/domain/errors.ts`:

```ts
export type AiWorkspaceErrorCode =
  | 'VALIDATION'
  | 'CONFIG'
  | 'GIT'
  | 'LOCKED'
  | 'CONFLICT'
  | 'CANCELLED'
  | 'RECOVERY_REQUIRED';

export class AiWorkspaceError extends Error {
  constructor(
    public readonly code: AiWorkspaceErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'AiWorkspaceError';
  }
}
```

Create the initial contracts in `src/domain/types.ts`:

```ts
export interface Requirement {
  id: string;
  title: string;
}

export type WorkspaceStatus = 'creating' | 'ready' | 'recoveryRequired' | 'finished';
export type PublicationState = 'synced' | 'ahead' | 'no-upstream';

export interface RepositoryStatus {
  dirtyFileCount: number;
  upstream?: string;
  ahead: number;
  behind: number;
  publication: PublicationState;
}

export interface EffectiveRepositoryConfig {
  id: string;
  displayName: string;
  cloneUrl?: string;
  path?: string;
  remote: string;
}

export interface EffectivePresetConfig {
  id: string;
  name: string;
  repositories: string[];
}

export interface EffectiveConfig {
  localConfigPath: string;
  workspaceRoot: string;
  branchPattern: string;
  repositories: Readonly<Record<string, EffectiveRepositoryConfig>>;
  presets: Readonly<Record<string, EffectivePresetConfig>>;
}
```

Implement `src/domain/validation.ts`:

```ts
import path from 'node:path';
import { AiWorkspaceError } from './errors';

const PORTABLE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function normalizeRequirementId(raw: string): string {
  const value = raw.trim();
  if (!PORTABLE_ID.test(value) || WINDOWS_DEVICE.test(value)) {
    throw new AiWorkspaceError('VALIDATION', `Invalid requirement id: ${raw}`);
  }
  return value;
}

export function renderBranchName(pattern: string, requirementId: string): string {
  const occurrences = pattern.split('{requirementId}').length - 1;
  if (occurrences !== 1) {
    throw new AiWorkspaceError(
      'CONFIG',
      'branchPattern must contain {requirementId} exactly once'
    );
  }
  return pattern.replace('{requirementId}', normalizeRequirementId(requirementId));
}

export function assertPathInside(root: string, candidate: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '' || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
    throw new AiWorkspaceError('VALIDATION', `Path is outside workspaceRoot: ${candidate}`);
  }
}
```

Keep `src/extension.ts` minimal and side-effect free for now:

```ts
import type * as vscode from 'vscode';

export function activate(_context: vscode.ExtensionContext): void {}
export function deactivate(): void {}
```

- [ ] **Step 5: Run focused and full checks**

Run: `npm test -- src/domain/validation.test.ts`

Expected: PASS.

Run: `npm run check && npm run build`

Expected: typecheck, all tests, and bundle succeed; `dist/extension.js` exists.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts esbuild.mjs .gitignore src
git commit -m "chore: bootstrap AI Workspace extension"
```

---

### Task 2: Load and Merge Shared and Local Configuration

**Files:**
- Create: `src/config/config-schema.ts`
- Create: `src/config/config-service.ts`
- Test: `src/config/config-service.test.ts`
- Modify: `src/domain/types.ts`

**Interfaces:**
- Consumes: `EffectiveConfig`, `EffectiveRepositoryConfig`, `EffectivePresetConfig`, and `AiWorkspaceError` from Task 1.
- Produces: `ConfigService.getLocalConfigPath()`, `ConfigService.ensureLocalConfig()`, `ConfigService.load()`, and `ConfigService.setRepositoryPath(repositoryId, repositoryPath)`.

- [ ] **Step 1: Write failing merge and persistence tests**

Use a temporary home directory and real files in `src/config/config-service.test.ts`:

```ts
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigService } from './config-service';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe('ConfigService', () => {
  it('merges team defaults with local paths and overrides', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-config-'));
    roots.push(home);
    const configDir = path.join(home, '.config', 'ai-workspace');
    await mkdir(configDir, { recursive: true });
    await writeFile(path.join(home, 'team.yaml'), `version: 1
branchPattern: feature/{requirementId}
repositories:
  quote:
    displayName: Quote Service
    remote: upstream
presets:
  auto:
    name: Auto Insurance
    repositories: [quote]
`);
    await writeFile(path.join(configDir, 'config.yaml'), `version: 1
sharedConfig: ~/team.yaml
workspaceRoot: ~/ai-workspaces
repositories:
  quote:
    path: ~/code/quote
    remote: origin
`);

    const config = await new ConfigService(home).load();
    expect(config.workspaceRoot).toBe(path.join(home, 'ai-workspaces'));
    expect(config.repositories.quote).toMatchObject({
      displayName: 'Quote Service',
      path: path.join(home, 'code', 'quote'),
      remote: 'origin'
    });
    expect(config.presets.auto.repositories).toEqual(['quote']);
  });

  it('writes a located repository path back to local YAML', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'ai-workspace-config-'));
    roots.push(home);
    const service = new ConfigService(home);
    await service.ensureLocalConfig();
    await service.setRepositoryPath('quote', path.join(home, 'code', 'quote'));
    expect(await readFile(service.getLocalConfigPath(), 'utf8'))
      .toContain('quote:');
  });
});
```

- [ ] **Step 2: Run the test and verify the expected failure**

Run: `npm test -- src/config/config-service.test.ts`

Expected: FAIL because `ConfigService` does not exist.

- [ ] **Step 3: Define strict YAML schemas**

In `src/config/config-schema.ts`, export Zod schemas for the following exact shapes:

```ts
import { z } from 'zod';

const cloneUrlSchema = z.string().min(1).refine(value => {
  if (!/^https?:\/\//i.test(value)) return true;
  try {
    const parsed = new URL(value);
    return parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}, 'HTTP(S) cloneUrl must not contain credentials');

export const repositoryDefaultsSchema = z.object({
  displayName: z.string().min(1).optional(),
  cloneUrl: cloneUrlSchema.optional(),
  remote: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).optional()
}).strict();

export const localRepositorySchema = repositoryDefaultsSchema.extend({
  path: z.string().min(1).optional()
}).strict();

export const presetSchema = z.object({
  name: z.string().min(1),
  repositories: z.array(z.string().min(1)).min(1)
}).strict();

export const sharedConfigSchema = z.object({
  version: z.literal(1),
  branchPattern: z.string().min(1).optional(),
  repositories: z.record(z.string(), repositoryDefaultsSchema).default({}),
  presets: z.record(z.string(), presetSchema).default({})
}).strict();

export const localConfigSchema = z.object({
  version: z.literal(1),
  sharedConfig: z.string().min(1).optional(),
  workspaceRoot: z.string().min(1).default('~/ai-workspaces'),
  branchPattern: z.string().min(1).optional(),
  repositories: z.record(z.string(), localRepositorySchema).default({}),
  presets: z.record(z.string(), presetSchema).default({})
}).strict();

export type SharedConfigDocument = z.infer<typeof sharedConfigSchema>;
export type LocalConfigDocument = z.infer<typeof localConfigSchema>;
```

Validate that every preset references known repository IDs after merging; raise `AiWorkspaceError('CONFIG', ...)` with the offending preset and repository IDs.

Also reject HTTP(S) `cloneUrl` values containing URL username or password fields. SSH forms such as `git@example.com:team/repo.git` remain valid because `git` is the SSH user, not an embedded HTTP credential.

- [ ] **Step 4: Implement configuration resolution and local updates**

Implement `ConfigService` with this public contract:

```ts
export class ConfigService {
  constructor(
    private readonly homeDirectory: string,
    private readonly localConfigPath = path.join(
      homeDirectory,
      '.config',
      'ai-workspace',
      'config.yaml'
    )
  ) {}

  getLocalConfigPath(): string;
  ensureLocalConfig(): Promise<string>;
  load(): Promise<EffectiveConfig>;
  setRepositoryPath(repositoryId: string, repositoryPath: string): Promise<void>;
}
```

Implementation rules:

```ts
function expandHome(value: string, home: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.resolve(home, value.slice(2));
  }
  return value;
}
```

1. `ensureLocalConfig()` creates parent directories and, only when absent, writes:

   ```yaml
   version: 1
   workspaceRoot: ~/ai-workspaces
   branchPattern: feature/{requirementId}
   repositories: {}
   presets: {}
   ```

2. `load()` first calls `ensureLocalConfig()`, parses local YAML, resolves `sharedConfig` relative to the local config directory after home expansion, parses shared YAML when configured, and merges in this order: shared document, local document, then runtime wizard selections outside this service.
3. Repository fields merge by repository ID; local values override shared values. Presets merge by preset ID; a local preset replaces the shared preset with the same ID.
4. Defaults are `workspaceRoot: ~/ai-workspaces`, `branchPattern: feature/{requirementId}`, `remote: origin`, and `displayName: <repositoryId>`.
5. Resolve `workspaceRoot` and repository paths to absolute normalized paths. Do not resolve `cloneUrl` as a path.
6. `setRepositoryPath()` uses `YAML.parseDocument`, `document.setIn(['repositories', id, 'path'], path)`, and an atomic same-directory temporary write plus rename so unrelated YAML keys remain present.
7. Convert YAML, schema, read, and write failures to `AiWorkspaceError('CONFIG', ...)` with the config path but no file contents.

- [ ] **Step 5: Run focused and full checks**

Run: `npm test -- src/config/config-service.test.ts`

Expected: PASS for merge, path expansion, defaults, unknown preset repository rejection, malformed YAML, invalid remote names, credential-bearing HTTP clone URLs, and path persistence.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/config src/domain/types.ts
git commit -m "feat: load shared and local workspace configuration"
```

---

### Task 3: Execute Processes and Git Safely

**Files:**
- Create: `src/git/command-runner.ts`
- Create: `src/git/git-client.ts`
- Test: `src/git/command-runner.test.ts`
- Test: `src/git/git-client.test.ts`

**Interfaces:**
- Consumes: `AiWorkspaceError` from Task 1.
- Produces: `CommandRunner.run(command, args, options)`, `GitClient.exec(cwd, args, options)`, `GitResult`, and `redactGitText(text)`.

- [ ] **Step 1: Write failing process and redaction tests**

Create focused tests:

```ts
import { describe, expect, it } from 'vitest';
import { NodeCommandRunner } from './command-runner';
import { GitClient, redactGitText } from './git-client';

it('passes arguments literally without shell expansion', async () => {
  const result = await new NodeCommandRunner().run(
    process.execPath,
    ['-e', 'process.stdout.write(process.argv[1])', '$HOME && touch never'],
    { cwd: process.cwd() }
  );
  expect(result.stdout).toBe('$HOME && touch never');
});

it('redacts credentials embedded in URLs', () => {
  expect(redactGitText('https://alice:secret@example.com/team/repo.git'))
    .toBe('https://***@example.com/team/repo.git');
});

it('turns a non-zero Git result into a typed error', async () => {
  const runner = {
    run: async () => ({ exitCode: 128, stdout: '', stderr: 'fatal: bad ref' })
  };
  await expect(new GitClient(runner).exec('/repo', ['rev-parse', 'bad']))
    .rejects.toMatchObject({ code: 'GIT' });
});
```

- [ ] **Step 2: Run the tests and verify the expected failure**

Run: `npm test -- src/git/command-runner.test.ts src/git/git-client.test.ts`

Expected: FAIL because the process and Git adapters do not exist.

- [ ] **Step 3: Implement the process runner**

Create these exact contracts in `src/git/command-runner.ts`:

```ts
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface CommandRunner {
  run(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult>;
}
```

Implement `NodeCommandRunner` with `node:child_process.spawn(command, [...args], { cwd, env, signal, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })`. Collect UTF-8 stdout/stderr, resolve with the numeric exit code, translate `AbortError` to `AiWorkspaceError('CANCELLED', 'Operation cancelled')`, and translate spawn failures to `AiWorkspaceError('GIT', 'Unable to start Git', { command })` without including environment variables.

- [ ] **Step 4: Implement the Git client and redaction**

Create `GitClient`:

```ts
export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitExecOptions {
  signal?: AbortSignal;
  allowedExitCodes?: readonly number[];
}

export class GitClient {
  constructor(
    private readonly runner: CommandRunner = new NodeCommandRunner(),
    private readonly executable = 'git'
  ) {}

  async exec(
    cwd: string,
    args: readonly string[],
    options: GitExecOptions = {}
  ): Promise<GitResult>;
}
```

`exec()` passes only `cwd`, `args`, and `signal` to the runner. Exit code `0` plus explicitly allowed codes succeed; all others throw `AiWorkspaceError('GIT', redactGitText(stderr || stdout || 'Git command failed'), { cwd, args: redactGitArgs(args), exitCode })`. Implement redaction as `text.replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1***@')`. Never log the process environment.

Define `redactGitArgs(args)` as `args.map(argument => redactGitText(argument))`; both it and `redactGitText()` must return new values without mutating caller-owned arrays.

- [ ] **Step 5: Run focused and full checks**

Run: `npm test -- src/git/command-runner.test.ts src/git/git-client.test.ts`

Expected: PASS, including literal argument handling, non-zero exits, cancellation, and credential redaction.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/git
git commit -m "feat: add safe Git process execution"
```

---

### Task 4: Inspect Repositories and Manage Worktrees

**Files:**
- Create: `src/git/repository-service.ts`
- Test: `src/git/repository-service.test.ts`
- Modify: `src/domain/types.ts`

**Interfaces:**
- Consumes: `GitClient.exec()` from Task 3 and `RepositoryStatus` from Task 1.
- Produces: `RepositoryService.assertUsableRepository()`, `detectRemoteTrunk()`, `listRemoteBranches()`, `fetch()`, `validateBaseRef()`, `resolveCommit()`, `validateBranchName()`, `getBranchInfo()`, `addWorktree()`, `removeWorktree()`, `deleteBranchIfAt()`, `getStatus()`, and `isClean()`.

- [ ] **Step 1: Write failing parser and command-selection tests**

Create `src/git/repository-service.test.ts` with a queue-backed fake `GitClient` and these cases:

```ts
import { describe, expect, it, vi } from 'vitest';
import {
  parseLsRemoteHead,
  parseWorktreePorcelain,
  RepositoryService
} from './repository-service';

it('parses a remote HEAD symref', () => {
  expect(parseLsRemoteHead('ref: refs/heads/main\tHEAD\nabc\tHEAD\n', 'origin'))
    .toBe('origin/main');
});

it('maps branches to occupied worktree paths', () => {
  const records = parseWorktreePorcelain(
    'worktree /code/main\0HEAD aaa\0branch refs/heads/main\0' +
    'worktree /work/REQ-1\0HEAD bbb\0branch refs/heads/feature/REQ-1\0'
  );
  expect(records[1]).toMatchObject({
    path: '/work/REQ-1',
    branch: 'refs/heads/feature/REQ-1'
  });
});

it('prefers refs/remotes/origin/HEAD over network and main/master fallbacks', async () => {
  const git = {
    exec: vi.fn().mockResolvedValue({
      exitCode: 0,
      stdout: 'origin/trunk\n',
      stderr: ''
    })
  };
  const service = new RepositoryService(git);
  await expect(service.detectRemoteTrunk('/repo', 'origin')).resolves.toBe('origin/trunk');
  expect(git.exec).toHaveBeenCalledWith(
    '/repo',
    ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'],
    { allowedExitCodes: [0, 1] }
  );
});

it('uses update-ref with an expected oid when deleting a transaction-created branch', async () => {
  const oid = 'a'.repeat(40);
  const git = { exec: vi.fn()
    .mockResolvedValueOnce({ exitCode: 0, stdout: `${oid}\n`, stderr: '' })
    .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) };
  await expect(new RepositoryService(git).deleteBranchIfAt('/repo', 'feature/REQ-1', oid))
    .resolves.toBe(true);
  expect(git.exec).toHaveBeenCalledWith(
    '/repo',
    ['update-ref', '-d', 'refs/heads/feature/REQ-1', oid]
  );
});
```

Also add tests for remote `HEAD` fallback to `origin/main`, rejection of a base outside the configured remote or beginning with an option-like value, existing-branch lookup, an occupied branch, exact worktree argument arrays, dirty-file counting, upstream ahead/behind parsing, and `no-upstream` status.

- [ ] **Step 2: Run the tests and verify the expected failure**

Run: `npm test -- src/git/repository-service.test.ts`

Expected: FAIL because `RepositoryService` and its parsers do not exist.

- [ ] **Step 3: Add repository and worktree contracts**

Append these contracts to `src/domain/types.ts`:

```ts
export interface WorktreeInfo {
  path: string;
  head?: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
}

export interface BranchInfo {
  exists: boolean;
  head?: string;
  worktreePath?: string;
}

export interface AddWorktreeInput {
  sourcePath: string;
  targetPath: string;
  branch: string;
  baseCommit: string;
  createBranch: boolean;
  signal?: AbortSignal;
}
```

- [ ] **Step 4: Implement remote and branch inspection**

Create `RepositoryService` with this public API:

```ts
export class RepositoryService {
  constructor(private readonly git: Pick<GitClient, 'exec'>) {}

  assertUsableRepository(sourcePath: string, remote: string): Promise<void>;
  detectRemoteTrunk(sourcePath: string, remote: string, signal?: AbortSignal): Promise<string | undefined>;
  listRemoteBranches(sourcePath: string, remote: string): Promise<string[]>;
  fetch(sourcePath: string, remote: string, signal?: AbortSignal): Promise<void>;
  validateBaseRef(sourcePath: string, remote: string, baseRef: string): Promise<void>;
  resolveCommit(sourcePath: string, ref: string): Promise<string>;
  validateBranchName(sourcePath: string, branch: string): Promise<void>;
  listWorktrees(sourcePath: string): Promise<WorktreeInfo[]>;
  getBranchInfo(sourcePath: string, branch: string): Promise<BranchInfo>;
  addWorktree(input: AddWorktreeInput): Promise<void>;
  removeWorktree(sourcePath: string, worktreePath: string): Promise<void>;
  deleteBranchIfAt(sourcePath: string, branch: string, expectedOid: string): Promise<boolean>;
  getStatus(worktreePath: string): Promise<RepositoryStatus>;
  isClean(worktreePath: string): Promise<boolean>;
}
```

Use these exact Git commands and interpretations:

```text
rev-parse --is-inside-work-tree
remote get-url <remote>
worktree list --porcelain -z
check-ref-format --branch <branch>
symbolic-ref --quiet --short refs/remotes/<remote>/HEAD
ls-remote --symref <remote> HEAD
show-ref --verify --quiet refs/remotes/<remote>/main
show-ref --verify --quiet refs/remotes/<remote>/master
for-each-ref --format=%(refname:short) refs/remotes/<remote>
fetch --prune <remote>
rev-parse --verify refs/remotes/<remote>/<branch>^{commit}
show-ref --verify --hash refs/heads/<branch>
```

`assertUsableRepository()` requires `rev-parse --is-inside-work-tree` to return `true`, verifies the configured remote with `remote get-url`, and probes the required worktree/branch commands with read-only or validation invocations. A missing capability raises one actionable `AiWorkspaceError('GIT', ...)` before any worktree mutation.

`detectRemoteTrunk()` follows the approved priority: local remote `HEAD`, `ls-remote --symref`, `<remote>/main`, then `<remote>/master`. `listRemoteBranches()` removes `<remote>/HEAD`, deduplicates, and lexically sorts refs.

`validateBaseRef()` requires the exact `<configuredRemote>/<branch>` prefix and validates the branch suffix with `git check-ref-format --branch`. `resolveCommit()` accepts only a previously validated ref and resolves `refs/remotes/<baseRef>^{commit}`; it never accepts arbitrary revision expressions from the UI.

`parseWorktreePorcelain()` reads NUL-separated tokens; every `worktree ` token starts a new record, `HEAD ` sets `head`, `branch ` sets the full ref, and standalone `bare` or `detached` tokens set flags. `getBranchInfo()` compares against `refs/heads/<branch>` and returns the occupying worktree path when present.

- [ ] **Step 5: Implement worktree mutation and status**

Use these argument arrays exactly:

```ts
const args = input.createBranch
  ? ['worktree', 'add', '-b', input.branch, input.targetPath, input.baseCommit]
  : ['worktree', 'add', input.targetPath, input.branch];
await this.git.exec(input.sourcePath, args, { signal: input.signal });
```

Removal must be `['worktree', 'remove', '--', worktreePath]` without `--force`. `deleteBranchIfAt()` first reads `refs/heads/<branch>` with `show-ref --verify --hash`, returns `false` when absent or different from `expectedOid`, and otherwise runs `['update-ref', '-d', 'refs/heads/<branch>', expectedOid]` and returns `true`. The expected old OID makes deletion atomic and prevents deleting a branch that advanced.

For status:

1. Count non-empty lines from `git status --porcelain=v1`.
2. Query upstream with `rev-parse --abbrev-ref --symbolic-full-name @{upstream}` and allow exit codes `0` and `128`.
3. Without upstream, return `{ publication: 'no-upstream', ahead: 0, behind: 0 }`.
4. With upstream, parse `rev-list --left-right --count HEAD...@{upstream}` as `<ahead> <behind>` and return `ahead` when the first number is positive, otherwise `synced`.

- [ ] **Step 6: Run focused and full checks**

Run: `npm test -- src/git/repository-service.test.ts`

Expected: PASS for parsers, command arrays, fallback order, branch occupancy, safe deletion, and status classification.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/git/repository-service.ts src/git/repository-service.test.ts src/domain/types.ts
git commit -m "feat: inspect repositories and manage worktrees"
```

---

### Task 5: Persist Recoverable Workspace State and Locks

**Files:**
- Create: `src/state/state-schema.ts`
- Create: `src/state/state-store.ts`
- Test: `src/state/state-store.test.ts`
- Modify: `src/domain/types.ts`

**Interfaces:**
- Consumes: domain validation and errors from Task 1.
- Produces: `WorkspaceState`, `WorkspaceRepositoryState`, `WorkspaceLockInfo`, `WorkspaceLock`, and `StateStore` path/read/write/list/lock/cleanup methods.

- [ ] **Step 1: Write failing durability and lock tests**

Create `src/state/state-store.test.ts` around a temporary `workspaceRoot`:

```ts
it('writes and reads a versioned workspace state atomically', async () => {
  const store = new StateStore({ processId: 101, isProcessAlive: () => true });
  await store.write(workspacePath, sampleState);
  await expect(store.read(workspacePath)).resolves.toEqual(sampleState);
  expect((await readdir(workspacePath)).filter(name => name.endsWith('.tmp'))).toEqual([]);
});

it('refuses an active lock', async () => {
  const store = new StateStore({ processId: 101, isProcessAlive: pid => pid === 101 });
  const lock = await store.acquireLock(workspacePath, 'create', async () => false);
  await expect(store.acquireLock(workspacePath, 'finish', async () => true))
    .rejects.toMatchObject({ code: 'LOCKED' });
  await lock.release();
});

it('breaks a stale lock only after confirmation', async () => {
  const first = new StateStore({ processId: 101, isProcessAlive: () => false });
  const stale = await first.acquireLock(workspacePath, 'create', async () => false);
  const second = new StateStore({ processId: 202, isProcessAlive: () => false });
  const replacement = await second.acquireLock(workspacePath, 'finish', async () => true);
  await replacement.release();
  await stale.release();
});
```

Also test malformed state rejection, workspace listing that skips unrelated folders, token-protected lock release, and cleanup that deletes only generated metadata plus an empty parent.

- [ ] **Step 2: Run the tests and verify the expected failure**

Run: `npm test -- src/state/state-store.test.ts`

Expected: FAIL because state schemas and `StateStore` do not exist.

- [ ] **Step 3: Define the durable state contract and schema**

Append to `src/domain/types.ts`:

```ts
export interface WorkspaceRepositoryState {
  id: string;
  displayName: string;
  sourcePath: string;
  worktreePath: string;
  remote: string;
  baseRef: string;
  baseCommit: string;
  branch: string;
  branchExistedBefore: boolean;
  branchCreatedByOperation: boolean;
  branchInitialCommit: string;
  worktreeCreated: boolean;
}

export interface WorkspaceState {
  version: 1;
  status: WorkspaceStatus;
  requirement: Requirement;
  workspacePath: string;
  branchName: string;
  createdAt: string;
  updatedAt: string;
  openCodexOnNextActivation: boolean;
  repositories: WorkspaceRepositoryState[];
  recovery?: {
    operation: 'create' | 'resume' | 'finish';
    stage: string;
    repositoryId?: string;
    message: string;
  };
}

export interface WorkspaceLockInfo {
  token: string;
  processId: number;
  operation: 'create' | 'recover' | 'finish';
  startedAt: string;
}

export interface WorkspaceLock {
  info: WorkspaceLockInfo;
  release(): Promise<void>;
}
```

In `src/state/state-schema.ts`, express the same exact shape with strict Zod objects, absolute non-empty path strings, 40- or 64-character lowercase hexadecimal commit strings, ISO timestamp strings, and the four workspace statuses. Export `parseWorkspaceState(value): WorkspaceState` that wraps schema errors in `AiWorkspaceError('RECOVERY_REQUIRED', 'Invalid workspace state')`.

- [ ] **Step 4: Implement atomic state writes and workspace discovery**

Implement:

```ts
export interface StateStoreOptions {
  processId?: number;
  isProcessAlive?: (processId: number) => boolean;
  now?: () => Date;
}

export class StateStore {
  constructor(options: StateStoreOptions = {}) {}

  workspacePath(workspaceRoot: string, requirementId: string): string;
  read(workspacePath: string): Promise<WorkspaceState>;
  readIfExists(workspacePath: string): Promise<WorkspaceState | undefined>;
  write(workspacePath: string, state: WorkspaceState): Promise<void>;
  list(workspaceRoot: string): Promise<WorkspaceState[]>;
  acquireLock(
    workspacePath: string,
    operation: WorkspaceLockInfo['operation'],
    confirmBreakStale: (lock: WorkspaceLockInfo) => Promise<boolean>
  ): Promise<WorkspaceLock>;
  removeGeneratedMetadata(workspacePath: string): Promise<void>;
}
```

`workspacePath()` uses the normalized ID and `assertPathInside()`. `write()` creates the parent, writes JSON with a trailing newline and mode `0o600` to `.<filename>.<pid>.<uuid>.tmp` in the same directory, then renames it to `.ai-workspace.json`; always remove a remaining temp file in `finally`.

`list()` reads only direct child directories, calls `readIfExists()`, sorts newest `updatedAt` first, and ignores directories without state. It must surface malformed state rather than silently hiding it.

- [ ] **Step 5: Implement exclusive, stale-aware locks and narrow cleanup**

Create `.ai-workspace.lock` with `open(path, 'wx', 0o600)` and JSON `WorkspaceLockInfo`. On `EEXIST`:

1. Parse the existing lock.
2. If `isProcessAlive(processId)` is true, throw `AiWorkspaceError('LOCKED', ...)`.
3. If the process is not alive, invoke `confirmBreakStale(existing)`.
4. Only on `true`, unlink that exact lock and retry acquisition once.

`release()` rereads the lock and unlinks it only when the token still matches. The default liveness check is `process.kill(pid, 0)` with `ESRCH` meaning dead and permission errors meaning alive.

`removeGeneratedMetadata()` runs only after the caller releases its lock. It deletes only `.ai-workspace.json` and `AGENTS.md`, then calls non-recursive `rmdir(workspacePath)`, ignoring only `ENOTEMPTY` and `ENOENT`. It never deletes a lock file and must never recursively delete a requirement directory.

- [ ] **Step 6: Run focused and full checks**

Run: `npm test -- src/state/state-store.test.ts`

Expected: PASS for atomic writes, schema validation, active/stale locks, discovery, and narrow cleanup.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/state src/domain/types.ts
git commit -m "feat: persist recoverable workspace state"
```

---

### Task 6: Generate Parent Codex Instructions

**Files:**
- Create: `src/context/agents-generator.ts`
- Test: `src/context/agents-generator.test.ts`

**Interfaces:**
- Consumes: `WorkspaceState` from Task 5.
- Produces: `AgentsGenerator.render(state)` and `AgentsGenerator.write(workspacePath, state)`.

- [ ] **Step 1: Write a failing snapshot-style content test**

Create a complete two-repository state fixture and assert exact required sections:

```ts
it('renders one parent instruction file for every selected repository', () => {
  const text = new AgentsGenerator().render(sampleState);
  expect(text).toContain('# Requirement REQ-123');
  expect(text).toContain('车险报价流程优化');
  expect(text).toContain('| quote | `origin/main` | `feature/REQ-123` |');
  expect(text).toContain('| web | `origin/release` | `feature/REQ-123` |');
  expect(text).toContain('Each child directory is an independent Git repository.');
  expect(text).toContain('Run and report tests separately for every changed repository.');
  expect(text).toContain('Follow any nested AGENTS.md files inside each repository.');
  expect(text).not.toContain('token');
});
```

- [ ] **Step 2: Run the test and verify the expected failure**

Run: `npm test -- src/context/agents-generator.test.ts`

Expected: FAIL because `AgentsGenerator` does not exist.

- [ ] **Step 3: Implement deterministic Markdown generation**

`render()` emits these sections in order:

```markdown
# Requirement <id>

<title>

## Repositories

| Repository | Base | Requirement branch |
| --- | --- | --- |
| <id> | `<baseRef>` | `<branch>` |

## Working rules

- This parent directory contains multiple independent Git repositories.
- Analyze cross-repository impact before editing public contracts.
- Follow any nested AGENTS.md files inside each repository.
- Run and report tests separately for every changed repository.
- Commit and push each repository independently; there is no atomic cross-repository commit.
```

Sort rows in the same order as `state.repositories`. Escape Markdown table pipes in IDs/display names. `write()` writes UTF-8 to `<workspacePath>/AGENTS.md` via a same-directory temporary file and rename. Do not include source paths, clone URLs, environment data, or Git output.

- [ ] **Step 4: Run focused and full checks**

Run: `npm test -- src/context/agents-generator.test.ts`

Expected: PASS with deterministic content and no sensitive fields.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/context
git commit -m "feat: generate parent Codex instructions"
```

---

### Task 7: Build a Fully Validated Multi-Repository Creation Plan

**Files:**
- Create: `src/workspace/creation-planner.ts`
- Test: `src/workspace/creation-planner.test.ts`
- Modify: `src/domain/types.ts`

**Interfaces:**
- Consumes: `EffectiveConfig`, `StateStore.workspacePath()`, and repository inspection/fetch methods from Tasks 4 and 5.
- Produces: `RepositorySelection`, `PlannedRepository`, `CreationPlan`, `WorkspaceProgress`, and `CreationPlanner.plan(request, options)`.

- [ ] **Step 1: Write failing plan tests with fake repositories**

Test the entire preflight as one unit:

```ts
it('resolves immutable base commits and marks existing branches for reuse', async () => {
  const repositories = fakeRepositoryService({
    quote: { baseCommit: 'a'.repeat(40), branch: { exists: false } },
    web: { baseCommit: 'b'.repeat(40), branch: { exists: true, head: 'c'.repeat(40) } }
  });
  const planner = new CreationPlanner(repositories, stateStore, pathProbe);
  const plan = await planner.plan({
    requirement: { id: 'REQ-123', title: 'Quote change' },
    config,
    selections: [
      { repositoryId: 'quote', baseRef: 'origin/main' },
      { repositoryId: 'web', baseRef: 'origin/release' }
    ]
  });

  expect(plan.branchName).toBe('feature/REQ-123');
  expect(plan.repositories).toMatchObject([
    { id: 'quote', baseCommit: 'a'.repeat(40), branchDisposition: 'create' },
    { id: 'web', baseCommit: 'b'.repeat(40), branchDisposition: 'reuse', branchInitialCommit: 'c'.repeat(40) }
  ]);
});

it('fails all preflight before any worktree is created when a branch is occupied', async () => {
  repositories.getBranchInfo.mockResolvedValue({
    exists: true,
    head: 'c'.repeat(40),
    worktreePath: '/other/REQ-123'
  });
  await expect(planner.plan(request)).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(repositories.addWorktree).not.toHaveBeenCalled();
});
```

Add cases for duplicate selections, missing local repository paths, unmanaged target-directory conflicts, invalid Git branch names, failed fetch, missing base refs after fetch, and preserved repository selection order.

- [ ] **Step 2: Run the tests and verify the expected failure**

Run: `npm test -- src/workspace/creation-planner.test.ts`

Expected: FAIL because the creation planner does not exist.

- [ ] **Step 3: Define creation-plan contracts**

Append to `src/domain/types.ts`:

```ts
export interface RepositorySelection {
  repositoryId: string;
  baseRef: string;
}

export interface PlannedRepository {
  id: string;
  displayName: string;
  sourcePath: string;
  worktreePath: string;
  remote: string;
  baseRef: string;
  baseCommit: string;
  branch: string;
  branchDisposition: 'create' | 'reuse';
  branchInitialCommit: string;
}

export interface CreationPlan {
  requirement: Requirement;
  workspacePath: string;
  branchName: string;
  repositories: PlannedRepository[];
}

export interface WorkspaceProgress {
  stage: 'preflight' | 'fetch' | 'create' | 'rollback' | 'resume' | 'finish';
  repositoryId?: string;
  message: string;
}
```

- [ ] **Step 4: Implement deterministic preflight planning**

Use this API:

```ts
import * as fs from 'node:fs/promises';

export interface CreationRequest {
  requirement: Requirement;
  config: EffectiveConfig;
  selections: RepositorySelection[];
}

export interface PlanningOptions {
  signal?: AbortSignal;
  onProgress?: (progress: WorkspaceProgress) => void;
}

export interface PathProbe {
  exists(targetPath: string): Promise<boolean>;
}

export class NodePathProbe implements PathProbe {
  async exists(targetPath: string): Promise<boolean> {
    try {
      await fs.lstat(targetPath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}

export class CreationPlanner {
  constructor(
    private readonly repositories: Pick<RepositoryService,
      | 'assertUsableRepository'
      | 'fetch'
      | 'validateBaseRef'
      | 'resolveCommit'
      | 'validateBranchName'
      | 'getBranchInfo'>,
    private readonly states: Pick<StateStore, 'workspacePath' | 'readIfExists'>,
    private readonly paths: PathProbe = new NodePathProbe()
  ) {}

  plan(request: CreationRequest, options?: PlanningOptions): Promise<CreationPlan>;
}
```

Implement in this order:

1. Normalize the ID, trim and require a non-empty title, require at least one unique repository selection, and render the shared branch name.
2. Compute the requirement parent with `states.workspacePath()`. If `.ai-workspace.json` exists, throw a typed conflict containing the existing path; the command controller handles normal resume before calling the planner.
3. Reject an already-existing requirement parent without valid state and any already-existing child target path.
4. Resolve every selected repository ID. Require a configured absolute local path and preserve selection order.
5. Run `assertUsableRepository()`, `validateBaseRef()`, and `validateBranchName()` for every repository before creating any worktree.
6. Sequentially `fetch(sourcePath, remote)`, then resolve the selected `baseRef` to `baseCommit`.
7. Query the requirement branch. Reject an occupied branch and include its worktree path. For an existing unoccupied branch, set `branchDisposition: 'reuse'` and `branchInitialCommit` to its current head. Otherwise set `branchDisposition: 'create'` and `branchInitialCommit` to `baseCommit`.
8. Return an immutable plan. The planner may update remote-tracking refs with `fetch`; it must not create directories, local branches, or worktrees.

- [ ] **Step 5: Run focused and full checks**

Run: `npm test -- src/workspace/creation-planner.test.ts`

Expected: PASS for complete plans and every preflight rejection.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workspace/creation-planner.ts src/workspace/creation-planner.test.ts src/domain/types.ts
git commit -m "feat: plan multi-repository workspace creation"
```

---

### Task 8: Execute Creation as a Recoverable Transaction

**Files:**
- Create: `src/workspace/workspace-orchestrator.ts`
- Test: `src/workspace/workspace-orchestrator.test.ts`

**Interfaces:**
- Consumes: `CreationPlan`, `RepositoryService`, `StateStore`, and `AgentsGenerator` from Tasks 4–7.
- Produces: `WorkspaceOrchestrator.create(plan, options)` and `WorkspaceOrchestrator.recover(workspacePath, action, options)`.

- [ ] **Step 1: Write failing success, rollback, and recovery tests**

Use strict call-order fakes:

```ts
it('journals every created worktree and marks the workspace ready', async () => {
  const state = await orchestrator.create(plan, options);
  expect(repositories.addWorktree.mock.calls.map(call => call[0].targetPath))
    .toHaveLength(2);
  expect(state.status).toBe('ready');
  expect(state.repositories.every(repo => repo.worktreeCreated)).toBe(true);
  expect(state.openCodexOnNextActivation).toBe(true);
  expect(agents.write).toHaveBeenCalledWith(plan.workspacePath, state);
});

it('rolls back the first repository when the second creation fails', async () => {
  repositories.addWorktree
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('second failed'));
  await expect(orchestrator.create(plan, options)).rejects.toThrow('second failed');
  expect(repositories.removeWorktree).toHaveBeenCalledWith(
    plan.repositories[0].sourcePath,
    plan.repositories[0].worktreePath
  );
  expect(repositories.deleteBranchIfAt).toHaveBeenCalledWith(
    plan.repositories[0].sourcePath,
    plan.branchName,
    plan.repositories[0].branchInitialCommit
  );
  expect(states.removeGeneratedMetadata).toHaveBeenCalledWith(plan.workspacePath);
});

it('never deletes a branch that existed before the transaction', async () => {
  await orchestrator.create(planWithReusedBranch, options).catch(() => undefined);
  expect(repositories.deleteBranchIfAt)
    .not.toHaveBeenCalledWith(expect.anything(), reusedBranch, expect.anything());
});
```

Add cases for cancellation, `AGENTS.md` failure, dirty rollback refusal, incomplete rollback becoming `recoveryRequired`, recovery action `continue`, and recovery action `rollback`.

- [ ] **Step 2: Run the tests and verify the expected failure**

Run: `npm test -- src/workspace/workspace-orchestrator.test.ts`

Expected: FAIL because `WorkspaceOrchestrator` does not exist.

- [ ] **Step 3: Implement transaction setup and successful creation**

Use this contract:

```ts
export interface OrchestrationOptions {
  signal?: AbortSignal;
  onProgress?: (progress: WorkspaceProgress) => void;
  confirmBreakStaleLock: (lock: WorkspaceLockInfo) => Promise<boolean>;
}

export class WorkspaceOrchestrator {
  constructor(
    private readonly repositories: Pick<RepositoryService,
      | 'addWorktree'
      | 'removeWorktree'
      | 'deleteBranchIfAt'
      | 'getBranchInfo'
      | 'isClean'>,
    private readonly states: StateStore,
    private readonly agents: AgentsGenerator,
    private readonly now: () => Date = () => new Date()
  ) {}

  create(plan: CreationPlan, options: OrchestrationOptions): Promise<WorkspaceState>;
  recover(
    workspacePath: string,
    action: 'continue' | 'rollback',
    options: OrchestrationOptions
  ): Promise<WorkspaceState | undefined>;
}
```

`create()` performs these exact state transitions:

1. Acquire the `create` lock.
2. Convert the plan to a `creating` state. Set `branchExistedBefore` from `branchDisposition`, `branchCreatedByOperation: false`, `worktreeCreated: false`, and `openCodexOnNextActivation: true`.
3. Persist state before the first worktree operation.
4. For each planned repository in order, reject an aborted signal, call `addWorktree()`, set `worktreeCreated: true`, set `branchCreatedByOperation: true` only for `branchDisposition: 'create'`, update `updatedAt`, and persist immediately.
5. Generate `AGENTS.md` only after all worktrees exist.
6. Set `status: 'ready'`, clear `recovery`, persist, and return.
7. Release the lock in `finally`.

- [ ] **Step 4: Implement guarded reverse rollback**

On any failure or cancellation after state creation:

1. Iterate repository state in reverse.
2. Query `getBranchInfo()` even when `worktreeCreated` is false, covering a crash after Git succeeded but before the journal write. When the branch occupies the exact recorded target, call `isClean()` and remove it only when clean; an occupation at another path is a rollback failure.
3. For every repository with `branchExistedBefore: false`, call `deleteBranchIfAt(sourcePath, branch, branchInitialCommit)`. This method is a no-op if the branch is absent or has advanced.
4. Persist after each successful reversal.
5. If every reversal succeeds, release the lock, call `removeGeneratedMetadata(workspacePath)`, and rethrow the original error.
6. If any reversal fails, set `status: 'recoveryRequired'`, record a redacted `recovery` with `operation: 'create'`, persist it, release the lock, and throw `AiWorkspaceError('RECOVERY_REQUIRED', ...)` containing the workspace path.

Do not replace the original exception with cleanup details when rollback fully succeeds.

- [ ] **Step 5: Implement explicit recovery**

For `recover(workspacePath, 'continue', options)`:

- Require `status === 'recoveryRequired'` with `recovery.operation === 'create'`, then acquire a `recover` lock.
- For every missing worktree, query its branch.
- If the branch is already registered at the exact recorded target, mark `worktreeCreated: true` and continue; this closes the Git-success/state-write crash window idempotently.
- If the branch exists and is unoccupied, add the worktree with `createBranch: false`.
- If the branch is absent and `branchExistedBefore` is false, recreate it from the recorded immutable `baseCommit` with `createBranch: true`.
- If a pre-existing branch is now absent or any branch is occupied elsewhere, retain `recoveryRequired` and throw a conflict.
- Journal every step, regenerate `AGENTS.md`, and finish at `ready`.

For `'rollback'`, run the same guarded reverse rollback routine. Return `undefined` only when cleanup completed and generated metadata was removed.

- [ ] **Step 6: Run focused and full checks**

Run: `npm test -- src/workspace/workspace-orchestrator.test.ts`

Expected: PASS for success, all failure points, reverse order, branch preservation, and both recovery actions.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/workspace/workspace-orchestrator.ts src/workspace/workspace-orchestrator.test.ts
git commit -m "feat: create workspaces with rollback and recovery"
```

---

### Task 9: Inspect, Resume, and Finish Requirement Workspaces

**Files:**
- Create: `src/workspace/workspace-lifecycle.ts`
- Test: `src/workspace/workspace-lifecycle.test.ts`
- Modify: `src/domain/types.ts`

**Interfaces:**
- Consumes: repository status/worktree methods, state locks, and context generation from Tasks 4–6.
- Produces: `WorkspaceInspection`, `WorkspaceLifecycle.inspect()`, `resume()`, and `finish()`.

- [ ] **Step 1: Write failing lifecycle tests**

Cover the approved safety behavior:

```ts
it('resumes a finished workspace from retained branches', async () => {
  repositories.getBranchInfo.mockResolvedValue({ exists: true, head: oid });
  const resumed = await lifecycle.resume(workspacePath, options);
  expect(repositories.addWorktree).toHaveBeenCalledWith(
    expect.objectContaining({ createBranch: false, branch: 'feature/REQ-123' })
  );
  expect(resumed.status).toBe('ready');
  expect(resumed.openCodexOnNextActivation).toBe(true);
});

it('blocks finish when any repository is dirty', async () => {
  repositories.getStatus.mockResolvedValue({
    dirtyFileCount: 2,
    publication: 'synced',
    ahead: 0,
    behind: 0
  });
  await expect(lifecycle.finish(workspacePath, options))
    .rejects.toMatchObject({ code: 'CONFLICT' });
  expect(repositories.removeWorktree).not.toHaveBeenCalled();
});

it.each(['ahead', 'no-upstream'] as const)('requires confirmation for %s branches', async publication => {
  repositories.getStatus.mockResolvedValue({
    dirtyFileCount: 0,
    publication,
    ahead: publication === 'ahead' ? 2 : 0,
    behind: 0
  });
  await lifecycle.finish(workspacePath, { ...options, confirmUnpublished: async () => false });
  expect(repositories.removeWorktree).not.toHaveBeenCalled();
});
```

Also test normal ready-state inspection, a missing worktree, a branch occupied elsewhere, clean/synced finish, partial finish failure, retained branch verification, and finished-state metadata preservation.

- [ ] **Step 2: Run the tests and verify the expected failure**

Run: `npm test -- src/workspace/workspace-lifecycle.test.ts`

Expected: FAIL because `WorkspaceLifecycle` does not exist.

- [ ] **Step 3: Define inspection contracts**

Append:

```ts
export type RepositoryWorkspaceHealth =
  | 'ready'
  | 'dirty'
  | 'unpublished'
  | 'missing'
  | 'occupied'
  | 'unavailable';

export interface InspectedRepository {
  state: WorkspaceRepositoryState;
  health: RepositoryWorkspaceHealth;
  git?: RepositoryStatus;
  message?: string;
}

export interface WorkspaceInspection {
  state: WorkspaceState;
  repositories: InspectedRepository[];
}
```

- [ ] **Step 4: Implement inspection and resume**

Use this public API:

```ts
export interface LifecycleOptions {
  signal?: AbortSignal;
  onProgress?: (progress: WorkspaceProgress) => void;
  confirmBreakStaleLock: (lock: WorkspaceLockInfo) => Promise<boolean>;
}

export interface FinishOptions extends LifecycleOptions {
  confirmUnpublished: (repositories: InspectedRepository[]) => Promise<boolean>;
}

export class WorkspaceLifecycle {
  constructor(
    private readonly repositories: Pick<RepositoryService,
      'getBranchInfo' | 'addWorktree' | 'removeWorktree' | 'getStatus'>,
    private readonly states: StateStore,
    private readonly agents: AgentsGenerator,
    private readonly paths: PathProbe = new NodePathProbe(),
    private readonly now: () => Date = () => new Date()
  ) {}

  inspect(workspacePath: string): Promise<WorkspaceInspection>;
  resume(workspacePath: string, options: LifecycleOptions): Promise<WorkspaceState>;
  finish(workspacePath: string, options: FinishOptions): Promise<WorkspaceState>;
}
```

`inspect()` reads state and evaluates every repository independently. A missing worktree path is `missing`; a branch registered to another path is `occupied`; otherwise call `getStatus()` and map dirty first, then ahead/no-upstream to `unpublished`, then `ready`. Convert access/Git errors to `unavailable` with redacted messages while continuing the other repositories.

`resume()` accepts `ready`, `finished`, or `recoveryRequired` only when `recovery.operation` is `resume` or `finish`; creation recovery remains owned by `WorkspaceOrchestrator`. Acquire a `recover` lock and, for each missing worktree, require the retained branch to exist and be unoccupied, require the target path not to exist, then call `addWorktree({ createBranch: false, ... })`. It must never recreate a missing retained branch from the old base. Journal each addition; on partial failure record `recovery.operation: 'resume'`. On success regenerate `AGENTS.md`, set `ready`, clear `recovery`, set `openCodexOnNextActivation: true`, then persist.

- [ ] **Step 5: Implement safe finish behavior**

`finish()` accepts `ready` or `recoveryRequired` with `recovery.operation === 'finish'`, then:

1. Acquires a `finish` lock and inspects all repositories.
2. Rejects any `dirty`, `occupied`, or `unavailable` item without removing anything.
3. Collects `unpublished` items and calls `confirmUnpublished()` once. If declined, throw `AiWorkspaceError('CANCELLED', 'Finish cancelled')` and perform no removals.
4. Sequentially calls non-force `removeWorktree()` for every existing worktree, marks `worktreeCreated: false`, and persists after each removal.
5. On a partial error, records `recoveryRequired` plus `recovery.operation: 'finish'`; it does not restore already removed clean worktrees and does not remove any branch.
6. On success, sets `finished`, `openCodexOnNextActivation: false`, clears `recovery`, and preserves `.ai-workspace.json`, `AGENTS.md`, and all local branches.

- [ ] **Step 6: Run focused and full checks**

Run: `npm test -- src/workspace/workspace-lifecycle.test.ts`

Expected: PASS for inspect, resume, finish guards, cancellation, partial failure, and branch preservation.

Run: `npm run check`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/workspace/workspace-lifecycle.ts src/workspace/workspace-lifecycle.test.ts src/domain/types.ts
git commit -m "feat: resume and safely finish requirement workspaces"
```

---

### Task 10: Add the VS Code Wizard, Commands, Folder Opening, and Codex Handoff

**Files:**
- Create: `src/ui/vscode-ui.ts`
- Create: `src/ui/new-requirement-wizard.ts`
- Create: `src/ui/new-requirement-wizard.test.ts`
- Create: `src/ui/codex-integration.ts`
- Create: `src/ui/codex-integration.test.ts`
- Create: `src/ui/command-controller.ts`
- Create: `src/ui/command-controller.test.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: every core service from Tasks 2–9.
- Produces: five registered VS Code commands, the new-requirement wizard, new-window opening, recovery prompts, safe error presentation, and a best-effort Codex sidebar handoff in the newly opened window.

- [ ] **Step 1: Write failing wizard tests**

Define a small prompt port so wizard tests never import `vscode`:

```ts
it('preselects a preset and defaults each base to its remote trunk', async () => {
  prompts.queuePreset('auto');
  prompts.queueRepositories(['quote', 'web']);
  repositories.detectRemoteTrunk
    .mockResolvedValueOnce('origin/main')
    .mockResolvedValueOnce('upstream/trunk');
  repositories.listRemoteBranches
    .mockResolvedValueOnce(['origin/main', 'origin/release'])
    .mockResolvedValueOnce(['upstream/trunk']);

  const result = await wizard.collectDetails('REQ-123', config);
  expect(result).toMatchObject({
    requirement: { id: 'REQ-123' },
    selections: [
      { repositoryId: 'quote', baseRef: 'origin/main' },
      { repositoryId: 'web', baseRef: 'upstream/trunk' }
    ]
  });
});

it('asks for and persists a missing local repository path', async () => {
  prompts.queueRepositoryFolder('/code/quote');
  await wizard.collectDetails('REQ-123', configWithMissingQuotePath);
  expect(configService.setRepositoryPath).toHaveBeenCalledWith('quote', '/code/quote');
});
```

Add tests for cancellation at every screen, no preset, manual repository changes, no detectable remote branches, and a final creation summary that labels reused branches.

- [ ] **Step 2: Define the prompt port and implement the wizard**

Use these contracts in `src/ui/new-requirement-wizard.ts`:

```ts
export interface SelectableItem {
  id: string;
  label: string;
  description?: string;
  picked?: boolean;
}

export interface WizardPromptPort {
  input(prompt: string, value?: string): Promise<string | undefined>;
  pickOne(prompt: string, items: SelectableItem[]): Promise<string | undefined>;
  pickMany(prompt: string, items: SelectableItem[]): Promise<string[] | undefined>;
  pickFolder(prompt: string): Promise<string | undefined>;
  confirm(message: string, confirmLabel: string): Promise<boolean>;
}

export class NewRequirementWizard {
  constructor(
    private readonly prompts: WizardPromptPort,
    private readonly repositories: Pick<RepositoryService,
      'detectRemoteTrunk' | 'listRemoteBranches'>,
    private readonly configs: Pick<ConfigService, 'setRepositoryPath'>
  ) {}

  promptRequirementId(): Promise<string | undefined>;
  collectDetails(
    requirementId: string,
    config: EffectiveConfig
  ): Promise<CreationRequest | undefined>;
  confirmPlan(plan: CreationPlan): Promise<boolean>;
}
```

`collectDetails()` follows the approved order: title, preset, multi-select repositories, missing-path location, then one base selector per repository. For a missing path, update a cloned in-memory `EffectiveConfig` and ask whether to persist it; call `setRepositoryPath()` only when the user confirms. Put the detected trunk first and mark it picked; add it to the choices if it is not present in local remote refs. If neither a trunk nor any remote branch is detectable, use `input()` for an explicit `<remote>/<branch>` and require the configured remote prefix. Return `undefined` on cancellation without running Git mutations.

`confirmPlan()` shows workspace path, shared branch, every base, and `create` versus `reuse` disposition in one modal confirmation.

- [ ] **Step 3: Implement the concrete VS Code prompt/progress adapter**

In `src/ui/vscode-ui.ts`, map the prompt port to `window.showInputBox`, `window.showQuickPick`, and `window.showOpenDialog`. Use `QuickPickItem.picked` for preset defaults and `canPickMany: true` for repositories. Folder selection must use `canSelectFolders: true`, `canSelectFiles: false`, and one selection.

Also export:

```ts
export interface ProgressExecution {
  signal: AbortSignal;
  report(progress: WorkspaceProgress): void;
}

export function withWorkspaceProgress<T>(
  title: string,
  operation: (execution: ProgressExecution) => Promise<T>
): Promise<T>;

export function showWorkspaceError(error: unknown, output: vscode.OutputChannel): Promise<void>;
```

`withWorkspaceProgress()` uses `window.withProgress({ location: ProgressLocation.Notification, cancellable: true })`, bridges `CancellationToken` to an `AbortController`, and renders repository ID plus message. `showWorkspaceError()` writes redacted diagnostic details to the Output Channel and shows a short actionable notification.

- [ ] **Step 4: Write and implement Codex handoff tests**

Test a pure resolver plus the integration adapter:

```ts
it('finds the installed OpenAI command by its contributed title', () => {
  expect(findCodexOpenCommand({
    id: 'openai.chatgpt',
    packageJSON: {
      contributes: {
        commands: [{ command: 'openai.codex.open', title: 'Codex: Open Codex Sidebar' }]
      }
    }
  }, ['openai.codex.open'])).toBe('openai.codex.open');
});

it('returns undefined when no single public contributed command can be identified', () => {
  expect(findCodexOpenCommand(undefined, [])).toBeUndefined();
});
```

Implement `src/ui/codex-integration.ts`:

```ts
export function findCodexOpenCommand(
  extension: { id: string; packageJSON: unknown } | undefined,
  registeredCommands: readonly string[]
): string | undefined;

export class CodexIntegration {
  constructor(private readonly states: StateStore) {}
  openSidebarOrGuide(): Promise<'opened' | 'guided'>;
  handlePendingWorkspaceOpen(): Promise<void>;
}
```

Resolver rules:

1. Inspect only extension ID `openai.chatgpt`.
2. Read its declared `contributes.commands` array.
3. Prefer a command whose literal title equals `Codex: Open Codex Sidebar` case-insensitively.
4. Otherwise accept exactly one contributed command whose ID or literal title contains `open` and either `sidebar` or `codex`.
5. Execute it only if it also appears in `vscode.commands.getCommands(true)`.
6. If no unique command is found, show “工作区已创建，请运行 Codex: Open Codex Sidebar” with an “打开命令面板” action that invokes the stable built-in `workbench.action.showCommands`.

`handlePendingWorkspaceOpen()` runs only when the current VS Code window has one root containing `.ai-workspace.json` with `openCodexOnNextActivation: true`. Persist that flag as false before attempting the handoff so reloads cannot loop. Respect the `aiWorkspace.codex.autoOpen` setting, defaulting to true.

- [ ] **Step 5: Write failing command-controller tests**

Cover both key paths:

```ts
it('opens an existing requirement immediately after its id is entered', async () => {
  states.readIfExists.mockResolvedValue(existingReadyState);
  await controller.newRequirement();
  expect(wizard.collectDetails).not.toHaveBeenCalled();
  expect(lifecycle.resume).toHaveBeenCalledWith(existingReadyState.workspacePath, expect.anything());
  expect(windowPort.openFolder).toHaveBeenCalledWith(existingReadyState.workspacePath, true);
});

it('creates and opens a new requirement in one command', async () => {
  states.readIfExists.mockResolvedValue(undefined);
  wizard.collectDetails.mockResolvedValue(request);
  planner.plan.mockResolvedValue(plan);
  wizard.confirmPlan.mockResolvedValue(true);
  orchestrator.create.mockResolvedValue(readyState);
  await controller.newRequirement();
  expect(windowPort.openFolder).toHaveBeenCalledWith(readyState.workspacePath, true);
});
```

Add cases for all three `recovery.operation` routes (`create`, `resume`, and `finish`), wizard cancellation, open-existing selection, finish confirmation, stale-lock confirmation, config editing, and typed error display.

- [ ] **Step 6: Implement controller workflows and window opening**

Define:

```ts
export interface WorkspaceWindowPort {
  openFolder(folderPath: string, forceNewWindow: boolean): Promise<void>;
  openTextFile(filePath: string): Promise<void>;
}

export class CommandController {
  newRequirement(): Promise<void>;
  openRequirement(workspacePath?: string): Promise<void>;
  refreshStatus(): Promise<void>;
  finishRequirement(workspacePath?: string): Promise<void>;
  editConfiguration(): Promise<void>;
}
```

`newRequirement()` ensures and loads config, then prompts only for the ID first. If state already exists, route `ready`/`finished` through lifecycle resume. For `recoveryRequired`, route `create` recovery to orchestrator `continue`/`rollback`; route `finish` recovery to “continue finish” or “restore workspace”; route `resume` recovery back through lifecycle resume. Open the parent only when a usable workspace remains. Only a genuinely new ID proceeds through details, planning, summary confirmation, transactional creation, and parent-folder opening.

`openRequirement()` lists `StateStore.list(workspaceRoot)` when no path argument is supplied, resumes the selected workspace as needed, and opens it. `finishRequirement()` defaults to the current root when it contains state, otherwise asks from the list. `editConfiguration()` calls `ensureLocalConfig()` and opens the YAML text document.

The concrete window port opens the new window with:

```ts
await vscode.commands.executeCommand(
  'vscode.openFolder',
  vscode.Uri.file(folderPath),
  { forceNewWindow }
);
```

The old Extension Host must not try to open Codex after this call; the persisted activation flag lets the new window do that.

- [ ] **Step 7: Register commands and compose services**

Add to `package.json`:

```json
{
  "activationEvents": [
    "onCommand:aiWorkspace.newRequirement",
    "onCommand:aiWorkspace.openRequirement",
    "onCommand:aiWorkspace.refreshStatus",
    "onCommand:aiWorkspace.finishRequirement",
    "onCommand:aiWorkspace.editConfiguration",
    "workspaceContains:.ai-workspace.json"
  ],
  "contributes": {
    "commands": [
      { "command": "aiWorkspace.newRequirement", "title": "AI Workspace: New Requirement" },
      { "command": "aiWorkspace.openRequirement", "title": "AI Workspace: Open Requirement" },
      { "command": "aiWorkspace.refreshStatus", "title": "AI Workspace: Refresh Status" },
      { "command": "aiWorkspace.finishRequirement", "title": "AI Workspace: Finish Requirement" },
      { "command": "aiWorkspace.editConfiguration", "title": "AI Workspace: Edit Configuration" }
    ],
    "configuration": {
      "title": "AI Workspace",
      "properties": {
        "aiWorkspace.codex.autoOpen": {
          "type": "boolean",
          "default": true,
          "description": "Open the Codex sidebar after a requirement workspace opens."
        }
      }
    }
  }
}
```

In `activate()`, construct one Output Channel, `ConfigService(os.homedir())`, `GitClient`, `RepositoryService`, `StateStore`, `AgentsGenerator`, `CreationPlanner`, `WorkspaceOrchestrator`, `WorkspaceLifecycle`, wizard, Codex adapter, and controller. Register all five commands in `context.subscriptions`, then invoke `handlePendingWorkspaceOpen()` without blocking activation. Register the Output Channel for disposal.

- [ ] **Step 8: Run focused and full checks**

Run: `npm test -- src/ui/new-requirement-wizard.test.ts src/ui/codex-integration.test.ts src/ui/command-controller.test.ts`

Expected: PASS for new/resume/recovery/cancellation flows and Codex open/fallback behavior.

Run: `npm run check && npm run build`

Expected: PASS and the bundled extension contains no test files.

- [ ] **Step 9: Commit**

```bash
git add package.json src/extension.ts src/ui
git commit -m "feat: add VS Code requirement workspace workflow"
```

---

### Task 11: Add the Multi-Repository Status Tree

**Files:**
- Create: `src/ui/workspace-tree-provider.ts`
- Test: `src/ui/workspace-tree-provider.test.ts`
- Modify: `src/ui/command-controller.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `StateStore.list()`, `WorkspaceLifecycle.inspect()`, and the open/refresh commands.
- Produces: `WorkspaceTreeProvider.refresh()`, requirement nodes, repository health nodes, and the “AI Workspaces” Explorer view.

- [ ] **Step 1: Write failing tree-model tests**

Use a fake state list and inspections:

```ts
it('shows every requirement and repository health without hiding failures', async () => {
  states.list.mockResolvedValue([readyState, recoveryState]);
  lifecycle.inspect
    .mockResolvedValueOnce(readyInspection)
    .mockResolvedValueOnce(recoveryInspection);

  await provider.refresh();
  const requirements = await provider.getChildren();
  expect(requirements.map(node => node.label)).toEqual([
    'REQ-123  Quote change',
    'REQ-122  Previous change'
  ]);
  const repositories = await provider.getChildren(requirements[0]);
  expect(repositories.map(node => [node.label, node.health])).toEqual([
    ['quote', 'ready'],
    ['web', 'dirty']
  ]);
});
```

Add tests for `ahead`, `no-upstream`, missing, unavailable, finished, and recovery-required icons/descriptions, plus an open command containing the exact workspace path.

- [ ] **Step 2: Implement a cached TreeDataProvider**

Define discriminated node types and provider:

```ts
export type WorkspaceTreeNode = RequirementTreeNode | RepositoryTreeNode;

export class WorkspaceTreeProvider implements vscode.TreeDataProvider<WorkspaceTreeNode> {
  constructor(
    private readonly getConfig: () => Promise<EffectiveConfig>,
    private readonly states: Pick<StateStore, 'list'>,
    private readonly lifecycle: Pick<WorkspaceLifecycle, 'inspect'>
  ) {}

  readonly onDidChangeTreeData: vscode.Event<WorkspaceTreeNode | undefined>;
  refresh(): Promise<void>;
  getTreeItem(element: WorkspaceTreeNode): vscode.TreeItem;
  getChildren(element?: WorkspaceTreeNode): Promise<WorkspaceTreeNode[]>;
}
```

`refresh()` loads and inspects all workspaces once, caches results, and fires the emitter. Root children are requirement nodes in state order; child nodes are repositories in recorded order. One failed inspection becomes an `unavailable` child and does not abort the rest.

Use `ThemeIcon` mappings: `pass` for ready/synced, `edit` for dirty, `cloud-upload` for unpublished, `warning` for recovery/missing/occupied, `error` for unavailable, and `archive` for finished. Requirement nodes use `TreeItemCollapsibleState.Collapsed` and command `aiWorkspace.openRequirement` with the exact workspace path. Repository descriptions show branch plus dirty count or ahead count.

- [ ] **Step 3: Contribute and wire the Explorer view**

Merge these contributions into the existing `contributes` object:

```json
{
  "views": {
    "explorer": [
      {
        "id": "aiWorkspace.requirements",
        "name": "AI Workspaces",
        "when": "workspaceFolderCount != 0"
      }
    ]
  },
  "menus": {
    "view/title": [
      {
        "command": "aiWorkspace.refreshStatus",
        "when": "view == aiWorkspace.requirements",
        "group": "navigation"
      }
    ]
  }
}
```

Register the provider with `window.registerTreeDataProvider('aiWorkspace.requirements', provider)`. Inject `provider.refresh` into the command controller; call it after create, resume, recover, finish, and the explicit refresh command. Initial activation starts one refresh and reports errors only to the Output Channel.

- [ ] **Step 4: Run focused and full checks**

Run: `npm test -- src/ui/workspace-tree-provider.test.ts`

Expected: PASS for hierarchy, commands, labels, all health mappings, and partial inspection failures.

Run: `npm run check && npm run build`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json src/extension.ts src/ui
git commit -m "feat: show multi-repository workspace status"
```

---

### Task 12: Verify the Complete Workflow, Document It, and Package the VSIX

**Files:**
- Create: `test/helpers/git-fixture.ts`
- Create: `test/integration/multi-repo-workspace.test.ts`
- Create: `tsconfig.vscode-test.json`
- Create: `test/vscode/runTest.ts`
- Create: `test/vscode/suite/index.ts`
- Create: `test/vscode/suite/extension.test.ts`
- Create: `.vscodeignore`
- Create: `.github/workflows/ci.yml`
- Create: `README.md`
- Create: `CHANGELOG.md`
- Modify: `package.json`
- Modify: `tsconfig.json`
- Modify: `vitest.config.ts`

**Interfaces:**
- Consumes: the complete extension.
- Produces: real multi-repository Git verification, Extension Host smoke coverage, cross-platform CI, user documentation, and `ai-workspace.vsix`.

- [ ] **Step 1: Write a reusable real-Git fixture**

Implement `createGitFixture(root, name, defaultBranch, extraBranches)` in `test/helpers/git-fixture.ts` using `NodeCommandRunner` and `node:fs/promises`. It must:

1. Create a seed repository with `git init -b <defaultBranch>`.
2. Set repository-local `user.name` to `AI Workspace Test` and `user.email` to `ai-workspace@example.invalid`.
3. Commit `README.md` on the default branch.
4. Create a local bare remote `<name>.git`.
5. Add it as `origin`, push the default branch, and set the bare repository's `HEAD` to `refs/heads/<defaultBranch>`.
6. Create, commit, and push every requested extra branch.
7. Clone the bare remote into `<name>-source`.
8. Return `{ sourcePath, remotePath, defaultRef: 'origin/<defaultBranch>' }`.

All test-process calls use the same argument-array runner as production. No fixture calls a shell.

- [ ] **Step 2: Write full-workflow Git integration tests**

Create `test/integration/multi-repo-workspace.test.ts`:

```ts
it('creates, finishes, and resumes three independent repositories', async () => {
  const quote = await createGitFixture(root, 'quote', 'main', ['release']);
  const order = await createGitFixture(root, 'order', 'trunk', []);
  const web = await createGitFixture(root, 'web', 'main', ['release']);
  const config = effectiveConfig(root, { quote, order, web });

  await expect(repositories.detectRemoteTrunk(quote.sourcePath, 'origin'))
    .resolves.toBe('origin/main');
  await expect(repositories.detectRemoteTrunk(order.sourcePath, 'origin'))
    .resolves.toBe('origin/trunk');

  const plan = await planner.plan({
    requirement: { id: 'REQ-123', title: 'Cross-repository quote change' },
    config,
    selections: [
      { repositoryId: 'quote', baseRef: 'origin/main' },
      { repositoryId: 'order', baseRef: 'origin/trunk' },
      { repositoryId: 'web', baseRef: 'origin/release' }
    ]
  });
  const created = await orchestrator.create(plan, orchestrationOptions);

  expect(created.status).toBe('ready');
  expect(created.repositories).toHaveLength(3);
  for (const repository of created.repositories) {
    await expect(stat(repository.worktreePath)).resolves.toBeDefined();
    expect((await git.exec(repository.worktreePath, ['branch', '--show-current'])).stdout.trim())
      .toBe('feature/REQ-123');
    expect((await git.exec(repository.worktreePath, ['rev-parse', 'HEAD'])).stdout.trim())
      .toBe(repository.baseCommit);
  }

  const finished = await lifecycle.finish(created.workspacePath, finishOptions);
  expect(finished.status).toBe('finished');
  const resumed = await lifecycle.resume(created.workspacePath, lifecycleOptions);
  expect(resumed.status).toBe('ready');
});
```

Add a second real-Git test that injects a failure on the second `addWorktree()` call after allowing the first real call. Assert the first worktree is gone, its `feature/REQ-123` ref is absent, pre-existing branches remain, and no valid workspace state remains after complete rollback.

- [ ] **Step 3: Run the integration tests and fix only contract mismatches**

Run: `npm test -- test/integration/multi-repo-workspace.test.ts`

Expected: PASS if all fake-driven contracts match real Git. If a real command/parser/state mismatch appears, keep the failing assertion as the regression test.

Make the smallest production correction consistent with the approved interfaces. Do not weaken assertions or add force deletion. Rerun the same command until both real-Git cases pass on the current platform.

- [ ] **Step 4: Add an Extension Host smoke test**

Create `tsconfig.vscode-test.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "out-test",
    "rootDir": ".",
    "types": ["node", "vscode", "mocha"]
  },
  "include": ["test/vscode/**/*.ts"]
}
```

Create `test/vscode/runTest.ts`:

```ts
import path from 'node:path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index');
  await runTests({ extensionDevelopmentPath, extensionTestsPath });
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
```

Create `test/vscode/suite/index.ts`:

```ts
import path from 'node:path';
import Mocha from 'mocha';

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 30_000 });
  mocha.addFile(path.resolve(__dirname, 'extension.test.js'));
  await new Promise<void>((resolve, reject) => {
    mocha.run(failures => {
      if (failures > 0) reject(new Error(`${failures} Extension Host test(s) failed`));
      else resolve();
    });
  });
}
```

Create `test/vscode/suite/extension.test.ts`:

```ts
import assert from 'node:assert/strict';
import * as vscode from 'vscode';

suite('AI Workspace extension', () => {
  test('registers all public commands', async () => {
    const extension = vscode.extensions.getExtension('ai-workspace-tools.ai-workspace');
    assert.ok(extension);
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const command of [
      'aiWorkspace.newRequirement',
      'aiWorkspace.openRequirement',
      'aiWorkspace.refreshStatus',
      'aiWorkspace.finishRequirement',
      'aiWorkspace.editConfiguration'
    ]) {
      assert.ok(commands.includes(command), `Missing command: ${command}`);
    }
  });
});
```

Extend the main `tsconfig.json` include list to `src/**/*.ts`, `test/helpers/**/*.ts`, `test/integration/**/*.ts`, and `vitest.config.ts`. Set `vitest.config.ts` to:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    exclude: ['test/vscode/**', 'node_modules/**', 'dist/**'],
    testTimeout: 30_000
  }
});
```

Add scripts:

```json
{
  "compile:vscode-tests": "tsc -p tsconfig.vscode-test.json",
  "test:vscode": "npm run build && npm run compile:vscode-tests && node out-test/test/vscode/runTest.js"
}
```

- [ ] **Step 5: Document installation, configuration, and safety semantics**

Write `README.md` in Chinese with these exact sections:

1. “它解决什么问题”：one requirement, many worktrees, one parent folder, one VS Code window, one Codex chat.
2. “前置条件”：desktop VS Code 1.102+, Git with worktree support, existing local clones, Codex extension ID `openai.chatgpt` optional but recommended.
3. “安装”：install the generated VSIX through “Extensions: Install from VSIX”.
4. “团队配置”：the approved `ai-workspace.yaml` example.
5. “本地配置”：the approved `~/.config/ai-workspace/config.yaml` example and precedence `team < local < wizard`.
6. “新需求”：the exact five-screen flow and resulting directory tree.
7. “恢复与结束”：repeat-ID resume, dirty-state block, unpublished warning, retained branch, and finished-workspace reconstruction.
8. “Codex”：why the common parent is opened, how parent/nested `AGENTS.md` rules apply, and the fallback command `Codex: Open Codex Sidebar`.
9. “安全边界”：no force removal, no auto clone/commit/push/PR, no cross-repository atomic commit, no credential storage.
10. “故障恢复”：meaning and actions for `recoveryRequired`, active lock, stale lock, occupied branch, and missing retained branch.
11. “本地开发”：`npm ci`, `npm run check`, `npm run test:vscode`, `npm run package`, and F5 Extension Development Host.

Write `CHANGELOG.md` with version `0.1.0` listing create, resume, status, finish, shared/local configuration, rollback/recovery, and Codex handoff.

- [ ] **Step 6: Add package exclusions and cross-platform CI**

Set `.vscodeignore` to exclude source, tests, local output, CI metadata, and design docs while retaining `dist/extension.js`, `package.json`, `README.md`, and `CHANGELOG.md`:

```text
.github/**
.vscode-test/**
docs/**
node_modules/**
out-test/**
src/**
test/**
coverage/**
*.vsix
esbuild.mjs
tsconfig*.json
vitest.config.ts
```

Change the package script to produce a deterministic filename:

```json
"package": "npm run check && npm run build -- --production && vsce package --out ai-workspace.vsix"
```

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20.19.0
          cache: npm
      - run: npm ci
      - run: npm run check
      - run: npm run build -- --production
      - if: runner.os == 'Linux'
        run: xvfb-run -a npm run test:vscode
      - if: runner.os != 'Linux'
        run: npm run test:vscode
      - if: runner.os == 'Linux'
        run: npm run package
      - if: runner.os == 'Linux'
        uses: actions/upload-artifact@v4
        with:
          name: ai-workspace-vsix
          path: ai-workspace.vsix
```

- [ ] **Step 7: Run final automated verification**

Run in a clean dependency state:

```bash
npm ci
npm run typecheck
npm test
npm run build -- --production
npm run test:vscode
npm run package
```

Expected:

- TypeScript reports zero errors.
- All unit and real-Git integration tests pass.
- Extension Host finds all five commands.
- `dist/extension.js` exists.
- `ai-workspace.vsix` is created.
- `npx vsce ls` contains runtime metadata, README, changelog, and `dist/extension.js`, but excludes `src`, `test`, local config, and design documents.

- [ ] **Step 8: Perform the manual acceptance smoke test**

In an Extension Development Host with three disposable local clones:

1. Configure one preset and three local repository paths.
2. Run `AI Workspace: New Requirement` for `REQ-123`.
3. Verify every base defaults to that repository's remote trunk; change one repository to a different remote branch.
4. Confirm one parent folder opens in a new window and contains three worktrees, `.ai-workspace.json`, and `AGENTS.md`.
5. Open one Codex chat and ask it to list all three repositories; verify it can read each one.
6. Modify one file in two different repositories and confirm the Tree View reports both independently.
7. Verify finish is blocked while changes are dirty.
8. Revert the disposable changes, finish, and verify worktrees are removed but all requirement branches and metadata remain.
9. Enter `REQ-123` again and verify all three worktrees are restored rather than duplicated.
10. Force one disposable creation failure and verify automatic rollback leaves the source checkouts and pre-existing branches unchanged.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json tsconfig.vscode-test.json vitest.config.ts test .vscodeignore .github README.md CHANGELOG.md
git commit -m "test: verify and package AI Workspace extension"
```

---

## Requirement-to-Task Traceability

| Approved requirement | Implemented and verified by |
| --- | --- |
| One requirement parent containing multiple worktrees | Tasks 7, 8, 12 |
| One VS Code window and one Codex chat across repositories | Tasks 6, 10, 12 |
| Shared branch name with per-repository base refs | Tasks 1, 7, 12 |
| Remote trunk default for every repository | Tasks 4, 10 |
| Shared team configuration plus local override | Task 2 |
| Repeat-ID resume | Tasks 9, 10, 12 |
| Creation progress, cancellation, rollback, and recovery | Tasks 5, 8, 10 |
| Multi-repository status display | Tasks 9, 11 |
| Dirty/unpublished finish guards and retained branches | Tasks 4, 9, 12 |
| No shell interpolation or credential leakage | Tasks 1, 3, 4, 12 |
| macOS, Linux, and Windows support | Tasks 1, 3, 5, 12 |
| No auto clone/commit/push/PR or cross-repository atomic commit | Global constraints, Tasks 6, 9, 12 |

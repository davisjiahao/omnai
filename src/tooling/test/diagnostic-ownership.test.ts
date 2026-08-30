import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  canonicalRepositoryRelativePath,
  evaluateTransitionOwnership,
  extractExplicitPlanPaths,
  findUnparsedTypeScriptDiagnosticLines,
  parseTypeScriptDiagnosticHeadlines,
  type TransitionOwnershipEntry,
} from '../diagnostic-ownership.js';

// 背景：Plan01 收紧 final-v0.3 模型后，全仓存在跨 Plans02–09 的已知 TypeScript 迁移债务。
// 目的：测试直接约束诊断归属门的可观察结果，防止未知路径、已过 owner 或新增诊断被“未来计划”标签掩盖。
// 上下文：所有期望值都由手写 diagnostic headline 和 literal owner 表独立给出，不复用生产解析器生成预期。
const OWNERSHIP: readonly TransitionOwnershipEntry[] = [
  { path: 'src/core/context.ts', owner: 'P02', action: 'REPAIR' },
  { path: 'src/core/writer.ts', owner: 'P04', action: 'REPAIR' },
  { path: 'src/execution/legacy.ts', owner: 'P07', action: 'EXCLUDE_UNCHANGED' },
  { path: 'test/legacy.test.ts', owner: 'P09', action: 'MIGRATE_OR_DELETE' },
];

const cleanupDirectories: string[] = [];
const transitionScript = resolve(process.cwd(), 'scripts/check-v0.3-transition-ownership.mjs');

afterEach(async () => {
  while (cleanupDirectories.length > 0) {
    const directory = cleanupDirectories.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

async function transitionCliFixture(
  diagnostics: string,
  closed: readonly string[] = [],
  supplementalAction = 'EXCLUDE_UNCHANGED',
  overlapOwners: readonly { readonly path: string; readonly owner: string }[] = [],
  includeOverlappingPlan = false,
): Promise<{
  readonly root: string;
  readonly manifest: string;
  readonly diagnosticsFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'omnai-transition-cli-'));
  cleanupDirectories.push(root);
  const plans = join(root, 'plans');
  await mkdir(plans, { recursive: true });
  await writeFile(join(plans, 'p02.md'), [
    '# P02',
    '**Files:**',
    '- Modify: `src/core/context.ts`',
  ].join('\n'), 'utf8');
  if (includeOverlappingPlan) {
    await writeFile(join(plans, 'p03.md'), [
      '# P03',
      '**Files:**',
      '- Modify: `src/core/context.ts`',
    ].join('\n'), 'utf8');
  }
  const manifest = join(root, 'manifest.json');
  await writeFile(manifest, JSON.stringify({
    schemaVersion: 1,
    baseline: {
      commit: 'fixture',
      diagnostics: 2,
      files: 2,
      diagnosticCounts: {
        'src/core/context.ts': 1,
        'src/execution/legacy.ts': 1,
      },
    },
    planFiles: [
      { owner: 'P02', path: 'plans/p02.md' },
      ...(includeOverlappingPlan ? [{ owner: 'P03', path: 'plans/p03.md' }] : []),
    ],
    overlapOwners,
    supplemental: [
      {
        path: 'src/execution/legacy.ts',
        owner: 'P07',
        action: supplementalAction,
      },
    ],
    closed,
  }, null, 2), 'utf8');
  const diagnosticsFile = join(root, 'diagnostics.log');
  await writeFile(diagnosticsFile, diagnostics, 'utf8');
  return { root, manifest, diagnosticsFile };
}

function runTransitionCli(fixture: {
  readonly root: string;
  readonly manifest: string;
  readonly diagnosticsFile: string;
}, completedThrough = 'P01') {
  return spawnSync(process.execPath, [
    transitionScript,
    `--completed-through=${completedThrough}`,
    `--repo-root=${fixture.root}`,
    `--manifest=${fixture.manifest}`,
    `--diagnostics-file=${fixture.diagnosticsFile}`,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

async function replaceFixturePlanPath(
  manifestPath: string,
  path: string,
): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    readonly planFiles: Array<{ owner: string; path: string }>;
  };
  const firstPlan = manifest.planFiles[0];
  assert.ok(firstPlan);
  firstPlan.path = path;
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

test('解析 Unix 与 Windows 相对路径时保留真实位置、错误码和正文', () => {
  const diagnostics = parseTypeScriptDiagnosticHeadlines([
    "src/core/context.ts(10,20): error TS2339: Property 'head' does not exist.",
    "src\\core\\writer.ts(3,4): error TS2345: Argument is not assignable.",
    './src/core/store.ts(5,6): error TS2322: Store shape is not assignable.',
    "  Type '{ legacy: true }' is missing required fields.",
    '普通日志行',
  ].join('\n'));

  assert.deepEqual(diagnostics, [
    {
      path: 'src/core/context.ts',
      line: 10,
      column: 20,
      code: 'TS2339',
      message: "Property 'head' does not exist.",
    },
    {
      path: 'src/core/writer.ts',
      line: 3,
      column: 4,
      code: 'TS2345',
      message: 'Argument is not assignable.',
    },
    {
      path: 'src/core/store.ts',
      line: 5,
      column: 6,
      code: 'TS2322',
      message: 'Store shape is not assignable.',
    },
  ]);
});

test('识别无法归属到文件的 TypeScript diagnostic 行', () => {
  const unparsed = findUnparsedTypeScriptDiagnosticLines([
    'src/core/context.ts(1,1): error TS2339: known path',
    "error TS2688: Cannot find type definition file for 'missing-types'.",
    "  The file is in the program because: Entry point of type library 'missing-types'",
  ].join('\n'));

  assert.deepEqual(unparsed, [
    "error TS2688: Cannot find type definition file for 'missing-types'.",
  ]);
});

test('仓库相对路径拒绝绝对、遍历、点段与空段 token', () => {
  assert.equal(canonicalRepositoryRelativePath('src\\core\\context.ts'), 'src/core/context.ts');
  for (const path of [
    '',
    '/src/core/context.ts',
    'C:\\repo\\src\\core\\context.ts',
    'C:src\\core\\context.ts',
    '../outside.ts',
    'src/../outside.ts',
    './src/core/context.ts',
    'src//core/context.ts',
  ]) {
    assert.throws(
      () => canonicalRepositoryRelativePath(path),
      /TRANSITION_OWNERSHIP_INVALID_REPOSITORY_PATH/,
      path,
    );
  }
});

test('显式计划文件提取只接受 exact Files 行并移除行号范围', () => {
  const paths = extractExplicitPlanPaths([
    '- Modify: `src/core/not-in-files-section.ts`',
    '**Files:**',
    '- Create: `src/core/context.ts`',
    '- Modify: `src/core/writer.ts:10-40,55-60`',
    '- Test: `src/core/test/context.test.ts`',
    '- Create: ten `resources/authority/compilers/*.fn.js` files',
    '- Modify: legacy tests identified later',
    '**Interfaces:**',
    '- Modify: `src/core/also-not-in-files-section.ts`',
  ].join('\n'));

  assert.deepEqual(paths, [
    'src/core/context.ts',
    'src/core/test/context.test.ts',
    'src/core/writer.ts',
  ]);
});

test('未来 owner 可以保留已知债务并按路径精确计数', () => {
  const diagnostics = parseTypeScriptDiagnosticHeadlines([
    'src/core/writer.ts(1,1): error TS2339: first',
    'src/core/writer.ts(2,2): error TS2345: second',
    'test/legacy.test.ts(3,3): error TS2322: third',
  ].join('\n'));

  const result = evaluateTransitionOwnership({
    completedThrough: 'P02',
    diagnostics,
    ownership: OWNERSHIP.map((entry): TransitionOwnershipEntry => (
      entry.path === 'src/core/context.ts' ? { ...entry, action: 'CLOSED' } : entry
    )),
    baselineDiagnosticCounts: {
      'src/core/writer.ts': 2,
      'test/legacy.test.ts': 1,
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.diagnostics, 3);
  assert.equal(result.files, 2);
  assert.deepEqual(result.futureOwned, [
    { path: 'src/core/writer.ts', count: 2, owner: 'P04', action: 'REPAIR' },
    { path: 'test/legacy.test.ts', count: 1, owner: 'P09', action: 'MIGRATE_OR_DELETE' },
  ]);
  assert.deepEqual(result.pastOwnerDiagnostics, []);
  assert.deepEqual(result.unownedDiagnostics, []);
  assert.deepEqual(result.openPastOwnership, []);
});

test('未知 diagnostic path 立即阻止 transition', () => {
  const result = evaluateTransitionOwnership({
    completedThrough: 'P01',
    diagnostics: parseTypeScriptDiagnosticHeadlines(
      'src/unknown.ts(1,1): error TS2307: Cannot find module.',
    ),
    ownership: OWNERSHIP,
    baselineDiagnosticCounts: {},
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.unownedDiagnostics, [{ path: 'src/unknown.ts', count: 1 }]);
});

test('已完成 owner 的任一残留 diagnostic 阻止 transition', () => {
  const result = evaluateTransitionOwnership({
    completedThrough: 'P04',
    diagnostics: parseTypeScriptDiagnosticHeadlines(
      'src/core/writer.ts(1,1): error TS2322: stale owner debt',
    ),
    ownership: OWNERSHIP,
    baselineDiagnosticCounts: { 'src/core/writer.ts': 1 },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.pastOwnerDiagnostics, [
    { path: 'src/core/writer.ts', count: 1, owner: 'P04', action: 'REPAIR' },
  ]);
});

test('Execution 退休债务在 P07 前单列但仍属于未来 owner', () => {
  const result = evaluateTransitionOwnership({
    completedThrough: 'P01',
    diagnostics: parseTypeScriptDiagnosticHeadlines(
      'src/execution/legacy.ts(1,1): error TS2339: legacy shape',
    ),
    ownership: OWNERSHIP,
    baselineDiagnosticCounts: { 'src/execution/legacy.ts': 1 },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.executionBlockedDiagnostics, [
    {
      path: 'src/execution/legacy.ts',
      count: 1,
      owner: 'P07',
      action: 'EXCLUDE_UNCHANGED',
    },
  ]);
});

test('同一路径诊断超过冻结基线时阻止 transition', () => {
  const result = evaluateTransitionOwnership({
    completedThrough: 'P01',
    diagnostics: parseTypeScriptDiagnosticHeadlines([
      'src/core/context.ts(1,1): error TS2339: first',
      'src/core/context.ts(2,2): error TS2339: regression',
    ].join('\n')),
    ownership: OWNERSHIP,
    baselineDiagnosticCounts: { 'src/core/context.ts': 1 },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.regressions, [
    { path: 'src/core/context.ts', baseline: 1, actual: 2 },
  ]);
});

test('此前无诊断的已规划路径新增错误时按基线零阻止 transition', () => {
  const result = evaluateTransitionOwnership({
    completedThrough: 'P01',
    diagnostics: parseTypeScriptDiagnosticHeadlines(
      'src/core/context.ts(1,1): error TS2339: newly introduced debt',
    ),
    ownership: OWNERSHIP,
    baselineDiagnosticCounts: {},
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.regressions, [
    { path: 'src/core/context.ts', baseline: 0, actual: 1 },
  ]);
});

test('重复 manifest path 被视为配置错误而不是选择任一 owner', () => {
  assert.throws(
    () => evaluateTransitionOwnership({
      completedThrough: 'P01',
      diagnostics: [],
      ownership: [
        ...OWNERSHIP,
        { path: 'src/core/context.ts', owner: 'P03', action: 'REPAIR' },
      ],
      baselineDiagnosticCounts: {},
    }),
    /TRANSITION_OWNERSHIP_DUPLICATE_PATH: src\/core\/context\.ts/,
  );
});

test('owner 阶段已完成时即使诊断清零，未关闭的生命周期债务仍阻止 transition', () => {
  const result = evaluateTransitionOwnership({
    completedThrough: 'P07',
    diagnostics: [],
    ownership: [
      { path: 'src/execution/legacy.ts', owner: 'P07', action: 'EXCLUDE_UNCHANGED' },
    ],
    baselineDiagnosticCounts: { 'src/execution/legacy.ts': 1 },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.openPastOwnership,
    [
      { path: 'src/execution/legacy.ts', owner: 'P07', action: 'EXCLUDE_UNCHANGED' },
    ],
  );
});

test('显式 CLOSED 记录允许对应 owner 阶段在诊断清零后通过', () => {
  const result = evaluateTransitionOwnership({
    completedThrough: 'P07',
    diagnostics: [],
    ownership: [
      { path: 'src/execution/legacy.ts', owner: 'P07', action: 'CLOSED' },
    ],
    baselineDiagnosticCounts: { 'src/execution/legacy.ts': 1 },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    result.openPastOwnership,
    [],
  );
});

test('CLOSED 记录在 owner 尚未来到时也不能携带残留诊断', () => {
  const result = evaluateTransitionOwnership({
    completedThrough: 'P01',
    diagnostics: parseTypeScriptDiagnosticHeadlines(
      'src/execution/legacy.ts(1,1): error TS2339: closed but unresolved',
    ),
    ownership: [
      { path: 'src/execution/legacy.ts', owner: 'P07', action: 'CLOSED' },
    ],
    baselineDiagnosticCounts: { 'src/execution/legacy.ts': 1 },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.closedDiagnostics,
    [
      { path: 'src/execution/legacy.ts', count: 1, owner: 'P07', action: 'CLOSED' },
    ],
  );
});

test('transition CLI 对已归属债务输出稳定摘要并以零退出', async () => {
  const fixture = await transitionCliFixture([
    'src/core/context.ts(1,1): error TS2339: context debt',
    'src/execution/legacy.ts(2,2): error TS2339: execution debt',
  ].join('\n'));

  const result = runTransitionCli(fixture);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.signal, null);
  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.deepEqual(output, {
    schemaVersion: 1,
    completedThrough: 'P01',
    diagnostics: 2,
    files: 2,
    futureOwned: { diagnostics: 2, files: 2 },
    pastOwner: { diagnostics: 0, files: 0 },
    unowned: { diagnostics: 0, files: 0 },
    executionBlocked: { diagnostics: 1, files: 1 },
    openOwnership: { entries: 0 },
    closedWithDiagnostics: { diagnostics: 0, files: 0 },
    regressions: [],
  });
});

test('transition CLI 遇到未知路径时输出归属失败并以一退出', async () => {
  const fixture = await transitionCliFixture(
    'src/unknown.ts(1,1): error TS2307: unknown debt',
  );

  const result = runTransitionCli(fixture);

  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout) as {
    readonly unowned: { readonly diagnostics: number; readonly files: number };
  };
  assert.deepEqual(output.unowned, { diagnostics: 1, files: 1 });
});

test('transition CLI 不允许已到期但尚未 CLOSED 的零诊断条目通过', async () => {
  const fixture = await transitionCliFixture('', ['src/core/context.ts']);

  const result = runTransitionCli(fixture, 'P07');

  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout) as {
    readonly openOwnership: { readonly entries: number };
  };
  assert.deepEqual(output.openOwnership, { entries: 1 });
});

test('transition CLI 应用 closed 清单后允许零诊断条目通过', async () => {
  const fixture = await transitionCliFixture('', [
    'src/core/context.ts',
    'src/execution/legacy.ts',
  ]);

  const result = runTransitionCli(fixture, 'P07');

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout) as {
    readonly openOwnership: { readonly entries: number };
  };
  assert.deepEqual(output.openOwnership, { entries: 0 });
});

test('transition CLI 拒绝 manifest 中未定义的 action', async () => {
  const fixture = await transitionCliFixture('', [], 'NOT_A_REAL_ACTION');

  const result = runTransitionCli(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /TRANSITION_OWNERSHIP_MANIFEST_INVALID: supplemental action/);
});

test('transition CLI 要求 CLOSED 只能通过 closed 清单表达', async () => {
  const fixture = await transitionCliFixture('', [], 'CLOSED');

  const result = runTransitionCli(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /TRANSITION_OWNERSHIP_MANIFEST_INVALID: supplemental action/);
});

test('transition CLI 遇到跨计划重叠但没有显式 owner 时失败关闭', async () => {
  const fixture = await transitionCliFixture('', [], 'EXCLUDE_UNCHANGED', [], true);

  const result = runTransitionCli(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /TRANSITION_OWNERSHIP_AMBIGUOUS_PLAN_PATH: src\/core\/context\.ts/);
});

test('transition CLI 接受属于重叠 claim 的显式 owner', async () => {
  const fixture = await transitionCliFixture(
    'src/core/context.ts(1,1): error TS2339: context debt',
    [],
    'EXCLUDE_UNCHANGED',
    [{ path: 'src/core/context.ts', owner: 'P02' }],
    true,
  );

  const result = runTransitionCli(fixture);

  assert.equal(result.status, 0, result.stderr);
});

test('transition CLI 对已解析与无路径 diagnostic 的混合输出失败关闭', async () => {
  const fixture = await transitionCliFixture([
    'src/core/context.ts(1,1): error TS2339: context debt',
    "error TS2688: Cannot find type definition file for 'missing-types'.",
  ].join('\n'));

  const result = runTransitionCli(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /TRANSITION_OWNERSHIP_UNPARSED_DIAGNOSTIC: error TS2688/);
});

test('transition CLI 在读取计划前拒绝跳出仓库的 manifest path', async () => {
  const fixture = await transitionCliFixture('');
  await replaceFixturePlanPath(fixture.manifest, '../outside.md');

  const result = runTransitionCli(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /TRANSITION_OWNERSHIP_INVALID_REPOSITORY_PATH/);
});

test('transition CLI 拒绝通过仓库内 symlink 读取仓库外计划', async () => {
  const fixture = await transitionCliFixture('');
  const outsideRoot = await mkdtemp(join(tmpdir(), 'omnai-transition-outside-'));
  cleanupDirectories.push(outsideRoot);
  const outsidePlan = join(outsideRoot, 'outside.md');
  await writeFile(outsidePlan, [
    '# Outside',
    '**Files:**',
    '- Modify: `src/core/context.ts`',
  ].join('\n'), 'utf8');
  await symlink(outsidePlan, join(fixture.root, 'plans', 'outside.md'));
  await replaceFixturePlanPath(fixture.manifest, 'plans/outside.md');

  const result = runTransitionCli(fixture);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /TRANSITION_OWNERSHIP_PLAN_PATH_OUTSIDE_REPOSITORY/);
});

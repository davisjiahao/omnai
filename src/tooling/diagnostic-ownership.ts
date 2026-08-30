export type TransitionPhase =
  | 'P01'
  | 'P02'
  | 'P03'
  | 'P04'
  | 'P05'
  | 'P06'
  | 'P07'
  | 'P08'
  | 'P09';

export type TransitionOwnershipAction =
  | 'REPAIR'
  | 'MIGRATE_OR_DELETE'
  | 'EXCLUDE_UNCHANGED'
  | 'CLOSED';

export interface TypeScriptDiagnosticHeadline {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly code: `TS${number}`;
  readonly message: string;
}

export interface TransitionOwnershipEntry {
  readonly path: string;
  readonly owner: TransitionPhase;
  readonly action: TransitionOwnershipAction;
}

export interface TransitionDiagnosticGroup extends TransitionOwnershipEntry {
  readonly count: number;
}

export interface TransitionOwnershipResult {
  readonly ok: boolean;
  readonly diagnostics: number;
  readonly files: number;
  readonly futureOwned: readonly TransitionDiagnosticGroup[];
  readonly pastOwnerDiagnostics: readonly TransitionDiagnosticGroup[];
  readonly unownedDiagnostics: readonly { readonly path: string; readonly count: number }[];
  readonly executionBlockedDiagnostics: readonly TransitionDiagnosticGroup[];
  readonly closedDiagnostics: readonly TransitionDiagnosticGroup[];
  readonly openPastOwnership: readonly TransitionOwnershipEntry[];
  readonly regressions: readonly {
    readonly path: string;
    readonly baseline: number;
    readonly actual: number;
  }[];
}

export interface EvaluateTransitionOwnershipInput {
  readonly completedThrough: TransitionPhase;
  readonly diagnostics: readonly TypeScriptDiagnosticHeadline[];
  readonly ownership: readonly TransitionOwnershipEntry[];
  readonly baselineDiagnosticCounts: Readonly<Record<string, number>>;
}

const PHASES: readonly TransitionPhase[] = [
  'P01',
  'P02',
  'P03',
  'P04',
  'P05',
  'P06',
  'P07',
  'P08',
  'P09',
];

const DIAGNOSTIC_HEADLINE = /^(.*)\((\d+),(\d+)\): error (TS\d+): (.*)$/u;
const TYPESCRIPT_DIAGNOSTIC_MARKER = /(?:^|\s)error TS\d+:/u;
const EXPLICIT_FILE = /^- (?:Create|Modify|Delete|Test): `([^`]+)`/u;
const SOURCE_LOCATION_SUFFIX = /:\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u;

// 背景：diagnostic 在不同宿主上可能使用正斜杠或反斜杠，但 owner token 必须始终留在仓库内。
// 目的：建立唯一的仓库相对路径，并在任何 Map/文件读取之前拒绝绝对路径、点段与空段。
// 上下文：真实文件的 symlink 边界由 CLI 在 realpath 后再次认证；本纯函数也供 evaluator 使用。
export function canonicalRepositoryRelativePath(value: string): string {
  const normalized = value.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    normalized.length === 0
    || normalized.startsWith('/')
    || /^[A-Za-z]:/u.test(normalized)
    || normalized.includes('\0')
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`TRANSITION_OWNERSHIP_INVALID_REPOSITORY_PATH: ${value}`);
  }
  return normalized;
}

function canonicalTypeScriptDiagnosticPath(value: string): string {
  const slashNormalized = value.replaceAll('\\', '/');
  const withoutSingleLeadingDot = slashNormalized.startsWith('./')
    ? slashNormalized.slice(2)
    : slashNormalized;
  return canonicalRepositoryRelativePath(withoutSingleLeadingDot);
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function phaseIndex(phase: TransitionPhase): number {
  const index = PHASES.indexOf(phase);
  if (index < 0) throw new Error(`TRANSITION_OWNERSHIP_INVALID_PHASE: ${phase}`);
  return index;
}

export function parseTypeScriptDiagnosticHeadlines(
  text: string,
): readonly TypeScriptDiagnosticHeadline[] {
  const diagnostics: TypeScriptDiagnosticHeadline[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = DIAGNOSTIC_HEADLINE.exec(line);
    if (!match) continue;
    const [, rawPath, rawLine, rawColumn, rawCode, message] = match;
    if (
      rawPath === undefined
      || rawLine === undefined
      || rawColumn === undefined
      || rawCode === undefined
      || message === undefined
    ) {
      continue;
    }
    diagnostics.push({
      path: canonicalTypeScriptDiagnosticPath(rawPath),
      line: Number(rawLine),
      column: Number(rawColumn),
      code: rawCode as `TS${number}`,
      message,
    });
  }
  return diagnostics;
}

export function findUnparsedTypeScriptDiagnosticLines(text: string): readonly string[] {
  return text.split(/\r?\n/u).filter((line) => (
    TYPESCRIPT_DIAGNOSTIC_MARKER.test(line) && !DIAGNOSTIC_HEADLINE.test(line)
  ));
}

export function extractExplicitPlanPaths(markdown: string): readonly string[] {
  const paths = new Set<string>();
  let inFilesSection = false;
  for (const line of markdown.split(/\r?\n/u)) {
    if (line.trim() === '**Files:**') {
      inFilesSection = true;
      continue;
    }
    if (inFilesSection && (/^\*\*/u.test(line) || /^#{1,6}\s/u.test(line))) {
      inFilesSection = false;
    }
    if (!inFilesSection) continue;
    const match = EXPLICIT_FILE.exec(line);
    const rawPath = match?.[1];
    if (rawPath === undefined || rawPath.includes('*')) continue;
    const declaredPath = rawPath.replace(SOURCE_LOCATION_SUFFIX, '');
    const canonicalPath = canonicalRepositoryRelativePath(declaredPath);
    if (canonicalPath !== declaredPath) {
      throw new Error(`TRANSITION_OWNERSHIP_NON_CANONICAL_PLAN_PATH: ${declaredPath}`);
    }
    paths.add(canonicalPath);
  }
  return [...paths].sort(compareText);
}

export function evaluateTransitionOwnership(
  input: EvaluateTransitionOwnershipInput,
): TransitionOwnershipResult {
  const completedIndex = phaseIndex(input.completedThrough);
  const ownershipByPath = new Map<string, TransitionOwnershipEntry>();
  for (const rawEntry of input.ownership) {
    phaseIndex(rawEntry.owner);
    const path = canonicalRepositoryRelativePath(rawEntry.path);
    if (path !== rawEntry.path) {
      throw new Error(`TRANSITION_OWNERSHIP_NON_CANONICAL_OWNER_PATH: ${rawEntry.path}`);
    }
    const entry = { ...rawEntry, path };
    if (ownershipByPath.has(entry.path)) {
      throw new Error(`TRANSITION_OWNERSHIP_DUPLICATE_PATH: ${entry.path}`);
    }
    ownershipByPath.set(entry.path, entry);
  }

  const counts = new Map<string, number>();
  for (const diagnostic of input.diagnostics) {
    const path = canonicalTypeScriptDiagnosticPath(diagnostic.path);
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }

  const futureOwned: TransitionDiagnosticGroup[] = [];
  const pastOwnerDiagnostics: TransitionDiagnosticGroup[] = [];
  const unownedDiagnostics: Array<{ path: string; count: number }> = [];
  const executionBlockedDiagnostics: TransitionDiagnosticGroup[] = [];
  const closedDiagnostics: TransitionDiagnosticGroup[] = [];
  const openPastOwnership = [...ownershipByPath.values()]
    .filter((entry) => (
      phaseIndex(entry.owner) <= completedIndex && entry.action !== 'CLOSED'
    ))
    .sort((left, right) => compareText(left.path, right.path));
  const regressions: Array<{ path: string; baseline: number; actual: number }> = [];

  for (const [path, count] of [...counts].sort(([left], [right]) => compareText(left, right))) {
    const entry = ownershipByPath.get(path);
    if (!entry) {
      unownedDiagnostics.push({ path, count });
      continue;
    }

    const group: TransitionDiagnosticGroup = { ...entry, count };
    if (entry.action === 'CLOSED') closedDiagnostics.push(group);
    else if (phaseIndex(entry.owner) <= completedIndex) pastOwnerDiagnostics.push(group);
    else futureOwned.push(group);
    if (entry.action === 'EXCLUDE_UNCHANGED') executionBlockedDiagnostics.push(group);

    const baseline = input.baselineDiagnosticCounts[path] ?? 0;
    if (count > baseline) {
      regressions.push({ path, baseline, actual: count });
    }
  }

  return {
    ok: pastOwnerDiagnostics.length === 0
      && unownedDiagnostics.length === 0
      && closedDiagnostics.length === 0
      && openPastOwnership.length === 0
      && regressions.length === 0,
    diagnostics: input.diagnostics.length,
    files: counts.size,
    futureOwned,
    pastOwnerDiagnostics,
    unownedDiagnostics,
    executionBlockedDiagnostics,
    closedDiagnostics,
    openPastOwnership,
    regressions,
  };
}

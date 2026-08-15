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

export interface RepositorySelection {
  readonly repositoryId: string;
  readonly baseRef: string;
}

export interface PlannedRepository {
  readonly id: string;
  readonly displayName: string;
  readonly sourcePath: string;
  readonly worktreePath: string;
  readonly remote: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly branch: string;
  readonly branchDisposition: 'create' | 'reuse';
  readonly branchInitialCommit: string;
}

export interface CreationPlan {
  readonly requirement: Readonly<Requirement>;
  readonly workspacePath: string;
  readonly branchName: string;
  readonly repositories: readonly PlannedRepository[];
}

export interface WorkspaceProgress {
  readonly stage: 'preflight' | 'fetch' | 'create' | 'rollback' | 'resume' | 'finish';
  readonly repositoryId?: string;
  readonly message: string;
}

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

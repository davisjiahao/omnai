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

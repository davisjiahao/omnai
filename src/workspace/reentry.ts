export const REENTRY_KINDS = [
  'REALITY_CHANGED',
  'PRODUCT_CHANGED',
  'DOMAIN_CHANGED',
  'SCOPE_CHANGED',
  'TECHNICAL_CONSTRAINT_CHANGED',
  'NEEDS_EXPERIMENT',
  'PLAN_CHANGED',
  'IMPLEMENTATION_DETAIL_CHANGED',
] as const;

export type ReentryKind = (typeof REENTRY_KINDS)[number];
export type InteractionMode = 'none' | 'grill' | 'brainstorm';
export type ReentryCapability =
  | 'research'
  | 'frame'
  | 'model'
  | 'spec'
  | 'design'
  | 'experiment'
  | 'plan'
  | 'work';

export interface ReentryRoute {
  capability: ReentryCapability;
  interaction: InteractionMode;
  reason: string;
}

const ROUTES: Record<ReentryKind, ReentryRoute> = {
  REALITY_CHANGED: {
    capability: 'research',
    interaction: 'none',
    reason: 'Current-system reality changed or is no longer trustworthy.',
  },
  PRODUCT_CHANGED: {
    capability: 'frame',
    interaction: 'grill',
    reason: 'Product goal or user outcome changed and requires a new decision.',
  },
  DOMAIN_CHANGED: {
    capability: 'model',
    interaction: 'grill',
    reason: 'Domain meaning, ownership, lifecycle, or invariant changed.',
  },
  SCOPE_CHANGED: {
    capability: 'spec',
    interaction: 'grill',
    reason: 'Scope, acceptance criteria, or non-goals changed.',
  },
  TECHNICAL_CONSTRAINT_CHANGED: {
    capability: 'design',
    interaction: 'brainstorm',
    reason: 'A technical constraint invalidated the selected implementation approach.',
  },
  NEEDS_EXPERIMENT: {
    capability: 'experiment',
    interaction: 'none',
    reason: 'The remaining implementation choice requires measured evidence.',
  },
  PLAN_CHANGED: {
    capability: 'plan',
    interaction: 'none',
    reason: 'Only task structure, dependency order, or delivery sequencing changed.',
  },
  IMPLEMENTATION_DETAIL_CHANGED: {
    capability: 'work',
    interaction: 'none',
    reason: 'The change is bounded to implementation detail and does not reopen upstream decisions.',
  },
};

export function routeWorksetReentry(kind: ReentryKind): ReentryRoute {
  return ROUTES[kind];
}

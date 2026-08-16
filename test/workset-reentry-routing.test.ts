import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeWorksetReentry } from '../src/workspace/reentry.js';

test('routes structured mid-flight changes to existing capabilities and interaction modes', () => {
  assert.deepEqual(routeWorksetReentry('REALITY_CHANGED'), {
    capability: 'research',
    interaction: 'none',
    reason: 'Current-system reality changed or is no longer trustworthy.',
  });
  assert.deepEqual(routeWorksetReentry('PRODUCT_CHANGED'), {
    capability: 'frame',
    interaction: 'grill',
    reason: 'Product goal or user outcome changed and requires a new decision.',
  });
  assert.deepEqual(routeWorksetReentry('DOMAIN_CHANGED'), {
    capability: 'model',
    interaction: 'grill',
    reason: 'Domain meaning, ownership, lifecycle, or invariant changed.',
  });
  assert.deepEqual(routeWorksetReentry('SCOPE_CHANGED'), {
    capability: 'spec',
    interaction: 'grill',
    reason: 'Scope, acceptance criteria, or non-goals changed.',
  });
  assert.deepEqual(routeWorksetReentry('TECHNICAL_CONSTRAINT_CHANGED'), {
    capability: 'design',
    interaction: 'brainstorm',
    reason: 'A technical constraint invalidated the selected implementation approach.',
  });
  assert.deepEqual(routeWorksetReentry('NEEDS_EXPERIMENT'), {
    capability: 'experiment',
    interaction: 'none',
    reason: 'The remaining implementation choice requires measured evidence.',
  });
  assert.deepEqual(routeWorksetReentry('PLAN_CHANGED'), {
    capability: 'plan',
    interaction: 'none',
    reason: 'Only task structure, dependency order, or delivery sequencing changed.',
  });
  assert.deepEqual(routeWorksetReentry('IMPLEMENTATION_DETAIL_CHANGED'), {
    capability: 'work',
    interaction: 'none',
    reason: 'The change is bounded to implementation detail and does not reopen upstream decisions.',
  });
});

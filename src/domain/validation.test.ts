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

  it.each([
    '../REQ-1',
    'REQ/1',
    '.',
    '..',
    'CON',
    'CON.txt',
    'COM0',
    'COM0.txt',
    'LPT0',
    'LPT0.log',
    'REQ.',
    'R'.repeat(256)
  ])('rejects %s', value => {
    expect(() => normalizeRequirementId(value)).toThrow();
  });

  it('accepts an id at the portable component length limit', () => {
    const value = 'R'.repeat(255);
    expect(normalizeRequirementId(value)).toBe(value);
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

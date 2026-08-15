import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { capabilityPrompt } from '../src/core/prompts.js';
import { CAPABILITIES } from '../src/domain/types.js';

test('every capability prompt carries the human-readable communication contract', () => {
  for (const capability of CAPABILITIES) {
    const prompt = capabilityPrompt(capability, 'Do the work.', 'Produce the canonical output.');

    assert.match(prompt, /lead with the conclusion/i, capability);
    assert.match(prompt, /first use of a specialized term or acronym/i, capability);
    assert.match(prompt, /retain the canonical term.*searchable/i, capability);
    assert.match(prompt, /observable outcomes, trade-offs, and user impact/i, capability);
    assert.match(prompt, /smallest useful visual/i, capability);
    assert.match(prompt, /tables for exact comparisons/i, capability);
    assert.match(prompt, /Mermaid.*flows, hierarchy, state, or relationships/i, capability);
    assert.match(prompt, /do not ban necessary terminology/i, capability);
  }
});

test('the canonical Router exposes read-only Explain mode without expanding the Host Skill surface', async () => {
  const content = await readFile(join(process.cwd(), 'skills', 'omnai', 'SKILL.md'), 'utf8');

  assert.match(content, /^name:\s*omnai$/m);
  assert.match(content, /Explain \/ Show-me protocol/i);
  assert.match(content, /read-only presentation mode/i);
  assert.match(content, /Do not create a Project Change/i);
  assert.match(content, /advance readiness/i);
  assert.match(content, /first use.*canonical term/i);
  assert.match(content, /table.*exact comparison/i);
  assert.match(content, /Mermaid.*flow.*hierarchy.*state/i);
  assert.match(content, /decorative visuals/i);
  assert.match(content, /unknowns instead of guessing/i);
});

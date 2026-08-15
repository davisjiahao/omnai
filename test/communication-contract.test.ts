import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadProtocolBundle } from '../src/protocols/index.js';

test('the canonical common protocol carries the human-readable communication contract', async () => {
  const prompt = (await loadProtocolBundle([])).rendered;

  assert.match(prompt, /lead with the conclusion/i);
  assert.match(prompt, /first use of a specialized term or acronym/i);
  assert.match(prompt, /retain the canonical term.*searchable/i);
  assert.match(prompt, /observable outcomes, trade-offs, and user impact/i);
  assert.match(prompt, /smallest useful visual/i);
  assert.match(prompt, /tables for exact comparisons/i);
  assert.match(prompt, /Mermaid.*flows, hierarchy, state, or relationships/i);
  assert.match(prompt, /do not ban necessary terminology/i);
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

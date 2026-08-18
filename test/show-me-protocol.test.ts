import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';
import { CAPABILITIES, readinessSchema } from '../src/domain/types.js';
import {
  PROTOCOL_INTERACTIONS,
  WORKSET_PROTOCOL_ACTIONS,
  loadProtocol,
  loadProtocolBundle,
  protocolRelativePath,
  type ProtocolInteraction,
} from '../src/protocols/index.js';
import { worksetReentrySchema, type InteractionMode } from '../src/workspace/reentry.js';

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends
  (<Value>() => Value extends Right ? 1 : 2) ? true : false;

test('Show-me is one canonical presentation protocol with stable bundle order', async () => {
  assert.deepEqual(PROTOCOL_INTERACTIONS, ['grill', 'brainstorm', 'show-me']);
  assert.equal(protocolRelativePath('interaction.show-me'), 'interaction/show-me.md');

  const document = await loadProtocol('interaction.show-me');
  assert.deepEqual(
    { id: document.id, kind: document.kind, version: document.version },
    { id: 'interaction.show-me', kind: 'interaction', version: 1 },
  );
  assert.equal(document.sourcePath.endsWith(join('interaction', 'show-me.md')), true);
  const fullText = await readFile(document.sourcePath, 'utf8');
  assert.equal(document.hash, `sha256:${createHash('sha256').update(fullText).digest('hex')}`);
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fullText);
  assert.ok(frontmatter);
  assert.deepEqual(YAML.parse(frontmatter[1] ?? ''), {
    schemaVersion: 1,
    id: 'interaction.show-me',
    version: 1,
    kind: 'interaction',
    interaction: 'show-me',
  });

  const bundle = await loadProtocolBundle([
    'interaction.show-me',
    'repository.design',
    'interaction.show-me',
    'common.authoritative-work',
  ]);
  assert.deepEqual(bundle.protocols.map((item) => item.id), [
    'common.authoritative-work',
    'interaction.show-me',
    'repository.design',
  ]);
});

test('the npm package includes canonical protocol resources', async () => {
  const packageDocument = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as {
    files?: string[];
  };
  assert.ok(packageDocument.files?.includes('resources'));
});

test('Show-me does not expand workflow state or the four-Skill Host surface', async () => {
  const protocolInteractionTypeIsClosed: Equal<ProtocolInteraction, 'grill' | 'brainstorm' | 'show-me'> = true;
  const worksetInteractionTypeIsUnchanged: Equal<InteractionMode, 'none' | 'grill' | 'brainstorm'> = true;
  assert.equal(protocolInteractionTypeIsClosed, true);
  assert.equal(worksetInteractionTypeIsUnchanged, true);
  assert.equal((CAPABILITIES as readonly string[]).includes('show-me'), false);
  assert.equal((WORKSET_PROTOCOL_ACTIONS as readonly string[]).includes('show-me'), false);
  assert.equal(readinessSchema.keyof().options.includes('show-me' as never), false);

  const invalidReentry = worksetReentrySchema.safeParse({
    schemaVersion: 2,
    id: 'WRE-0001',
    worksetId: 'WKS-0001',
    kind: 'PLAN_CHANGED',
    reason: 'Delivery order changed.',
    route: {
      capability: 'plan',
      interaction: 'show-me',
      reason: 'Explain the route.',
    },
    affectedProjects: [],
    candidateProjects: [],
    status: 'PENDING',
    proposal: [],
    applications: [],
    rulesVersion: null,
    createdAt: '2026-08-15T00:00:00.000Z',
    decidedAt: null,
    resolvedAt: null,
  });
  assert.equal(invalidReentry.success, false);

  const skillRoot = join(process.cwd(), 'skills');
  const skillEntries = await readdir(skillRoot, { withFileTypes: true });
  const discoverable: string[] = [];
  for (const entry of skillEntries) {
    if (!entry.isDirectory()) continue;
    const files = await readdir(join(skillRoot, entry.name));
    if (files.includes('SKILL.md')) discoverable.push(entry.name);
  }
  assert.deepEqual(
    discoverable.sort(),
    ['omnai', 'omnai-brainstorm', 'omnai-grill', 'omnai-reconcile'],
  );
});

test('Show-me contains presentation choices, the built-in companion, and hard read-only boundaries', async () => {
  const content = (await loadProtocol('interaction.show-me')).content;
  for (const pattern of [
    /explicitly asks for an explanation, comparison, visualization, “show me”/i,
    /practical conclusion.*plain-language meaning/i,
    /specialized term.*first use.*canonical name/i,
    /exact constraints, evidence references, assumptions, exceptions, edge cases, and unknowns/i,
    /one fact.*prose or a short list/i,
    /exact alternatives.*Markdown table/i,
    /static flow, hierarchy, state transition, dependency.*Mermaid/i,
    /otherwise a compact labeled-text flow/i,
    /UI mockups, wireframes, layouts, navigation/i,
    /first adequate level/i,
    /just-in-time consent/i,
    /built-in OmnAI Visual Companion/i,
    /omnai visual validate.*--json/i,
    /omnai visual companion.*--json/i,
    /127\.0\.0\.1.*random, unguessable token/i,
    /never executes Agent-provided HTML or JavaScript/i,
    /no writable HTTP route/i,
    /Superpowers.*behavioral influence.*not.*runtime dependency/i,
    /two to four visual directions.*same frame and fidelity/i,
    /overview.*one changing dominant visual/i,
    /keyboard-accessible.*accessible text alternative/i,
    /presentation feedback only/i,
    /ephemeral, Host-owned, and noncanonical.*separately authorizes/i,
    /does not create a Workset, Project Change, Investigation, run, progress event/i,
    /state the gap and unknowns rather than guessing/i,
  ]) {
    assert.match(content, pattern);
  }
});

test('Show-me re-pitches an explicitly failed explanation and escalates repeated failures', async () => {
  const content = (await loadProtocol('interaction.show-me')).content;
  for (const pattern of [
    /Re-pitch after comprehension failure/i,
    /only when the user explicitly indicates that the current or previous explanation did not land/i,
    /Do not use this branch for a first explanation.*shorter summary/i,
    /where the conversation is now and why the subject matters/i,
    /restore the nearest missing premise.*merely deleting words/i,
    /one causal step at a time.*explicit referents/i,
    /plain-language gloss.*canonical term stable/i,
    /one small concrete example.*smallest adequate representation/i,
    /another comprehension failure.*step back farther or change the representation/i,
    /must not degrade into terse fragments/i,
    /does not infer or persist.*comprehension state/i,
  ]) {
    assert.match(content, pattern);
  }
  assert.doesNotMatch(content, /ASD-STE100|CONTEXT\.md/i);
});

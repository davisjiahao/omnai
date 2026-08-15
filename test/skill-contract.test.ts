import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import YAML from 'yaml';

const SKILLS = [
  'omnai',
  'omnai-brainstorm',
  'omnai-grill',
  'omnai-reconcile',
] as const;

interface ParsedSkill {
  name: string;
  description: string;
  body: string;
}

async function loadSkill(name: string): Promise<ParsedSkill> {
  const content = await readFile(join(process.cwd(), 'skills', name, 'SKILL.md'), 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
  assert.ok(match, `${name} must have YAML frontmatter`);
  const frontmatter = YAML.parse(match[1] ?? '') as { name?: unknown; description?: unknown };
  assert.equal(typeof frontmatter.name, 'string', `${name} frontmatter.name`);
  assert.equal(typeof frontmatter.description, 'string', `${name} frontmatter.description`);
  return {
    name: frontmatter.name as string,
    description: frontmatter.description as string,
    body: match[2] ?? '',
  };
}

test('all four canonical Skills have discoverable matching frontmatter and begin from Core context', async () => {
  for (const directory of SKILLS) {
    const skill = await loadSkill(directory);
    assert.equal(skill.name, directory);
    assert.match(skill.description, /^Use when\b/);
    assert.match(skill.body, /`omnai context --json`/);
  }
});

test('omnai is a thin deterministic router and does not pretend Milestone C Run support exists', async () => {
  const skill = await loadSkill('omnai');
  assert.match(skill.body, /`omnai workset next --json`/);
  assert.match(skill.body, /Do not invent .*workflow state in (chat|conversation)/i);
  assert.match(skill.body, /conversation .* not .*authoritative|conversation .*context/i);
  assert.match(skill.body, /Do not .*`omnai-run`.*Milestone C/i);
  assert.match(skill.body, /fresh verification evidence/i);
});

test('omnai-grill resolves only the blocking Decision Frontier one question at a time', async () => {
  const skill = await loadSkill('omnai-grill');
  assert.match(skill.body, /Decision Frontier/);
  assert.match(skill.body, /one question at a time/i);
  assert.match(skill.body, /product|domain|scope|ownership|lifecycle|invariant/i);
  assert.match(skill.body, /preserve .*already (settled|decided)|do not reopen .*settled/i);
  assert.match(skill.body, /return .*router|workset next/i);
});

test('omnai-brainstorm compares distinct viable approaches and escalates evidence-dependent choices', async () => {
  const skill = await loadSkill('omnai-brainstorm');
  assert.match(skill.body, /two or more materially (distinct|different).*viable approaches/i);
  assert.match(skill.body, /constraints.*criteria|criteria.*constraints/i);
  assert.match(skill.body, /recommend/i);
  assert.match(skill.body, /experiment/i);
  assert.match(skill.body, /upstream ambiguity.*grill|route.*grill/i);
});

test('omnai-reconcile follows the schema-v2 Workset lifecycle and leaves closure expansion to Core', async () => {
  const skill = await loadSkill('omnai-reconcile');
  for (const kind of [
    'REALITY_CHANGED',
    'PRODUCT_CHANGED',
    'DOMAIN_CHANGED',
    'SCOPE_CHANGED',
    'TECHNICAL_CONSTRAINT_CHANGED',
    'NEEDS_EXPERIMENT',
    'PLAN_CHANGED',
    'IMPLEMENTATION_DETAIL_CHANGED',
  ]) {
    assert.match(skill.body, new RegExp(kind));
  }
  assert.match(skill.body, /`omnai workset change/);
  assert.match(skill.body, /`omnai workset next --json`/);
  assert.match(skill.body, /reentry plan/);
  assert.match(skill.body, /explicit .*approval/i);
  assert.match(skill.body, /reentry decide/);
  assert.match(skill.body, /reentry apply/);
  assert.match(skill.body, /reentry replan/);
  assert.match(skill.body, /finalize-reentry/);
  assert.match(skill.body, /Core .*closure|closure .*Core/i);
  assert.match(skill.body, /Do not .*manual(ly)? .*closure|never .*expand .*closure/i);
  assert.match(skill.body, /Never .*reentry resolve.*schema-v2/i);
});

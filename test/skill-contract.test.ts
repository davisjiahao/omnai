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

const FINE_GRAINED_SKILL = /\bomnai-(?:frame|research|map|model|spec|design|plan|triage|reproduce|debug|diagnose|experiment|fix|mitigate|work|simplify|review|verify|qa|ship|release|canary|learn|archive)\b/i;

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

test('all four canonical Skills are thin protocol-aware entry points', async () => {
  for (const directory of SKILLS) {
    const skill = await loadSkill(directory);
    assert.equal(skill.name, directory);
    assert.match(skill.description, /^Use when\b/);
    assert.match(skill.body, /`omnai context --json`/);
    assert.match(skill.body, /`omnai protocol show\b/);
    assert.doesNotMatch(skill.body, /resources\/protocols/i);
    assert.doesNotMatch(skill.body, FINE_GRAINED_SKILL);
    assert.doesNotMatch(skill.body, /\bomnai-run\b/i);
    assert.match(skill.body, /Core|deterministic|authoritative/i);
  }
});

test('omnai is the thin Core-routed default entry including read-only Show-me composition', async () => {
  const skill = await loadSkill('omnai');
  assert.equal(
    skill.description,
    'Use when starting, resuming, inspecting, changing, explaining, comparing, or visualizing non-trivial engineering work in an OmnAI Workset or repository, including “show me,” “wait what,” or when a prior explanation did not land.',
  );
  assert.match(skill.body, /`omnai workset next --json`/);
  assert.match(skill.body, /`omnai next --json`/);
  assert.match(skill.body, /protocolIds/);
  assert.match(skill.body, /`omnai protocol show <protocolIds\.\.\.> --json`/);
  assert.match(skill.body, /interaction\.show-me/);
  assert.match(skill.body, /I do not understand.*wait what.*too much jargon.*prior explanation/is);
  assert.match(skill.body, /fresh .*next --json|run .*next --json.*again/i);
  assert.match(skill.body, /route remembered from (chat|conversation).*not authoritative|never use .*remembered.*route/i);
  assert.match(skill.body, /read-only|creates? no .*state|must not mutate/i);
  assert.match(skill.body, /Do not invent .*workflow state in (chat|conversation)/i);
  assert.match(skill.body, /fresh verification evidence/i);
  assert.doesNotMatch(skill.body, /Decision Frontier|one question at a time|two or more materially distinct viable approaches/i);
});

test('omnai-grill delegates its full method to interaction.grill and the active capability protocol', async () => {
  const skill = await loadSkill('omnai-grill');
  assert.match(skill.body, /`omnai workset next --json`/);
  assert.match(skill.body, /protocolIds/);
  assert.match(skill.body, /interaction\.grill/);
  assert.match(skill.body, /`omnai next --json`/);
  assert.match(skill.body, /repository capability protocol|repository\.\<capability\>|repository\.<capability>/i);
  assert.match(skill.body, /owning artifact|active capability/i);
  assert.match(skill.body, /return .*routing|run .*next --json.*again/i);
  assert.doesNotMatch(skill.body, /Decision Frontier|one question at a time|Questioning protocol/i);
});

test('omnai-brainstorm delegates its full method to interaction.brainstorm and the active capability protocol', async () => {
  const skill = await loadSkill('omnai-brainstorm');
  assert.match(skill.body, /`omnai workset next --json`/);
  assert.match(skill.body, /protocolIds/);
  assert.match(skill.body, /interaction\.brainstorm/);
  assert.match(skill.body, /`omnai next --json`/);
  assert.match(skill.body, /repository capability protocol|repository\.\<capability\>|repository\.<capability>/i);
  assert.match(skill.body, /owning artifact|active capability/i);
  assert.match(skill.body, /return .*routing|run .*next --json.*again/i);
  assert.doesNotMatch(skill.body, /Comparison protocol|evaluation criteria|migration and rollback behavior|Keep the option set/i);
});

test('omnai-reconcile keeps only safety and protocol-routing rules', async () => {
  const skill = await loadSkill('omnai-reconcile');
  assert.match(skill.body, /workset\.reentry-classification/);
  assert.match(skill.body, /`omnai workset next --json`/);
  assert.match(skill.body, /protocolIds/);
  assert.match(skill.body, /repository\.reconcile/);
  assert.match(skill.body, /preserve unaffected/i);
  assert.match(skill.body, /no silent .*bind|never silently bind/i);
  assert.match(skill.body, /no manual closure|do not manually .*closure/i);
  assert.match(skill.body, /explicit .*approval.*decide|decide.*explicit .*approval/i);
  assert.match(skill.body, /schema-v2.*direct resolve|direct resolve.*schema-v2/i);
  assert.match(skill.body, /stale precondition.*replan|replan.*stale precondition/i);
  assert.doesNotMatch(skill.body, /REALITY_CHANGED|PRODUCT_CHANGED|DOMAIN_CHANGED|SCOPE_CHANGED/);
  assert.doesNotMatch(skill.body, /reentry plan <WRE>|reentry apply <WRE>|attemptHistory/i);
});

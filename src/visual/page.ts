export const VISUAL_COMPANION_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OmnAI Visual Companion</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main id="omnai-visual-companion" aria-live="polite"></main>
  <script src="app.js" defer></script>
</body>
</html>
`;

export const VISUAL_COMPANION_CSS = `:root {
  color-scheme: light dark;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --background: #f7f7f5;
  --foreground: #20201d;
  --muted: #676761;
  --surface: #ffffff;
  --border: #d8d8d1;
  --accent: #315efb;
  --accent-foreground: #ffffff;
  --soft-accent: #e9eeff;
}
@media (prefers-color-scheme: dark) {
  :root {
    --background: #171716;
    --foreground: #f1f1ed;
    --muted: #b2b2aa;
    --surface: #222220;
    --border: #42423d;
    --accent: #87a1ff;
    --accent-foreground: #11121a;
    --soft-accent: #252d49;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--background); color: var(--foreground); }
main { width: min(100% - 32px, 960px); margin: 0 auto; padding: 32px 0 48px; }
h1, h2, h3, p { margin-top: 0; }
h1 { margin-bottom: 8px; font-size: clamp(1.5rem, 4vw, 2.25rem); font-weight: 600; }
h2 { font-size: 1.15rem; }
.summary, .muted { color: var(--muted); }
.summary { max-width: 72ch; margin-bottom: 24px; }
.directions { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
.direction, .flow-node, .step-panel {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 18px;
}
.direction[aria-current="true"] { border-color: var(--accent); box-shadow: 0 0 0 2px var(--soft-accent); }
.direction button { all: unset; display: block; width: 100%; cursor: pointer; }
.direction button:focus-visible, .controls button:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
.label { display: block; color: var(--muted); font-size: 0.78rem; letter-spacing: 0.04em; text-transform: uppercase; margin-bottom: 4px; }
.field { margin-top: 14px; }
ul { margin: 8px 0 0; padding-left: 20px; }
.flow { display: flex; align-items: stretch; gap: 10px; overflow-x: auto; padding-bottom: 8px; }
.flow-node { flex: 1 0 190px; position: relative; }
.flow.linear .flow-node:not(:last-child)::after { content: "→"; position: absolute; right: -18px; top: 50%; color: var(--muted); }
.relationships { margin-top: 18px; }
.relationship { padding: 8px 0; border-bottom: 1px solid var(--border); }
.status { display: inline-block; margin-bottom: 10px; padding: 3px 8px; border-radius: 999px; background: var(--soft-accent); }
.overview { margin-bottom: 16px; color: var(--muted); }
.controls { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.controls button {
  border: 1px solid var(--border); background: var(--surface); color: var(--foreground);
  border-radius: 8px; padding: 8px 12px; cursor: pointer;
}
.controls button:disabled { cursor: not-allowed; opacity: 0.45; }
.step-count { color: var(--muted); }
.error { color: #b42318; border-left: 4px solid currentColor; padding-left: 12px; }
@media (max-width: 560px) {
  main { width: min(100% - 24px, 960px); padding-top: 20px; }
  .flow { flex-direction: column; overflow: visible; }
  .flow-node { flex-basis: auto; }
  .flow.linear .flow-node:not(:last-child)::after { content: "↓"; right: 50%; top: auto; bottom: -18px; }
}
@media (prefers-reduced-motion: no-preference) {
  .direction, .step-panel { transition: border-color 160ms ease, box-shadow 160ms ease; }
}
`;

export const VISUAL_COMPANION_JS = `'use strict';
const root = document.getElementById('omnai-visual-companion');
let lastDocument = '';
let selectedDirection = 0;
let selectedStep = 0;

function labels(documentValue) {
  const chinese = /^zh(?:-|$)/i.test(documentValue.language || '');
  return chinese ? {
    directions: '视觉方向', emphasis: '重点', impact: '用户影响', tradeoff: '主要取舍',
    flow: '流程', relationships: '关系', previous: '上一步', next: '下一步', step: '步骤', of: '/',
  } : {
    directions: 'Visual directions', emphasis: 'Emphasis', impact: 'User impact', tradeoff: 'Main trade-off',
    flow: 'Flow', relationships: 'Relationships', previous: 'Previous', next: 'Next', step: 'Step', of: 'of',
  };
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function labeledField(label, value) {
  const field = element('div', 'field');
  field.append(element('span', 'label', label), element('div', '', value));
  return field;
}

function header(documentValue) {
  root.append(element('h1', '', documentValue.title));
  root.append(element('p', 'summary', documentValue.summary));
}

function renderDirections(documentValue) {
  const copy = labels(documentValue);
  selectedDirection = Math.min(selectedDirection, documentValue.directions.length - 1);
  const grid = element('section', 'directions');
  grid.setAttribute('aria-label', copy.directions);
  documentValue.directions.forEach((direction, index) => {
    const card = element('article', 'direction');
    card.setAttribute('aria-current', String(index === selectedDirection));
    const button = element('button', '');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(index === selectedDirection));
    button.append(element('h2', '', direction.name));
    button.addEventListener('click', () => { selectedDirection = index; render(documentValue); });
    card.append(button);
    card.append(labeledField(copy.emphasis, direction.emphasis));
    card.append(labeledField(copy.impact, direction.userImpact));
    card.append(labeledField(copy.tradeoff, direction.tradeoff));
    if (direction.details.length > 0) {
      const list = element('ul', '');
      direction.details.forEach((detail) => list.append(element('li', '', detail)));
      card.append(list);
    }
    grid.append(card);
  });
  root.append(grid);
}

function renderFlow(documentValue) {
  const copy = labels(documentValue);
  const flow = element('section', 'flow');
  flow.setAttribute('aria-label', copy.flow);
  const isLinear = documentValue.edges.length === documentValue.nodes.length - 1
    && documentValue.edges.every((edge, index) => edge.from === documentValue.nodes[index].id
      && edge.to === documentValue.nodes[index + 1].id);
  if (isLinear) flow.classList.add('linear');
  documentValue.nodes.forEach((item) => {
    const node = element('article', 'flow-node');
    if (item.status) node.append(element('span', 'status', item.status));
    node.append(element('h2', '', item.label), element('p', '', item.description));
    flow.append(node);
  });
  root.append(flow);
  const relationships = element('section', 'relationships');
  relationships.append(element('h2', '', copy.relationships));
  documentValue.edges.forEach((edge) => {
    relationships.append(element('div', 'relationship', edge.from + ' → ' + edge.to + (edge.label ? ' — ' + edge.label : '')));
  });
  root.append(relationships);
}

function renderStepThrough(documentValue) {
  const copy = labels(documentValue);
  selectedStep = Math.min(selectedStep, documentValue.steps.length - 1);
  root.append(element('p', 'overview', documentValue.overview));
  const controls = element('div', 'controls');
  const previous = element('button', '', copy.previous);
  previous.type = 'button';
  previous.disabled = selectedStep === 0;
  previous.addEventListener('click', () => { selectedStep -= 1; render(documentValue); });
  const next = element('button', '', copy.next);
  next.type = 'button';
  next.disabled = selectedStep === documentValue.steps.length - 1;
  next.addEventListener('click', () => { selectedStep += 1; render(documentValue); });
  controls.append(previous, element('span', 'step-count', copy.step + ' ' + (selectedStep + 1) + ' ' + copy.of + ' ' + documentValue.steps.length), next);
  root.append(controls);
  const step = documentValue.steps[selectedStep];
  const panel = element('section', 'step-panel');
  panel.append(element('h2', '', step.title), element('p', '', step.description));
  const list = element('ul', '');
  step.changes.forEach((change) => list.append(element('li', '', change)));
  panel.append(list);
  root.append(panel);
}

function render(documentValue) {
  document.documentElement.lang = documentValue.language || 'en';
  root.replaceChildren();
  header(documentValue);
  if (documentValue.kind === 'directions') renderDirections(documentValue);
  if (documentValue.kind === 'flow') renderFlow(documentValue);
  if (documentValue.kind === 'step-through') renderStepThrough(documentValue);
}

async function refresh() {
  try {
    const response = await fetch('document', { cache: 'no-store' });
    if (!response.ok) throw new Error('Document unavailable (' + response.status + ').');
    const documentValue = await response.json();
    const serialized = JSON.stringify(documentValue);
    if (serialized !== lastDocument) {
      lastDocument = serialized;
      render(documentValue);
    }
  } catch (error) {
    root.replaceChildren(element('p', 'error', error instanceof Error ? error.message : String(error)));
  }
}

refresh();
setInterval(refresh, 750);
`;

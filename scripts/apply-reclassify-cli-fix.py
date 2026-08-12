from pathlib import Path

path = Path('src/cli.ts')
text = path.read_text()

old_import = "import { reconcileChange } from './core/reconcile.js';"
new_import = "import { reconcileChange } from './core/reconcile.js';\nimport { reclassifyChange } from './core/reclassify.js';"
if new_import not in text:
    if old_import not in text:
        raise SystemExit('reconcile import not found')
    text = text.replace(old_import, new_import)

old_block = """scenarioCommand
  .command('select')
  .argument('<id>')
  .argument('[change]')
  .action(async (id: string, reference?: string) => {
    const repoRoot = findRepositoryRoot();
    const scenario = getScenario(id);
    const change = await resolveChange(repoRoot, reference);
    change.metadata.scenario = scenario.id;
    change.metadata.workMode = scenario.workMode;
    await saveChange(repoRoot, change);
    console.log(`Selected ${scenario.id} for ${change.metadata.id}. Re-run status and reconcile readiness before execution.`);
  });
"""
new_block = """scenarioCommand
  .command('select')
  .argument('<id>')
  .argument('[change]')
  .requiredOption('-r, --reason <reason>', 'Why the scenario classification changed')
  .action(async (id: string, reference: string | undefined, options: { reason: string }) => {
    const repoRoot = findRepositoryRoot();
    const change = await resolveChange(repoRoot, reference);
    const result = await reclassifyChange(repoRoot, change, id, options.reason);
    console.log(`Reclassified ${result.change.metadata.id} to ${result.change.metadata.scenario}.`);
    console.log(`Created ${result.reconcile.revision.id} / ${result.change.metadata.baseline} with L4 reconciliation.`);
    console.log(`Affected tasks: ${result.reconcile.affectedTasks.join(', ') || 'none'}`);
  });
"""
if new_block not in text:
    if old_block not in text:
        raise SystemExit('scenario select block not found')
    text = text.replace(old_block, new_block)

path.write_text(text)

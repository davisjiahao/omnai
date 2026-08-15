import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');
const context = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'info'
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}

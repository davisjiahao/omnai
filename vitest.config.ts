const { defineConfig } = require('vitest/config');

module.exports = defineConfig({
  test: {
    environment: 'node',
    exclude: ['test/vscode/**', 'node_modules/**', 'dist/**'],
    testTimeout: 30_000
  }
});

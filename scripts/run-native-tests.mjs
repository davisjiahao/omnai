import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// 背景：测试已迁移到模块目录，干净检出和打包安装都必须自行发现 dist 下的全部编译测试。
// 目的：以 UTF-16 代码单元稳定排序的递归清单运行每个 .test.js 文件恰好一次。
// 上下文：子进程的退出状态或信号是测试结果的一部分，runner 不得将其折叠为通用失败码。
const directory = resolve('dist');
const files = await findCompiledTestFiles(directory);

if (files.length === 0) {
  console.error(`No compiled test files found under ${directory}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: process.cwd(),
  stdio: 'inherit',
});

if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);

async function findCompiledTestFiles(rootDirectory) {
  const files = new Set();
  await collectCompiledTests(rootDirectory, files);
  return [...files].sort(compareText);
}

async function collectCompiledTests(currentDirectory, files) {
  let entries;
  try {
    entries = await readdir(currentDirectory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return;
    throw error;
  }
  entries.sort((left, right) => compareText(left.name, right.name));

  for (const entry of entries) {
    const path = join(currentDirectory, entry.name);
    if (entry.isDirectory()) {
      await collectCompiledTests(path, files);
    } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.add(resolve(path));
    }
  }
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

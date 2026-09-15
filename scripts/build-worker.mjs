import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
await build({ entryPoints: { worker: 'src/server/worker.ts', maintenance: 'src/server/cli/maintenance.ts', 'init-password': 'src/server/cli/init-password.ts' }, outdir: '.next/standalone', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['better-sqlite3'] });

// Next 已追踪 SQLite 的实际文件；独立 CLI 还需要 node_modules 根目录的包入口。
const require = createRequire(import.meta.url);
const sqlitePackage = path.dirname(require.resolve('better-sqlite3/package.json'));
const runtimeModules = path.resolve('.next/standalone/node_modules');
const tracedPackage = path.resolve('.next/standalone', path.relative(process.cwd(), sqlitePackage));
if (!fs.existsSync(path.join(tracedPackage, 'package.json'))) throw new Error('Standalone is missing the traced SQLite package');
const sqliteEntry = path.join(runtimeModules, 'better-sqlite3');
if (!fs.existsSync(sqliteEntry)) fs.symlinkSync(path.relative(runtimeModules, tracedPackage), sqliteEntry, 'dir');

fs.cpSync('public', '.next/standalone/public', { recursive: true });
fs.cpSync('.next/static', '.next/standalone/.next/static', { recursive: true });

import fs from 'node:fs';
import { build } from 'esbuild';
await build({ entryPoints: { worker: 'src/server/worker.ts', maintenance: 'src/server/cli/maintenance.ts', 'init-password': 'src/server/cli/init-password.ts' }, outdir: '.next/standalone', outExtension: { '.js': '.cjs' }, bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['better-sqlite3'] });

fs.cpSync('public', '.next/standalone/public', { recursive: true });
fs.cpSync('.next/static', '.next/standalone/.next/static', { recursive: true });

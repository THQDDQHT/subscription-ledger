import { closeDatabase } from './db';
import { tick } from './notifications';

let stopping = false;
let timer: ReturnType<typeof setTimeout> | undefined;
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
function stop() { stopping = true; if (timer) clearTimeout(timer); }
async function run() {
  try {
    const result = await tick();
    if (process.argv.includes('--once') && result.errors) process.exitCode = 1;
    if (result.charged || result.sent || result.errors) console.log('账本任务', JSON.stringify(result));
  } catch {
    console.error('账本后台任务失败，请检查数据目录和配置');
    if (process.argv.includes('--once')) process.exitCode = 1;
  }
  if (process.argv.includes('--once')) { closeDatabase(); return; }
  if (!stopping) timer = setTimeout(run, 60000);
}
console.log('账本后台任务启动：每分钟检查，无需 Hermes');
void run();

/** init-password：交互式设置/更换登录密码（至少 12 字符），轮换会话密钥使旧会话失效。 */
import readline from 'node:readline';
import { hashPassword, writePasswordHash, rotateSessionSecret } from '../auth';

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const originalWrite = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = function (s: string) {
      if (s.includes(question)) originalWrite.call(this, s);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    rl.on('error', reject);
  });
}

async function main(): Promise<void> {
  const first = await promptHidden('设置登录密码（至少 12 字符）: ');
  const second = await promptHidden('再次输入以确认: ');
  if (first !== second) throw new Error('两次输入不一致');
  if (first.length < 12 || first.length > 1024) throw new Error('密码长度必须为 12–1024');
  writePasswordHash(hashPassword(first));
  rotateSessionSecret();
  console.log('密码已安全哈希保存。请重启应用使旧会话失效。');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

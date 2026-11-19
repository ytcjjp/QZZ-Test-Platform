import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveFeishuBotCredentials } from './feishu-bot.js';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.QZZ_DATA_DIR || path.join(projectDir, 'data'));
const appId = process.argv[2];

function readHiddenSecret() {
  process.stdout.write('App Secret（输入不显示，回车保存）：');
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    return (async () => {
      const chunks = []; let size = 0;
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > 8192) throw new Error('凭据输入过长');
        chunks.push(chunk);
      }
      process.stdout.write('\n');
      return Buffer.concat(chunks).toString('utf8').trim();
    })();
  }
  return new Promise((resolve, reject) => {
    let secret = '';
    const oldRaw = process.stdin.isRaw;
    const finish = (error) => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(Boolean(oldRaw));
      process.stdin.pause();
      process.stdout.write('\n');
      error ? reject(error) : resolve(secret);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') return finish(new Error('已取消'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') secret = secret.slice(0, -1);
        else if (character >= ' ' && secret.length < 8192) secret += character;
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

try {
  if (!appId) throw new Error('用法：node server/configure-feishu-bot.js <App ID>');
  const appSecret = await readHiddenSecret();
  saveFeishuBotCredentials(dataDir, { appId, appSecret });
  console.log('飞书助手凭据已加密保存在本机数据目录；重启 QZZ 服务后生效。');
} catch (error) {
  console.error(error.message === '已取消' ? error.message : '飞书助手凭据配置失败，请检查 App ID 与输入。');
  process.exitCode = 1;
}

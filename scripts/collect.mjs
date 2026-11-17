import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createProvider } from '../provider/server.mjs';
import { collectScope, ScopeDiscrepancyError } from '../src/collector.mjs';
import { Archive } from '../src/archive.mjs';

// 用法：
//   node scripts/collect.mjs [请求文件] [收件目录] [门户地址]
// 全部参数可省略：请求默认 fixtures/request.json；不传收件目录时用临时目录（演示）；
// 不传门户地址时在本地启动合成来源。正式接入应传入持久目录与真实门户地址。
const [, , requestPath, directoryArg, baseArg] = process.argv;

const request = JSON.parse(await readFile(resolve(requestPath ?? 'fixtures/request.json'), 'utf8'));
const temporary = !directoryArg;
const directory = directoryArg
  ? resolve(directoryArg)
  : await mkdtemp(join(tmpdir(), 'collect-'));

const provider = baseArg ? null : await createProvider(Number(process.env.PORT ?? 0));
const base = baseArg ? baseArg.replace(/\/$/, '') : provider.base;
try {
  const result = await collectScope(base, request, directory);
  const verified = await new Archive(directory).read(result.receipt);
  console.log(JSON.stringify({
    ok: true,
    base,
    directory,
    generation: result.generation,
    storeIds: result.storeIds,
    attempts: result.attempts,
    rowCount: result.rowCount,
    receipt: result.receipt,
    savedBytes: verified.length
  }, null, 2));
} catch (error) {
  if (error instanceof ScopeDiscrepancyError) {
    console.error('领取已停止：' + error.message);
    console.error(JSON.stringify(error.details, null, 2));
    process.exitCode = 2;
  } else {
    throw error;
  }
} finally {
  if (provider) await provider.close();
  if (temporary) await rm(directory, { recursive: true, force: true });
}

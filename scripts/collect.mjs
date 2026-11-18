import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectScope } from '../src/collector.mjs';
import { ScopeDiscrepancyError } from '../src/scope.mjs';

// 用法：node scripts/collect.mjs <门户地址> <范围文件> <收件目录>
// 范围文件即 fixtures/request.json 形态：{"storeIds":["A","C"],"kind":"直营"}
const [, , baseArg, targetArg, directoryArg] = process.argv;
if (!baseArg || !targetArg || !directoryArg) {
  console.error('用法：node scripts/collect.mjs <门户地址> <范围文件> <收件目录>');
  process.exit(2);
}

const base = baseArg.replace(/\/+$/, '');
const target = JSON.parse(await readFile(resolve(targetArg), 'utf8'));
const directory = resolve(directoryArg);

try {
  const result = await collectScope(base, target, directory);
  console.log(JSON.stringify({
    status: 'collected',
    receipt: result.receipt.id,
    generation: result.generation,
    scope: result.ids,
    attempts: result.attempts,
    directory,
  }, null, 2));
} catch (error) {
  if (error instanceof ScopeDiscrepancyError) {
    console.error(JSON.stringify({ status: 'stopped', reason: error.details.reason, message: error.message, details: error.details }, null, 2));
    process.exit(1);
  }
  throw error;
}

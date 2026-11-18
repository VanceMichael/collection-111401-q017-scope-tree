import { createProvider } from '../provider/server.mjs';
import { receiveScoped } from '../src/domain.mjs';
import { Archive } from '../src/archive.mjs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'collection-'));
const provider = await createProvider();
try {
  const target = JSON.parse(await readFile(new URL('../fixtures/request.json', import.meta.url), 'utf8'));
  const result = await receiveScoped(provider.base, target, directory);
  const archive = new Archive(directory);
  const receipts = await archive.list();
  const stored = receipts.length ? await archive.read(receipts[0]) : Buffer.alloc(0);
  console.log(JSON.stringify({
    service: 'scope-tree',
    target,
    result: { receipt: result.receipt.id, generation: result.generation, scope: result.ids, attempts: result.attempts },
    storedExport: JSON.parse(stored.toString()),
    requests: provider.audit,
  }, null, 2));
} finally {
  await provider.close();
  await rm(directory, { recursive: true, force: true });
}

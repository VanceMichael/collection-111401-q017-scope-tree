import { createProvider } from '../provider/server.mjs';
import { collectScope } from '../src/domain.mjs';
import { Archive } from '../src/archive.mjs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = await mkdtemp(join(tmpdir(), 'collection-'));
const provider = await createProvider();
try {
  const request = JSON.parse(await readFile(new URL('../fixtures/request.json', import.meta.url), 'utf8'));
  const result = await collectScope(provider.base, request, directory);
  const saved = await new Archive(directory).read(result.receipt);
  const receipts = await new Archive(directory).list();
  console.log(JSON.stringify({
    service: 'scope-tree',
    result,
    savedPayload: JSON.parse(saved.toString('utf8')),
    receiptCount: receipts.length,
    requests: provider.audit
  }, null, 2));
} finally {
  await provider.close();
  await rm(directory, { recursive: true, force: true });
}

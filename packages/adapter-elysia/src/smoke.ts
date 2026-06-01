import { ElysiaAdapter } from './adapter.js';
import type { KilnRequest, KilnResponse } from '@kiln/core';

async function main() {
  console.log('Starting smoke test...');
  const adapter = new ElysiaAdapter();

  adapter.applyMiddleware({
    csrf: true,
    timeoutMs: 5000,
    compression: false,
  });

  adapter.registerPage('/', [], async (req: KilnRequest, res: KilnResponse) => {
    res.html('<html><body><h1>Hello from ElysiaAdapter</h1></body></html>');
  });

  adapter.registerAction('/action', async (req: KilnRequest, res: KilnResponse) => {
    res.json({ success: true, method: req.method });
  });

  await adapter.listen(5055, async (addr) => {
    console.log(`Server listening at ${addr}`);
    try {
      // 1. Test GET /
      const getRes = await fetch('http://127.0.0.1:5055/');
      const getHtml = await getRes.text();
      if (!getHtml.includes('Hello from ElysiaAdapter')) {
        throw new Error(`GET / failed. Response: ${getHtml}`);
      }
      console.log('✅ GET / page registered and returned HTML successfully');

      // 2. Test POST /action
      const postRes = await fetch('http://127.0.0.1:5055/action', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({ test: true }),
      });
      const postJson: any = await postRes.json();
      if (!postJson.success || postJson.method !== 'POST') {
        throw new Error(`POST /action failed. Response: ${JSON.stringify(postJson)}`);
      }
      console.log('✅ POST /action action registered and returned JSON successfully');

      console.log('🎉 SMOKE TEST PASSED SUCCESSFULLY!');
      process.exit(0);
    } catch (err: any) {
      console.error('❌ SMOKE TEST FAILED:', err.message);
      process.exit(1);
    }
  });
}

main().catch((err) => {
  console.error('Failed to run smoke test:', err);
  process.exit(1);
});

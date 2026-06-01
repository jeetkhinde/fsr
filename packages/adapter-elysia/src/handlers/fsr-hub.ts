import type { KilnRequest, KilnResponse } from '@kiln/core';

export async function handleFsrHub(req: KilnRequest, res: KilnResponse) {
  res.sse({
    async *[Symbol.asyncIterator]() {
      yield { event: 'ping', data: 'hello' };
    },
  });
}

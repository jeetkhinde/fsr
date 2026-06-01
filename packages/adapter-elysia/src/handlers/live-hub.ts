import type { KilnRequest, KilnResponse } from '@kiln/core';

export async function handleLiveHub(req: KilnRequest, res: KilnResponse) {
  res.sse({
    async *[Symbol.asyncIterator]() {
      yield { event: 'ping', data: 'hello' };
    },
  });
}

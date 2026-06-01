import type { PilcrowRequest, PilcrowResponse } from '@fsr/core';

export async function handleLiveHub(req: PilcrowRequest, res: PilcrowResponse) {
  res.sse({
    async *[Symbol.asyncIterator]() {
      yield { event: 'ping', data: 'hello' };
    },
  });
}

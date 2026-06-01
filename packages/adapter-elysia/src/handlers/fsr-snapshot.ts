import type { KilnRequest, KilnResponse } from '@kiln/core';

export async function handleFsrSnapshot(req: KilnRequest, res: KilnResponse) {
  res.json({ snapshot: {} });
}

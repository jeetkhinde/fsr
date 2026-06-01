import type { PilcrowRequest, PilcrowResponse } from '@fsr/core';

export async function handleFsrSnapshot(req: PilcrowRequest, res: PilcrowResponse) {
  res.json({ snapshot: {} });
}

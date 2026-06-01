import type { PilcrowRequest, PilcrowResponse } from '@fsr/core';

export async function handleAction(req: PilcrowRequest, res: PilcrowResponse) {
  res.json({ success: true });
}

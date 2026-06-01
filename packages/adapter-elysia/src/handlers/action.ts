import type { KilnRequest, KilnResponse } from '@kiln/core';

export async function handleAction(req: KilnRequest, res: KilnResponse) {
  res.json({ success: true });
}

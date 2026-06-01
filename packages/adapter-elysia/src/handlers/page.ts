import type { PilcrowRequest, PilcrowResponse } from '@fsr/core';

export async function handlePage(req: PilcrowRequest, res: PilcrowResponse) {
  res.html('<h1>Pilcrow Page</h1>');
}

import type { KilnRequest, KilnResponse } from '@kiln/core';

export async function handlePage(req: KilnRequest, res: KilnResponse) {
  res.html('<h1>Kiln Page</h1>');
}

import { describe, it, expect } from 'bun:test';
import type { KilnRequest, LayoutDefinition } from './types.js';

describe('types', () => {
  it('KilnRequest has prebakeNext', () => {
    const req = {
      path: '/',
      method: 'GET',
      params: {},
      query: {},
      headers: new Headers(),
      formData: async () => new FormData(),
      json: async () => ({}),
      isEnhanced: false,
      layoutsPresent: [],
      prebakeNext: (_path: string) => {},
    } satisfies KilnRequest;
    expect(req.prebakeNext).toBeDefined();
  });

  it('LayoutDefinition extends PageDefinition with children', () => {
    const layout: LayoutDefinition = {
      default: () => null,
    };
    expect(layout.default).toBeDefined();
  });
});

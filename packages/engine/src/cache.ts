import { RedisClient } from 'bun';

export interface InvalidatePayload {
  route: string;
  slots: string[];
  deps: string[];
}

export interface PatchPayload {
  route: string;
  slot: string;
  value: any;
}

export class RedisCache {
  private client: RedisClient;
  private artifactTtlSecs = 0;

  constructor(url: string) {
    this.client = new RedisClient(url);
  }

  withArtifactTtl(ttlSecs: number): this {
    this.artifactTtlSecs = ttlSecs;
    return this;
  }

  getClient(): RedisClient {
    return this.client;
  }

  private htmlKey(route: string): string {
    return `kiln:html:${route}`;
  }

  private slotKey(route: string): string {
    return `kiln:slot:${route}`;
  }

  private jsonKey(route: string): string {
    return `kiln:json:${route}`;
  }

  async getHtml(route: string): Promise<string | null> {
    return this.client.get(this.htmlKey(route));
  }

  async setHtml(route: string, html: string): Promise<void> {
    const key = this.htmlKey(route);
    if (this.artifactTtlSecs > 0) {
      await Promise.all([
        this.client.set(key, html),
        this.client.expire(key, this.artifactTtlSecs),
      ]);
    } else {
      await this.client.set(key, html);
    }
  }

  async patchSlot(route: string, slot: string, value: string): Promise<void> {
    const key = this.slotKey(route);
    if (this.artifactTtlSecs > 0) {
      await Promise.all([
        this.client.send('HSET', [key, slot, value]),
        this.client.expire(key, this.artifactTtlSecs),
      ]);
    } else {
      await this.client.send('HSET', [key, slot, value]);
    }
  }

  async getSlots(route: string): Promise<Record<string, string>> {
    const result = await this.client.send('HGETALL', [this.slotKey(route)]);
    return (result as Record<string, string>) || {};
  }

  async setJson(route: string, json: any): Promise<void> {
    const key = this.jsonKey(route);
    const value = typeof json === 'string' ? json : JSON.stringify(json);
    if (this.artifactTtlSecs > 0) {
      await Promise.all([
        this.client.set(key, value),
        this.client.expire(key, this.artifactTtlSecs),
      ]);
    } else {
      await this.client.set(key, value);
    }
  }

  async getJson(route: string): Promise<any | null> {
    const s = await this.client.get(this.jsonKey(route));
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  async publishInvalidate(payload: InvalidatePayload): Promise<void> {
    await this.client.publish('kiln:invalidate', JSON.stringify(payload));
  }

  async publishPatch(payload: PatchPayload): Promise<void> {
    await this.client.publish('kiln:patch', JSON.stringify(payload));
  }

  async deleteRouteKeys(route: string): Promise<void> {
    await this.client.send('DEL', [this.htmlKey(route), this.slotKey(route), this.jsonKey(route)]);
  }

  async disconnect(): Promise<void> {
    this.client.close();
  }
}

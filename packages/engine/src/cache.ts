import { Redis } from 'ioredis';

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
  private client: Redis;
  private artifactTtlSecs = 0;

  constructor(url: string) {
    this.client = new Redis(url);
  }

  withArtifactTtl(ttlSecs: number): this {
    this.artifactTtlSecs = ttlSecs;
    return this;
  }

  getClient(): Redis {
    return this.client;
  }

  private htmlKey(route: string): string {
    return `pilcrow:html:${route}`;
  }

  private slotKey(route: string): string {
    return `pilcrow:slot:${route}`;
  }

  private jsonKey(route: string): string {
    return `pilcrow:json:${route}`;
  }

  async getHtml(route: string): Promise<string | null> {
    return this.client.get(this.htmlKey(route));
  }

  async setHtml(route: string, html: string): Promise<void> {
    const key = this.htmlKey(route);
    if (this.artifactTtlSecs > 0) {
      await this.client.set(key, html, 'EX', this.artifactTtlSecs);
    } else {
      await this.client.set(key, html);
    }
  }

  async patchSlot(route: string, slot: string, value: string): Promise<void> {
    const key = this.slotKey(route);
    if (this.artifactTtlSecs > 0) {
      await this.client.pipeline()
        .hset(key, slot, value)
        .expire(key, this.artifactTtlSecs)
        .exec();
    } else {
      await this.client.hset(key, slot, value);
    }
  }

  async getSlots(route: string): Promise<Record<string, string>> {
    return this.client.hgetall(this.slotKey(route));
  }

  async setJson(route: string, json: any): Promise<void> {
    const key = this.jsonKey(route);
    const value = typeof json === 'string' ? json : JSON.stringify(json);
    if (this.artifactTtlSecs > 0) {
      await this.client.set(key, value, 'EX', this.artifactTtlSecs);
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
    const msg = JSON.stringify(payload);
    await this.client.publish('pilcrow:invalidate', msg);
  }

  async publishPatch(payload: PatchPayload): Promise<void> {
    const msg = JSON.stringify(payload);
    await this.client.publish('pilcrow:patch', msg);
  }

  async deleteRouteKeys(route: string): Promise<void> {
    await this.client.del(this.htmlKey(route), this.slotKey(route), this.jsonKey(route));
  }

  async disconnect(): Promise<void> {
    await this.client.quit();
  }
}

import { FluentBundle, FluentResource } from '@fluent/bundle';
import { negotiateLanguages } from '@fluent/langneg';
import { join } from 'pathe';
import type { KilnRequest } from './types.js';

export class KilnI18n {
  private bundles = new Map<string, FluentBundle>();
  private defaultLocale: string;
  private locales: string[];

  constructor(private config: { defaultLocale: string; locales: string[]; localesDir: string }) {
    this.defaultLocale = config.defaultLocale;
    this.locales = config.locales;
  }

  async load(): Promise<void> {
    for (const locale of this.locales) {
      const dir = join(this.config.localesDir, locale);
      const glob = new Bun.Glob('*.ftl');
      const bundle = new FluentBundle(locale);
      try {
        for await (const file of glob.scan({ cwd: dir, onlyFiles: true })) {
          const content = await Bun.file(join(dir, file)).text();
          bundle.addResource(new FluentResource(content));
        }
      } catch { /* missing locale dir */ }
      this.bundles.set(locale, bundle);
    }
  }

  locale(req: KilnRequest): string {
    const accept = req.headers.get('accept-language') ?? this.defaultLocale;
    const [best] = negotiateLanguages([accept], this.locales, { defaultLocale: this.defaultLocale });
    return best ?? this.defaultLocale;
  }

  t(locale: string, id: string, args?: Record<string, string | number>): string {
    const bundle = this.bundles.get(locale) ?? this.bundles.get(this.defaultLocale);
    if (!bundle) return id;
    const msg = bundle.getMessage(id);
    if (!msg?.value) return id;
    const errors: Error[] = [];
    return bundle.formatPattern(msg.value, args, errors);
  }
}

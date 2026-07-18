import { LiveProp, StartupError } from '@kiln/core';
import type { KilnRequest, LiveFieldMeta } from '@kiln/core';

export type BakeMode = 'static' | 'shared' | false;

export interface PageOptions {
  /** undefined = 'auto': bake on the first render whose load() touched no
   * identity fields; a single identity-touching render demotes the route
   * for the life of the process. 'shared'/'static' bake unconditionally
   * (dev-mode warning if identity is accessed). false = pure SSR. */
  bake?: BakeMode;
  revalidate?: number | false;
  debounce?: number;
  purgeAfter?: number;
  pinInRedis?: boolean;
  patchMode?: 'json' | 'both';
  jsonFirst?: boolean;
  cacheKey?: (req: KilnRequest) => string;
}

export function extractPageOptions(module: any): PageOptions {
  if (module.promote_after !== undefined || module.promoteAfter !== undefined) {
    throw new StartupError(
      'RemovedOption',
      '[kiln] promote_after has been removed. Delete the export: absent = auto ' +
        "(bake on first identity-free render). Use `export const bake = 'static' | 'shared' | false` " +
        'to override. See docs/agents/rendering-and-caching.md.'
    );
  }
  let bake: BakeMode | undefined;
  if (module.bake !== undefined) {
    if (module.bake === 'static' || module.bake === 'shared' || module.bake === false) {
      bake = module.bake;
    } else {
      throw new StartupError(
        'RemovedOption',
        `[kiln] invalid bake value ${JSON.stringify(module.bake)}; expected 'static', 'shared', or false.`
      );
    }
  }


  let patchMode = module.patch_mode;
  if (patchMode === undefined && module.patchMode) {
    console.warn('[kiln] patchMode is deprecated; export patch_mode instead');
    patchMode = module.patchMode;
  }

  let cacheKey = module.cache_key;
  if (cacheKey === undefined && typeof module.cacheKey === 'function') {
    console.warn('[kiln] cacheKey is deprecated; export cache_key instead');
    cacheKey = module.cacheKey;
  }

  return {
    bake,
    revalidate:
      typeof module.revalidate === 'number' || module.revalidate === false
        ? module.revalidate
        : undefined,
    debounce: typeof module.debounce === 'number' ? module.debounce : undefined,
    purgeAfter: typeof module.purge_after === 'number' ? module.purge_after : undefined,
    pinInRedis: typeof module.pinInRedis === 'boolean' ? module.pinInRedis : undefined,
    patchMode: patchMode === 'both' ? 'both' : (patchMode === 'json' ? 'json' : undefined),
    jsonFirst: typeof module.json_first === 'boolean' ? module.json_first : undefined,
    cacheKey: typeof cacheKey === 'function' ? cacheKey : undefined,
  };
}

export function extractLiveFields(loadResult: any): LiveFieldMeta[] {
  const fields: LiveFieldMeta[] = [];
  if (!loadResult || typeof loadResult !== 'object') {
    return fields;
  }

  for (const [key, value] of Object.entries(loadResult)) {
    if (value && (value instanceof LiveProp || (value as any).constructor?.name === 'LiveProp')) {
      const lp = value as any;

      let dependsOn: string | undefined;
      if (Array.isArray(lp.dependsOn) && lp.dependsOn.length > 0) {
        dependsOn = lp.dependsOn[0];
      } else if (typeof lp.dependsOn === 'string') {
        dependsOn = lp.dependsOn;
      } else if (lp.options?.dependsOn) {
        dependsOn = lp.options.dependsOn;
      }

      const revalidate = lp.revalidateSeconds ?? lp.options?.revalidate;
      const debounce = lp.patchDebounce !== undefined ? lp.patchDebounce : lp.options?.debounce;
      const deliveryTarget = lp.deliveryTarget || lp.options?.target || 'dom';

      fields.push({
        name: key,
        revalidate,
        debounce,
        dependsOn,
        deliveryTarget,
      });
    }
  }

  return fields;
}


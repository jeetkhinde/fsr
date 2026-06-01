import { LiveProp } from '@fsr/core';
import type { LiveFieldMeta } from '@fsr/core';

export interface PageOptions {
  promoteAfter?: number;
}

export function extractPageOptions(module: any): PageOptions {
  return {
    promoteAfter: typeof module.promoteAfter === 'number' ? module.promoteAfter : undefined,
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

      const revalidate = lp.options?.revalidate;
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

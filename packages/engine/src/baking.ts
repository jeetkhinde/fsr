export function injectFsrSlots(shell: string, slots: [string, any][]): string {
  const patches: { start: number; end: number; replacement: string }[] = [];

  for (const [slotName, jsonVal] of slots) {
    let raw = '';
    if (jsonVal === null || jsonVal === undefined) {
      raw = '';
    } else if (typeof jsonVal === 'string') {
      raw = jsonVal;
    } else if (typeof jsonVal === 'object') {
      raw = JSON.stringify(jsonVal);
    } else {
      raw = String(jsonVal);
    }
    const escaped = escapeHtml(raw);
    const range = findSLiveContentRange(shell, slotName);
    if (range) {
      patches.push({ start: range.start, end: range.end, replacement: escaped });
    }
  }

  if (patches.length === 0) {
    return shell;
  }

  // Apply patches right-to-left so earlier byte offsets remain valid.
  patches.sort((a, b) => b.start - a.start);

  let result = shell;
  for (const { start, end, replacement } of patches) {
    result = result.slice(0, start) + replacement + result.slice(end);
  }

  return result;
}

function findSLiveContentRange(html: string, name: string): { start: number; end: number } | null {
  const attr = `s-live="${name}"`;
  const attrPos = html.indexOf(attr);
  if (attrPos === -1) return null;

  const restFromAttr = html.slice(attrPos);
  const tagClose = restFromAttr.indexOf('>');
  if (tagClose === -1) return null;

  const contentStart = attrPos + tagClose + 1;
  const restFromContent = html.slice(contentStart);
  const closeTag = restFromContent.indexOf('</');
  if (closeTag === -1) return null;

  const contentEnd = contentStart + closeTag;
  return { start: contentStart, end: contentEnd };
}

export function findSLiveSlots(html: string): string[] {
  const names: string[] = [];
  let remaining = html;
  while (true) {
    const pos = remaining.indexOf('s-live="');
    if (pos === -1) break;
    remaining = remaining.slice(pos + 8);
    const end = remaining.indexOf('"');
    if (end === -1) break;
    const name = remaining.slice(0, end);
    if (name && !names.includes(name)) {
      names.push(name);
    }
    remaining = remaining.slice(end + 1);
  }
  return names;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

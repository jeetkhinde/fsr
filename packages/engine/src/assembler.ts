import { OUTLET_TOKEN } from './baking.js';

/**
 * Stitch layout chain + page fragment into complete HTML.
 * layoutHtmls[0] is outermost. Each contains OUTLET_TOKEN where child goes.
 * Sequential outer→inner replacement: each replace consumes the outermost token
 * and exposes the next layout's token.
 */
export function assembleFragments(layoutHtmls: string[], pageHtml: string): string {
  if (layoutHtmls.length === 0) return pageHtml;
  let result = layoutHtmls[0];
  for (let i = 1; i < layoutHtmls.length; i++) {
    result = result.replace(OUTLET_TOKEN, layoutHtmls[i]);
  }
  return result.replace(OUTLET_TOKEN, pageHtml);
}

/**
 * Inject <script>window.__kiln_seed = {...}</script> before </body>.
 */
export function injectJsonSeed(html: string, seed: Record<string, unknown>): string {
  const tag = `<script>window.__kiln_seed=${JSON.stringify(seed)}</script>`;
  const idx = html.lastIndexOf('</body>');
  if (idx === -1) return html + tag;
  return html.slice(0, idx) + tag + html.slice(idx);
}

/**
 * Inject <script src="..."> before </head>.
 */
export function injectKilnScript(html: string, src: string): string {
  if (html.includes(`src="${src}"`) || html.includes(`src='${src}'`)) {
    return html;
  }
  const tag = `<script src="${src}" defer></script>`;
  const idx = html.indexOf('</head>');
  if (idx === -1) return tag + html;
  return html.slice(0, idx) + tag + html.slice(idx);
}

/**
 * Inject <link rel="stylesheet"> before </head>.
 */
export function injectStylesheet(html: string, href: string): string {
  const tag = `<link rel="stylesheet" href="${href}">`;
  const idx = html.indexOf('</head>');
  if (idx === -1) return tag + html;
  return html.slice(0, idx) + tag + html.slice(idx);
}

// Hoistable document-metadata tags. React 19 renders these at the front of a
// fragment (no <head> to hoist into server-side), so after assembly they sit
// in the body. Lift them into the real <head>.
const HOISTABLE_TAG_PATTERNS = [/<title\b[^>]*>[\s\S]*?<\/title>/gi, /<meta\b[^>]*?>/gi, /<link\b[^>]*?>/gi];

/**
 * Move <title>/<meta>/<link> tags out of the body and into <head>.
 *
 * Operates on the assembled document. Tags already inside <head> are left in
 * place (only the body region — everything after </head> — is scanned).
 * Duplicate tags are collapsed. No-op when the shell has no </head>
 * (e.g. a bare body fragment), since there is nowhere to hoist into.
 */
export function hoistHeadTags(html: string): string {
  const headEnd = html.indexOf('</head>');
  if (headEnd === -1) return html;

  const head = html.slice(0, headEnd);
  let body = html.slice(headEnd); // starts with </head>

  const hoisted: string[] = [];
  for (const re of HOISTABLE_TAG_PATTERNS) {
    body = body.replace(re, (tag) => {
      hoisted.push(tag);
      return '';
    });
  }
  if (hoisted.length === 0) return html;

  const seen = new Set<string>();
  const unique = hoisted.filter((tag) => (seen.has(tag) ? false : (seen.add(tag), true)));

  return head + unique.join('') + body;
}

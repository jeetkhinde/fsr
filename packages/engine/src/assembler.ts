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

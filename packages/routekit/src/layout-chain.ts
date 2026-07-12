import type { ComponentType } from 'react';

export interface LayoutComponentConfig {
  pattern: string;
  component: ComponentType<any>;
  props: Record<string, any>;
}

/**
 * Composes a page component and its parent layouts into a single React tree.
 * Wraps layouts in <div data-kiln-layout="..."> containers and children in <div data-ps-slot="...">
 * using display: contents to avoid affecting layout styling.
 *
 * Each layout entry carries its own `props` (from its load() result), while
 * the page itself uses `pageProps`.
 */
export function composeLayoutChain(
  react: any,
  PageComponent: any,
  layouts: LayoutComponentConfig[],
  pagePattern: string,
  pageProps: any
): any {
  const props = pageProps; // alias for backward compat in page element
  // 1. Start with the page component
  let currentElement = react.createElement(PageComponent, props);

  // 2. Wrap page in its own ps-layout wrapper
  currentElement = react.createElement(
    'div',
    { 'data-kiln-layout': pagePattern, style: { display: 'contents' } },
    currentElement
  );

  // 3. Wrap layouts from innermost (right) to outermost (left)
  for (let i = layouts.length - 1; i >= 0; i--) {
    const { pattern: layoutPattern, component: LayoutComponent, props: layoutProps } = layouts[i];

    // Determine the child pattern (the next level down)
    const childPattern = i === layouts.length - 1 ? pagePattern : layouts[i + 1].pattern;

    // Wrap the child element in a slot container
    const slotElement = react.createElement(
      'div',
      { 'data-ps-slot': childPattern, style: { display: 'contents' } },
      currentElement
    );

    // Instantiate layout with its own props + the slot element as children
    const layoutElement = react.createElement(
      LayoutComponent,
      layoutProps,
      slotElement
    );

    // Wrap every layout level in its own data-kiln-layout container,
    // including the outermost one — code that walks these markers (fragment
    // extraction for enhanced navigation, layout signature computation)
    // expects one per layout level, not all-but-the-outermost.
    currentElement = react.createElement(
      'div',
      { 'data-kiln-layout': layoutPattern, style: { display: 'contents' } },
      layoutElement
    );
  }

  return currentElement;
}

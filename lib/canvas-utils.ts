/**
 * Canvas configuration constants and shared utilities
 */

/**
 * Border/padding around the iframe canvas (in pixels)
 * Applied on all sides (top, right, bottom, left)
 */
export const CANVAS_BORDER = 20;

/**
 * Total padding (border on both sides)
 * Used for calculations: left + right or top + bottom
 */
export const CANVAS_PADDING = CANVAS_BORDER * 2;

const VIEWPORT_HEIGHT_UNITS = ['vh', 'svh', 'dvh', 'lvh'] as const;

const VIEWPORT_HEIGHT_PATTERN = new RegExp(
  `^(min-h|max-h|h)-\\[(\\d+(?:\\.\\d+)?)(${VIEWPORT_HEIGHT_UNITS.join('|')})\\]$`
);

const NAMED_VIEWPORT_UTILITIES = new Set([
  'h-screen', 'min-h-screen', 'max-h-screen',
  'h-dvh', 'min-h-dvh', 'max-h-dvh',
  'h-svh', 'min-h-svh', 'max-h-svh',
  'h-lvh', 'min-h-lvh', 'max-h-lvh',
]);

function getCssProp(prefix: string): string {
  if (prefix === 'min-h') return 'min-height';
  if (prefix === 'max-h') return 'max-height';
  return 'height';
}

function escapeSelector(cls: string): string {
  return cls.replace(/([[\](){}.:!#%^&*+?<>~=|@/\\])/g, '\\$1');
}

/**
 * Generates CSS that overrides viewport-height units (vh, svh, dvh, lvh) with
 * fixed pixel values based on a reference viewport height. This prevents a
 * feedback loop where the iframe expands to fit content, viewport-unit layers
 * grow with it, and the measured height keeps increasing.
 */
export function updateViewportOverrides(doc: Document, referenceHeight: number): void {
  if (referenceHeight <= 0) return;

  let styleEl = doc.getElementById('ycode-viewport-overrides');
  if (!styleEl) {
    styleEl = doc.createElement('style');
    styleEl.id = 'ycode-viewport-overrides';
    doc.head.appendChild(styleEl);
  }

  const rules: string[] = [];
  const seen = new Set<string>();

  doc.querySelectorAll('[class]').forEach(el => {
    const classes = (el.getAttribute('class') || '').split(/\s+/);
    for (const cls of classes) {
      if (seen.has(cls)) continue;

      // Skip responsive/state variants — overriding without media queries
      // would apply the override at ALL breakpoints, which is incorrect
      if (cls.includes(':')) continue;

      if (NAMED_VIEWPORT_UTILITIES.has(cls)) {
        seen.add(cls);
        const prop = getCssProp(cls.split('-')[0] === 'min' ? 'min-h' : cls.split('-')[0] === 'max' ? 'max-h' : 'h');
        rules.push(`.${escapeSelector(cls)}{${prop}:${referenceHeight}px !important}`);
        continue;
      }

      const match = cls.match(VIEWPORT_HEIGHT_PATTERN);
      if (match) {
        seen.add(cls);
        const [, prefix, value] = match;
        const pixels = (parseFloat(value) / 100) * referenceHeight;
        const prop = getCssProp(prefix);
        rules.push(`.${escapeSelector(cls)}{${prop}:${pixels}px !important}`);
      }
    }
  });

  const css = rules.join('\n');
  if (styleEl.textContent !== css) {
    styleEl.textContent = css;
  }
}

/**
 * Measures the actual content extent (bottom of last visible child) rather than
 * scrollHeight, which includes viewport-filling styles like h-full / min-h-screen
 * on html/body that inflate the measured height beyond actual content.
 */
export function measureContentExtent(doc: Document): number {
  const body = doc.body;
  if (!body || body.children.length === 0) return 0;

  const bodyRect = body.getBoundingClientRect();
  let maxBottom = 0;
  const win = doc.defaultView;

  const measure = (parent: Element) => {
    for (let i = 0; i < parent.children.length; i++) {
      const el = parent.children[i] as HTMLElement;
      if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'LINK') continue;

      // display:contents elements have no box — recurse into their children
      if (win && win.getComputedStyle(el).display === 'contents') {
        measure(el);
        continue;
      }

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      maxBottom = Math.max(maxBottom, rect.bottom - bodyRect.top);
    }
  };

  measure(body);
  return Math.max(maxBottom, 0);
}

/**
 * Shared HTML template for canvas-style iframes with Tailwind Browser CDN.
 * Used by both the editor Canvas and the thumbnail capture hook.
 * @param mountId - The ID of the mount point div (default: 'canvas-mount')
 */
export function getCanvasIframeHtml(mountId: string = 'canvas-mount'): string {
  return `<!DOCTYPE html>
<html class="h-full">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
  <style type="text/tailwindcss">
    @custom-variant current (&[aria-current]);
    @custom-variant disabled (&:is(:disabled, [aria-disabled]));
    @theme {
      /* Editor UI colors for context menus portaled into the iframe */
      --color-popover: oklch(0.269 0 0);
      --color-popover-foreground: oklch(0.708 0 0);
      --color-accent: oklch(0.32 0 0);
      --color-accent-foreground: oklch(0.985 0 0);
      --color-muted-foreground: oklch(0.708 0 0);
      --color-foreground: oklch(0.985 0 0);
      --color-border: oklch(1 0 0 / 5%);
      --color-destructive: oklch(0.704 0.191 22.216);
    }
  </style>
  <style id="ycode-fonts-style">
    /* Font CSS (Google @import + custom @font-face) injected dynamically */
  </style>
  <style>
    /* Custom dropdown chevron for select elements (native arrow removed by form reset) */
    select {
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23737373' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") !important;
      background-repeat: no-repeat !important;
      background-position: right 12px center !important;
      background-size: 16px 16px !important;
    }
  </style>
  <link rel="stylesheet" href="/canvas.css?v=0.2.1.1">
  <style id="ycode-viewport-overrides">
    /* Dynamically populated: overrides vh/svh/dvh/lvh with fixed px values */
  </style>
</head>
<body class="h-full">
  <div id="${mountId}" class="contents"></div>
</body>
</html>`;
}

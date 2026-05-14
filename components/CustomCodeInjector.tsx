'use client';

import { useEffect, useRef } from 'react';

import { recreateScript } from '@/lib/script-utils';

interface CustomCodeInjectorProps {
  html: string;
}

/**
 * Injects custom HTML/script code after React hydration.
 * Renders an empty container on SSR to avoid hydration mismatches,
 * then injects and executes scripts via useEffect on the client.
 * External scripts are loaded sequentially to preserve dependency order.
 */
export default function CustomCodeInjector({ html }: CustomCodeInjectorProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.innerHTML = html;

    const scripts = Array.from(container.querySelectorAll('script'));
    let cancelled = false;

    // Execute sequentially — dynamically created scripts with `src` are
    // async by default, which breaks dependencies between external libs
    // and inline scripts that use them.
    async function executeScripts() {
      for (const original of scripts) {
        if (cancelled) return;
        const script = recreateScript(original);

        if (script.src) {
          await new Promise<void>((resolve) => {
            script.addEventListener('load', () => resolve());
            script.addEventListener('error', () => resolve());
            original.replaceWith(script);
          });
        } else {
          original.replaceWith(script);
        }
      }
    }

    executeScripts();

    return () => { cancelled = true; };
  }, [html]);

  return <div ref={containerRef} />;
}

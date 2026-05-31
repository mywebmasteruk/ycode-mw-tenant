'use client';

/**
 * SliderInitializer - Client component that initializes Swiper on production pages.
 * Finds all [data-slider-id] elements, reads settings from data-slider-settings,
 * and mounts Swiper instances.
 */

import { useEffect, useRef } from 'react';
import Swiper from 'swiper';
import { ITEMS_INJECTED_EVENT } from '@/components/FilterableCollection';
import type { SliderSettings } from '@/types';
import {
  buildProductionSwiperOptions,
  applySwiperEasing,
  loadSwiperCss,
  configureBulletRenderer,
  syncSliderStateAttributes,
} from '@/lib/slider-utils';

/** Tag attached to sliders we've already mounted so re-scans skip them. */
const INITIALIZED_ATTR = 'data-slider-initialized';

export default function SliderInitializer() {
  const swiperInstancesRef = useRef<Swiper[]>([]);

  useEffect(() => {
    loadSwiperCss(document);

    const initSliders = () => {
      const sliderElements = document.querySelectorAll<HTMLElement>(
        `[data-slider-id]:not([${INITIALIZED_ATTR}])`,
      );

      sliderElements.forEach((el) => {
        const settingsJson = el.getAttribute('data-slider-settings');
        if (!settingsJson) return;

        try {
          const settings: SliderSettings = JSON.parse(settingsJson);
          const config = buildProductionSwiperOptions(settings);

          if (config.navigation && typeof config.navigation === 'object') {
            config.navigation.nextEl = el.querySelector('[data-slider-next]') as HTMLElement;
            config.navigation.prevEl = el.querySelector('[data-slider-prev]') as HTMLElement;
          }
          if (config.pagination && typeof config.pagination === 'object') {
            const isFraction = settings.paginationType === 'fraction';
            const selector = isFraction ? '[data-slider-fraction]' : '[data-slider-pagination]';
            config.pagination.el = el.querySelector(selector) as HTMLElement;
          }

          configureBulletRenderer(el, config);

          const swiper = new Swiper(el, config);
          applySwiperEasing(el, settings.easing);
          syncSliderStateAttributes(swiper);

          const paginationEl = el.querySelector('[data-slider-pagination]') as HTMLElement | null;
          if (paginationEl) paginationEl.style.visibility = '';

          el.setAttribute(INITIALIZED_ATTR, '');
          swiperInstancesRef.current.push(swiper);
        } catch {
          console.error('Failed to initialize slider:', el.getAttribute('data-slider-id'));
        }
      });
    };

    initSliders();

    // Re-scan after filter/load-more injects new collection items so sliders
    // inside those items get mounted. Defer to the next frame so the DOM has
    // settled after injection.
    const handleItemsInjected = () => {
      requestAnimationFrame(initSliders);
    };
    window.addEventListener(ITEMS_INJECTED_EVENT, handleItemsInjected);

    return () => {
      window.removeEventListener(ITEMS_INJECTED_EVENT, handleItemsInjected);
      swiperInstancesRef.current.forEach((swiper) => swiper.destroy(true, true));
      swiperInstancesRef.current = [];
    };
  }, []);

  return null;
}

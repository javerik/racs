import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';

export type LayoutMode = 'desktop' | 'mobile';
export type LayoutPreference = 'auto' | LayoutMode;

const LAYOUT_KEY = 'racs.layout';

/** A narrow window gets the mobile layout, whatever the input. */
export const NARROW_QUERY = '(max-width: 767px)';
/** A touch-only device does too, so a phone held sideways (892 px on a Pixel 7 Pro) stays mobile. */
export const TOUCH_QUERY = '(pointer: coarse) and (hover: none)';

/** Desktop forced on a phone renders at this width, like a browser's "desktop site". */
const DESKTOP_VIEWPORT = 'width=1280';
const DEVICE_VIEWPORT = 'width=device-width, initial-scale=1, viewport-fit=cover';

/**
 * Whether the UI uses the desktop or the mobile layout: detected from the screen and input, or
 * chosen by the user. The mode is published as `data-layout` on `<html>`, which the `mobile:` and
 * `desktop:` Tailwind variants and the mobile rules in styles.scss key on.
 */
@Injectable({ providedIn: 'root' })
export class LayoutService {
  private readonly document = inject(DOCUMENT);

  readonly preference = signal<LayoutPreference>(loadPreference());
  /** What the device looks like, regardless of the preference. */
  readonly detected = signal<LayoutMode>('desktop');

  readonly mode = computed<LayoutMode>(() => {
    const pref = this.preference();
    return pref === 'auto' ? this.detected() : pref;
  });
  readonly isMobile = computed(() => this.mode() === 'mobile');

  constructor() {
    const win = this.document.defaultView;
    if (win && typeof win.matchMedia === 'function') {
      const queries = [win.matchMedia(NARROW_QUERY), win.matchMedia(TOUCH_QUERY)];
      const detect = () => this.detected.set(queries.some((q) => q.matches) ? 'mobile' : 'desktop');
      detect();
      for (const q of queries) {
        q.addEventListener('change', detect);
      }
      inject(DestroyRef).onDestroy(() => queries.forEach((q) => q.removeEventListener('change', detect)));
    }
    // Applied right away as well, so the first render already has the right layout.
    this.apply();
    effect(() => this.apply());
  }

  setPreference(pref: LayoutPreference): void {
    this.preference.set(pref);
    try {
      localStorage.setItem(LAYOUT_KEY, pref);
    } catch {
      // Remembering the layout is a convenience only.
    }
  }

  private apply(): void {
    const mode = this.mode();
    this.document.documentElement.dataset['layout'] = mode;
    const viewport = this.document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (viewport) {
      const forcedDesktop = mode === 'desktop' && this.detected() === 'mobile';
      viewport.content = forcedDesktop ? DESKTOP_VIEWPORT : DEVICE_VIEWPORT;
    }
  }
}

function loadPreference(): LayoutPreference {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    return v === 'desktop' || v === 'mobile' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

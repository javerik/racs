import { DestroyRef, Injectable, computed, effect, inject, signal } from '@angular/core';
import { DOCUMENT } from '@angular/common';

export type ThemeId = 'technical-dark' | 'technical-light' | 'light';
export type ThemePreference = 'auto' | ThemeId;

const THEME_KEY = 'racs.theme';

/** The OS asks for a light page; Auto then picks Technical light. */
export const LIGHT_QUERY = '(prefers-color-scheme: light)';

/** Each theme's `--bg` (src/styles.scss), for the browser chrome's `theme-color`. */
const THEME_COLOR: Record<ThemeId, string> = {
  'technical-dark': '#0c0e10',
  'technical-light': '#eceff2',
  light: '#f4f2ed',
};

/**
 * The colour theme: chosen by the user, or on Auto from the OS's light/dark preference. The theme
 * is published as `data-theme` on `<html>`, which the token blocks in styles.scss key on. An
 * inline script in index.html sets it before the first paint, from the same stored preference.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);

  readonly preference = signal<ThemePreference>(loadPreference());
  /** What the OS asks for, regardless of the preference. */
  readonly detected = signal<ThemeId>('technical-dark');

  readonly theme = computed<ThemeId>(() => {
    const pref = this.preference();
    return pref === 'auto' ? this.detected() : pref;
  });
  readonly scheme = computed<'dark' | 'light'>(() => (this.theme() === 'technical-dark' ? 'dark' : 'light'));

  constructor() {
    const win = this.document.defaultView;
    if (win && typeof win.matchMedia === 'function') {
      const query = win.matchMedia(LIGHT_QUERY);
      const detect = () => this.detected.set(query.matches ? 'technical-light' : 'technical-dark');
      detect();
      query.addEventListener('change', detect);
      inject(DestroyRef).onDestroy(() => query.removeEventListener('change', detect));
    }
    this.apply();
    effect(() => this.apply());
  }

  setPreference(pref: ThemePreference): void {
    this.preference.set(pref);
    try {
      localStorage.setItem(THEME_KEY, pref);
    } catch {
      // Remembering the theme is a convenience only.
    }
  }

  private apply(): void {
    const theme = this.theme();
    this.document.documentElement.dataset['theme'] = theme;
    const meta = this.document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (meta) {
      meta.content = THEME_COLOR[theme];
    }
  }
}

export function isThemePreference(v: unknown): v is ThemePreference {
  return v === 'auto' || v === 'technical-dark' || v === 'technical-light' || v === 'light';
}

function loadPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return isThemePreference(v) ? v : 'auto';
  } catch {
    return 'auto';
  }
}

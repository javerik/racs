import { TestBed } from '@angular/core/testing';
import { LIGHT_QUERY, ThemeService } from './theme.service';

/** A controllable `window.matchMedia` for the colour-scheme query. */
function stubMatchMedia(light: boolean) {
  const listeners = new Set<() => void>();
  let matches = light;
  const original = window.matchMedia;
  window.matchMedia = ((query: string) =>
    ({
      get matches() {
        return query === LIGHT_QUERY && matches;
      },
      media: query,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
  return {
    set(v: boolean) {
      matches = v;
      listeners.forEach((fn) => fn());
    },
    restore() {
      window.matchMedia = original;
    },
  };
}

/** The test environment has no localStorage of its own. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

function themeMeta(): HTMLMetaElement {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  return meta;
}

describe('ThemeService', () => {
  let media: ReturnType<typeof stubMatchMedia> | undefined;

  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    themeMeta().content = '';
  });

  afterEach(() => {
    media?.restore();
    media = undefined;
    vi.unstubAllGlobals();
  });

  function create(light: boolean): ThemeService {
    media = stubMatchMedia(light);
    const theme = TestBed.inject(ThemeService);
    TestBed.tick();
    return theme;
  }

  it('defaults to technical dark on a dark OS', () => {
    const theme = create(false);
    expect(theme.preference()).toBe('auto');
    expect(theme.theme()).toBe('technical-dark');
    expect(theme.scheme()).toBe('dark');
    expect(document.documentElement.dataset['theme']).toBe('technical-dark');
    expect(themeMeta().content).toBe('#0c0e10');
  });

  it('follows the OS while on auto', () => {
    const theme = create(false);
    media!.set(true);
    TestBed.tick();
    expect(theme.theme()).toBe('technical-light');
    expect(theme.scheme()).toBe('light');
    expect(document.documentElement.dataset['theme']).toBe('technical-light');
  });

  it('keeps a chosen theme and remembers it', () => {
    const theme = create(false);
    theme.setPreference('light');
    TestBed.tick();
    expect(theme.theme()).toBe('light');
    expect(document.documentElement.dataset['theme']).toBe('light');
    expect(themeMeta().content).toBe('#f4f2ed');
    expect(localStorage.getItem('racs.theme')).toBe('light');

    TestBed.resetTestingModule();
    media?.restore();
    expect(create(false).theme()).toBe('light');
  });

  it('ignores an unknown stored value', () => {
    localStorage.setItem('racs.theme', 'neon');
    expect(create(true).preference()).toBe('auto');
  });
});

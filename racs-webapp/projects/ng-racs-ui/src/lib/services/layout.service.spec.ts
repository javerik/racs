import { TestBed } from '@angular/core/testing';
import { LayoutService, NARROW_QUERY, TOUCH_QUERY } from './layout.service';

interface FakeQuery {
  matches: boolean;
  listeners: Set<() => void>;
}

/** A controllable `window.matchMedia` for the two queries the service watches. */
function stubMatchMedia(initial: Record<string, boolean>) {
  const queries = new Map<string, FakeQuery>();
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => {
    let q = queries.get(query);
    if (!q) {
      q = { matches: initial[query] ?? false, listeners: new Set() };
      queries.set(query, q);
    }
    const fake = q;
    return {
      get matches() {
        return fake.matches;
      },
      media: query,
      addEventListener: (_: string, fn: () => void) => fake.listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => fake.listeners.delete(fn),
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
  return {
    set(query: string, matches: boolean) {
      const q = queries.get(query)!;
      q.matches = matches;
      q.listeners.forEach((fn) => fn());
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

function viewportMeta(): HTMLMetaElement {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'viewport';
    document.head.appendChild(meta);
  }
  return meta;
}

describe('LayoutService', () => {
  let media: ReturnType<typeof stubMatchMedia> | undefined;

  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    viewportMeta().content = 'width=device-width, initial-scale=1';
  });

  afterEach(() => {
    media?.restore();
    media = undefined;
    vi.unstubAllGlobals();
  });

  function create(initial: Record<string, boolean>): LayoutService {
    media = stubMatchMedia(initial);
    const layout = TestBed.inject(LayoutService);
    TestBed.tick();
    return layout;
  }

  it('detects a desktop', () => {
    const layout = create({});
    expect(layout.mode()).toBe('desktop');
    expect(document.documentElement.dataset['layout']).toBe('desktop');
  });

  it('detects a phone by width or by a touch-only pointer', () => {
    expect(create({ [NARROW_QUERY]: true }).isMobile()).toBe(true);
    TestBed.resetTestingModule();
    media?.restore();
    // A phone in landscape is wider than the breakpoint but still touch only.
    expect(create({ [TOUCH_QUERY]: true }).isMobile()).toBe(true);
    expect(document.documentElement.dataset['layout']).toBe('mobile');
  });

  it('follows the screen while on auto', () => {
    const layout = create({});
    media!.set(NARROW_QUERY, true);
    TestBed.tick();
    expect(layout.mode()).toBe('mobile');
    expect(document.documentElement.dataset['layout']).toBe('mobile');
  });

  it('keeps a chosen mode and remembers it', () => {
    const layout = create({});
    layout.setPreference('mobile');
    TestBed.tick();
    expect(layout.mode()).toBe('mobile');
    expect(localStorage.getItem('racs.layout')).toBe('mobile');

    TestBed.resetTestingModule();
    media?.restore();
    expect(create({}).preference()).toBe('mobile');
  });

  it('renders forced desktop on a phone at desktop width', () => {
    const layout = create({ [TOUCH_QUERY]: true });
    expect(viewportMeta().content).toContain('device-width');

    layout.setPreference('desktop');
    TestBed.tick();
    expect(layout.mode()).toBe('desktop');
    expect(viewportMeta().content).toBe('width=1280');

    layout.setPreference('auto');
    TestBed.tick();
    expect(viewportMeta().content).toContain('device-width');
  });
});

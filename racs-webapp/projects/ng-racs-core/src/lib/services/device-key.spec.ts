import { deviceStorageKey, migrateStorage } from './device-key';

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

describe('deviceStorageKey', () => {
  it('keys a device by its MAC, lowercased', () => {
    expect(deviceStorageKey('racs.x', { id: 3, mac: '00:11:22:AA:BB:CC' })).toBe('racs.x.00:11:22:aa:bb:cc');
  });

  it('falls back to the id for a device without a MAC', () => {
    expect(deviceStorageKey('racs.x', { id: 3, mac: '' })).toBe('racs.x.id3');
    expect(deviceStorageKey('racs.x', { id: 0, mac: null })).toBe('racs.x.id0');
    expect(deviceStorageKey('racs.x', { id: 7 })).toBe('racs.x.id7');
  });

  it('has no key while the device is not known', () => {
    expect(deviceStorageKey('racs.x', undefined)).toBeNull();
    expect(deviceStorageKey('racs.x', null)).toBeNull();
  });
});

describe('migrateStorage', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('moves a value once', () => {
    localStorage.setItem('old', 'v');
    migrateStorage('old', 'new');
    expect(localStorage.getItem('new')).toBe('v');
    expect(localStorage.getItem('old')).toBeNull();
    localStorage.setItem('new', 'changed');
    migrateStorage('old', 'new');
    expect(localStorage.getItem('new')).toBe('changed');
  });

  it('never overwrites, and leaves the old value for another device', () => {
    localStorage.setItem('old', 'v');
    localStorage.setItem('new', 'mine');
    migrateStorage('old', 'new');
    expect(localStorage.getItem('new')).toBe('mine');
    expect(localStorage.getItem('old')).toBe('v');
  });

  it('drops a refused value', () => {
    localStorage.setItem('old', 'bad');
    const accept = vi.fn((raw: string) => raw === 'good');
    migrateStorage('old', 'new', accept);
    expect(accept).toHaveBeenCalledWith('bad');
    expect(localStorage.getItem('new')).toBeNull();
    expect(localStorage.getItem('old')).toBeNull();
  });

  it('does nothing without an old value', () => {
    const accept = vi.fn(() => true);
    migrateStorage('old', 'new', accept);
    expect(accept).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it('survives a throwing storage', () => {
    const fail = () => {
      throw new Error('denied');
    };
    vi.stubGlobal('localStorage', { getItem: fail, setItem: fail, removeItem: fail });
    expect(() => migrateStorage('old', 'new')).not.toThrow();
  });
});

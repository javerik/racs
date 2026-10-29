import { TestBed } from '@angular/core/testing';
import { LASERLINE_CHANNEL, type FromLaserline, type MetricMapping, type RemoteStatus, type ToLaserline } from '../laserline/protocol';
import { LaserlineLinkService } from './laserline-link.service';

const STATUS: RemoteStatus = { viewPx: [800, 600], envelope: null, session: null, field: null };

/** A laserline window on the channel: answers like `RemoteHost`. */
function fakeLaserline(id: string, opts: { draw?: boolean; status?: Partial<RemoteStatus> } = {}) {
  const ch = new BroadcastChannel(LASERLINE_CHANNEL);
  const got: ToLaserline[] = [];
  let session: string | null = null;
  const post = (m: Omit<FromLaserline, 'v' | 'host'> & { type: FromLaserline['type'] }) => ch.postMessage({ v: 1, host: id, ...m });
  ch.onmessage = (e) => {
    const m = e.data as ToLaserline;
    got.push(m);
    if (m.type === 'hello') post({ type: 'status', status: { ...STATUS, ...opts.status, session } } as never);
    else if (m.to !== id) return;
    else if (m.type === 'begin') {
      session = m.session;
      post({ type: 'status', status: { ...STATUS, session } } as never);
    } else if (m.type === 'show' && opts.draw !== false) post({ type: 'shown', session: m.session, id: m.id, viewPx: [800, 600] } as never);
    else if (m.type === 'fit-to-field') post({ type: 'fitted', id: m.id, fits: false } as never);
  };
  return { ch, got };
}

describe('LaserlineLinkService', () => {
  const open: BroadcastChannel[] = [];
  afterEach(() => {
    open.splice(0).forEach((c) => c.close());
    TestBed.inject(LaserlineLinkService).ngOnDestroy();
  });

  it('finds a laserline window and runs a session', async () => {
    const ll = fakeLaserline('w1');
    open.push(ll.ch);
    const link = TestBed.inject(LaserlineLinkService);
    expect(await link.hello()).toBe('w1');
    expect(link.status()).toEqual(STATUS);
    await link.begin('s');
    const shown = await link.show('s', 4, { kind: 'blank' });
    expect(shown.viewPx).toEqual([800, 600]);
    expect(shown.at).toBeGreaterThan(0);
    expect(await link.fitToField(10)).toBe(false);
    link.end('s');
    link.setField([[0, 0], [1, 0], [1, 1]], 'cam');
    await new Promise((r) => setTimeout(r, 20));
    expect(ll.got.map((m) => m.type)).toEqual(['hello', 'begin', 'show', 'fit-to-field', 'end', 'camera-field']);
  });

  it('reads the metric mapping from the status', async () => {
    const link = TestBed.inject(LaserlineLinkService);
    expect(link.metric()).toBeUndefined();
    // An old laserline: no field at all.
    let ll = fakeLaserline('old');
    open.push(ll.ch);
    expect(await link.hello()).toBe('old');
    expect(link.metric()).toBeUndefined();
    ll.ch.close();
    // No scan.
    link.ngOnDestroy();
    TestBed.resetTestingModule();
    const noScan = TestBed.inject(LaserlineLinkService);
    ll = fakeLaserline('none', { status: { metric: null } });
    open.push(ll.ch);
    expect(await noScan.hello()).toBe('none');
    expect(noScan.metric()).toBeNull();
    ll.ch.close();
    noScan.ngOnDestroy();
    TestBed.resetTestingModule();
    const metric: MetricMapping = {
      rev: 3,
      base: { center_px: [400, 300], dir: [1, 0], normal: [0, 1] },
      along_px_per_mm: 20,
      height_px_per_mm: -20,
      u0_mm: 0,
      dv_mm: 0.5,
      rows: 41,
      travel: { mode: 'per_second', rows_per_s: 60, mm_per_s: 30, approximate: false, playing: true, end: 'loop' },
      object_mm: { min: [-10, 0, 8], max: [10, 10, 8] },
      model_mirrored: false,
      disturbances: [],
    };
    const withScan = TestBed.inject(LaserlineLinkService);
    open.push(fakeLaserline('scan', { status: { metric } }).ch);
    expect(await withScan.hello()).toBe('scan');
    expect(withScan.metric()).toEqual(metric);
  });

  it('keeps a session alive while it runs and ends it however it ends', async () => {
    const link = TestBed.inject(LaserlineLinkService);
    const begin = vi.spyOn(link, 'begin').mockResolvedValue(undefined);
    const touch = vi.spyOn(link, 'touch').mockImplementation(() => undefined);
    const end = vi.spyOn(link, 'end').mockImplementation(() => undefined);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    try {
      let named = '';
      const ran = link.runSession('racs-3', async (session) => {
        named = session;
        await new Promise((r) => setTimeout(r, 9_000));
        return 7;
      });
      await vi.advanceTimersByTimeAsync(9_000);
      expect(await ran).toBe(7);
      expect(named).toMatch(/^racs-3-[0-9a-z]+$/);
      expect(begin).toHaveBeenCalledWith(named);
      expect(touch).toHaveBeenCalledTimes(2);
      expect(end).toHaveBeenCalledWith(named);

      const failed = link.runSession('racs-3', async () => {
        throw new Error('cancelled');
      });
      await expect(failed).rejects.toThrow('cancelled');
      expect(end).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(touch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens laserline when none answers', async () => {
    const link = TestBed.inject(LaserlineLinkService);
    const opener = vi.fn(() => {
      // The window loads a little later.
      setTimeout(() => open.push(fakeLaserline('w2').ch), 50);
    });
    expect(await link.connect(opener)).toBe('w2');
    expect(opener).toHaveBeenCalledTimes(1);
  });

  it('explains a view that does not draw', async () => {
    open.push(fakeLaserline('w3', { draw: false }).ch);
    const link = TestBed.inject(LaserlineLinkService);
    expect(await link.hello()).toBe('w3');
    // Only the wait for the pattern runs on fake time.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const shown = link.show('s', 1, { kind: 'blank' });
      const failed = expect(shown).rejects.toThrow(/keep its window visible/);
      await vi.advanceTimersByTimeAsync(3100);
      await failed;
    } finally {
      vi.useRealTimers();
    }
  });
});

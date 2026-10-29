import { HttpErrorResponse } from '@angular/common/http';
import { Observable, of, Subject, throwError } from 'rxjs';
import type { BurstJobInfo, ImageEntryInfo, JobStatus } from '../models/racs.models';
import { BurstFetch, type BurstApi, type BurstFetchHandlers } from './burst-fetch';

function job(status: JobStatus, captured: number, failed = 0): BurstJobInfo {
  return {
    job_id: 'j',
    device_id: 0,
    status,
    format: 'raw',
    requested_count: 4,
    captured_count: captured,
    failed_count: failed,
    created_at: '',
    started_at: null,
    completed_at: null,
    expires_at: null,
    error: null,
    width: 2,
    height: 1,
    pixel_format: 'Coord3D_C16',
    bit_depth: 16,
  };
}

/** A fake API: statuses answered in order (the last one repeats), images held until released. */
function fakeApi(statuses: BurstJobInfo[], entries: () => ImageEntryInfo[]) {
  const downloads = new Map<number, Subject<ArrayBuffer>>();
  let polls = 0;
  const api: BurstApi = {
    getBurst: () => of(statuses[Math.min(polls++, statuses.length - 1)]) as Observable<BurstJobInfo>,
    listBurstImages: () => of(entries()),
    getBurstImage: (_d: number, _j: string, index: number) => {
      const s = new Subject<ArrayBuffer>();
      downloads.set(index, s);
      return s;
    },
  };
  const release = (index: number) => {
    downloads.get(index)!.next(new Uint16Array([index, index]).buffer);
    downloads.get(index)!.complete();
    downloads.delete(index);
  };
  return { api, downloads, release };
}

function handlers() {
  return {
    image: vi.fn(),
    failed: vi.fn(),
    finished: vi.fn(),
    error: vi.fn(),
  } satisfies BurstFetchHandlers;
}

const ok = (index: number): ImageEntryInfo => ({ status: 'ok', index, size_bytes: 4 });

describe('BurstFetch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('downloads at most a few images at once, and finishes after the last', () => {
    const { api, downloads, release } = fakeApi([job('completed', 4)], () => [0, 1, 2, 3].map(ok));
    const h = handlers();
    new BurstFetch(api, 0, 'j', h, { maxInFlight: 2 }).start();
    vi.advanceTimersByTime(0);

    expect([...downloads.keys()]).toEqual([0, 1]);
    release(1);
    expect([...downloads.keys()]).toEqual([0, 2]);
    expect(h.image).toHaveBeenCalledWith(1, new Uint8Array([1, 0, 1, 0]), expect.anything());
    release(0);
    release(2);
    expect(h.finished).not.toHaveBeenCalled();
    release(3);
    expect(h.finished).toHaveBeenCalledTimes(1);
    expect(h.image).toHaveBeenCalledTimes(4);
  });

  it('keeps polling while the job runs and lists what is new', () => {
    let listed: ImageEntryInfo[] = [ok(0)];
    const { api, downloads, release } = fakeApi([job('running', 1), job('completed', 2)], () => listed);
    const h = handlers();
    new BurstFetch(api, 0, 'j', h, { pollMs: 100 }).start();
    vi.advanceTimersByTime(0);
    release(0);
    expect(h.finished).not.toHaveBeenCalled();

    listed = [ok(0), ok(1)];
    vi.advanceTimersByTime(100);
    expect([...downloads.keys()]).toEqual([1]);
    release(1);
    expect(h.finished).toHaveBeenCalledTimes(1);
  });

  it('reports images the job could not capture and still finishes', () => {
    const { api, release } = fakeApi([job('completed', 1, 1)], () => [
      ok(0),
      { status: 'failed', index: 1, error: 'timeout' },
    ]);
    const h = handlers();
    new BurstFetch(api, 0, 'j', h).start();
    vi.advanceTimersByTime(0);
    expect(h.failed).toHaveBeenCalledWith(1, 'timeout');
    release(0);
    expect(h.finished).toHaveBeenCalledTimes(1);
  });

  it('says so when the job is gone', () => {
    const api: BurstApi = {
      getBurst: () => throwError(() => new HttpErrorResponse({ status: 404 })),
      listBurstImages: () => of([]),
      getBurstImage: () => of(new ArrayBuffer(0)),
    };
    const h = handlers();
    new BurstFetch(api, 0, 'j', h).start();
    vi.advanceTimersByTime(0);
    expect(h.error).toHaveBeenCalledWith(expect.stringMatching(/gone/), true);
    expect(h.finished).not.toHaveBeenCalled();
  });

  it('drops late answers once stopped', () => {
    const { api, release } = fakeApi([job('running', 1)], () => [ok(0)]);
    const h = handlers();
    const fetch = new BurstFetch(api, 0, 'j', h);
    fetch.start();
    vi.advanceTimersByTime(0);
    fetch.stop();
    release(0);
    expect(h.image).not.toHaveBeenCalled();
  });
});

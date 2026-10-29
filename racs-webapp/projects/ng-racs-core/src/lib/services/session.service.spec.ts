import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { racsSessionInterceptor } from './session.interceptor';
import { browserName, SESSION_CHANNEL, SESSION_KEY, SessionService } from './session.service';

/** The test environment has no storage of its own. */
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

const created = (n: number) => ({
  session_id: `0000000${n}-0000-4000-8000-000000000000`,
  client_id: `c${n}c${n}c${n}c${n}`,
  name: 'webapp · test',
  timeout_s: 30,
  heartbeat_interval_s: 10,
});

/** Lets promise chains and the claim wait run. */
const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function setup() {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(withInterceptors([racsSessionInterceptor])), provideHttpClientTesting()],
  });
  return {
    session: TestBed.inject(SessionService),
    http: TestBed.inject(HttpTestingController),
    client: TestBed.inject(HttpClient),
  };
}

describe('SessionService', () => {
  let others: BroadcastChannel[] = [];

  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.stubGlobal('localStorage', memoryStorage());
  });

  afterEach(() => {
    others.forEach((c) => c.close());
    others = [];
    TestBed.inject(SessionService).ngOnDestroy();
    TestBed.inject(HttpTestingController).verify();
    vi.unstubAllGlobals();
  });

  it('creates a session and sends it with API requests', async () => {
    const { session, http, client } = setup();
    const answer = firstValueFrom(client.get('/api/v1/devices/connected'));
    await wait();
    const post = http.expectOne('/api/v1/sessions');
    expect(post.request.method).toBe('POST');
    expect(post.request.headers.has('X-Racs-Session')).toBe(false);
    expect(post.request.body.name).toMatch(/^webapp · /);
    post.flush(created(1));
    await wait();

    const get = http.expectOne('/api/v1/devices/connected');
    expect(get.request.headers.get('X-Racs-Session')).toBe(created(1).session_id);
    get.flush([]);
    await answer;
    expect(session.clientId()).toBe(created(1).client_id);
    expect(JSON.parse(sessionStorage.getItem(SESSION_KEY)!).session_id).toBe(created(1).session_id);
  });

  it('reuses the stored session after a reload', async () => {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(created(2)));
    const { session, http } = setup();
    expect(await session.ensure()).toBe(created(2).session_id);
    http.expectNone('/api/v1/sessions');
  });

  it('starts its own session in a duplicated tab', async () => {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(created(2)));
    // The original tab, which has the copied session, answers the claim.
    const original = new BroadcastChannel(SESSION_CHANNEL);
    others.push(original);
    original.onmessage = (e) => {
      if (e.data.type === 'claim') {
        original.postMessage({ type: 'taken', session_id: e.data.session_id });
      }
    };
    const { session, http } = setup();
    const id = session.ensure();
    await wait(50);
    http.expectOne('/api/v1/sessions').flush(created(3));
    expect(await id).toBe(created(3).session_id);
  });

  it('answers other tabs that claim its session', async () => {
    const { session, http } = setup();
    const id = session.ensure();
    await wait();
    http.expectOne('/api/v1/sessions').flush(created(4));
    await id;

    const copy = new BroadcastChannel(SESSION_CHANNEL);
    others.push(copy);
    const answer = new Promise((resolve) => (copy.onmessage = (e) => resolve(e.data)));
    copy.postMessage({ type: 'claim', session_id: created(4).session_id });
    expect(await answer).toEqual({ type: 'taken', session_id: created(4).session_id });
  });

  it('renews an expired session once, retries, and joins its devices again', async () => {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(created(5)));
    const { session, http, client } = setup();
    session.markJoined(0);
    const a = firstValueFrom(client.get('/api/v1/devices/0/access'));
    const b = firstValueFrom(client.get('/api/v1/devices/0/xml', { responseType: 'text' }));
    await wait(200); // nobody claims the stored session
    const expired = { error: 'session_expired' };
    http.expectOne('/api/v1/devices/0/access').flush(expired, { status: 401, statusText: 'Unauthorized' });
    http.expectOne('/api/v1/devices/0/xml').flush(JSON.stringify(expired), { status: 401, statusText: 'Unauthorized' });
    await wait();

    // One new session for both.
    http.expectOne('/api/v1/sessions').flush(created(6));
    await wait();
    const rejoin = http.expectOne('/api/v1/devices/0/connect');
    expect(rejoin.request.headers.get('X-Racs-Session')).toBe(created(6).session_id);
    expect(rejoin.request.params.has('mode')).toBe(false);
    rejoin.flush({});
    await wait();

    const retried = http.match((r) => r.url.startsWith('/api/v1/devices/0/') && !r.url.endsWith('/connect'));
    expect(retried.length).toBe(2);
    for (const r of retried) {
      expect(r.request.headers.get('X-Racs-Session')).toBe(created(6).session_id);
      r.flush(r.request.url.endsWith('xml') ? '<xml/>' : {});
    }
    await Promise.all([a, b]);
    expect(session.id()).toBe(created(6).session_id);
  });

  it('renames the session on the server', async () => {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(created(7)));
    const { session, http } = setup();
    await session.ensure();
    const done = session.rename('  line-cam  ');
    const patch = http.expectOne(`/api/v1/sessions/${created(7).session_id}`);
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toEqual({ name: 'line-cam' });
    patch.flush(null, { status: 204, statusText: 'No Content' });
    await done;
    expect(session.name()).toBe('line-cam');
    expect(localStorage.getItem('racs.client.name')).toBe('line-cam');
  });

});

describe('browserName', () => {
  it('names the browser', () => {
    expect(browserName('Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0')).toBe('Firefox');
    expect(browserName('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0')).toBe('Edge');
    expect(browserName('Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36')).toBe('Chrome');
    expect(browserName('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15')).toBe('Safari');
    expect(browserName('anything', true)).toBe('Brave');
  });
});

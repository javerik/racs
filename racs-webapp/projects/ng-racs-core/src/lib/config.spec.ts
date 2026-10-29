import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { DEFAULT_RACS_CONFIG, RACS_CONFIG, resolveRacsConfig } from './config';
import { provideRacs } from './provide-racs';
import { RacsService } from './services/racs.service';
import { racsSessionInterceptor } from './services/session.interceptor';
import { SessionService } from './services/session.service';
import { LASERLINE_TOOL } from './services/tool-window.service';
import { wsUrl } from './ws-url';

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

const wait = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const created = {
  session_id: '00000001-0000-4000-8000-000000000000',
  client_id: 'c1c1c1c1',
  name: 'webapp · test',
  timeout_s: 30,
  heartbeat_interval_s: 10,
};

describe('RacsConfig', () => {
  it('defaults to the API on the page origin and the bundled laserline', () => {
    expect(TestBed.inject(RACS_CONFIG)).toEqual(DEFAULT_RACS_CONFIG);
    expect(DEFAULT_RACS_CONFIG).toEqual({ apiBase: '/api/v1', tools: [LASERLINE_TOOL], autoStart: true });
  });

  it('trims trailing slashes from the API base', () => {
    expect(resolveRacsConfig({ apiBase: 'http://cam:8742/api/v1/' }).apiBase).toBe('http://cam:8742/api/v1');
    expect(resolveRacsConfig().apiBase).toBe('/api/v1');
  });
});

describe('wsUrl', () => {
  it('uses the page host for a path base, as before', () => {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    expect(wsUrl('/api/v1', '/events', new URLSearchParams({ session: 's' }))).toBe(
      `${scheme}://${location.host}/api/v1/events?session=s`,
    );
    expect(wsUrl('/api/v1', '/devices/0/stream/live', new URLSearchParams())).toBe(
      `${scheme}://${location.host}/api/v1/devices/0/stream/live`,
    );
  });

  it('follows an absolute base and its scheme', () => {
    expect(wsUrl('http://cam:8742/api/v1', '/events', new URLSearchParams({ session: 's' }))).toBe(
      'ws://cam:8742/api/v1/events?session=s',
    );
    expect(wsUrl('https://racs.example/api/v1', '/events', new URLSearchParams())).toBe(
      'wss://racs.example/api/v1/events',
    );
  });
});

describe('provideRacs', () => {
  beforeEach(() => {
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.stubGlobal('localStorage', memoryStorage());
  });

  afterEach(() => {
    TestBed.inject(SessionService).ngOnDestroy();
    TestBed.inject(HttpTestingController).verify();
    vi.unstubAllGlobals();
  });

  function setup(config: Parameters<typeof provideRacs>[0]) {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([racsSessionInterceptor])),
        provideHttpClientTesting(),
        provideRacs(config),
      ],
    });
    return { http: TestBed.inject(HttpTestingController), client: TestBed.inject(HttpClient) };
  }

  it('sends requests, sessions included, to an absolute API base', async () => {
    const { http } = setup({ apiBase: 'http://cam:8742/api/v1/', autoStart: false });
    const racs = TestBed.inject(RacsService);
    const answer = firstValueFrom(racs.getConnectedDevices());
    await wait();
    http.expectOne('http://cam:8742/api/v1/sessions').flush(created);
    await wait();
    const get = http.expectOne('http://cam:8742/api/v1/devices/connected');
    expect(get.request.headers.get('X-Racs-Session')).toBe(created.session_id);
    get.flush([]);
    expect(await answer).toEqual([]);
  });

  it('leaves requests outside the API base alone', async () => {
    const { http, client } = setup({ apiBase: 'http://cam:8742/api/v1', autoStart: false });
    const answer = firstValueFrom(client.get('/api/v1/devices/connected'));
    await wait();
    const get = http.expectOne('/api/v1/devices/connected');
    expect(get.request.headers.has('X-Racs-Session')).toBe(false);
    get.flush([]);
    await answer;
  });

  it('starts the session and the events socket at app start', async () => {
    const opened: string[] = [];
    vi.stubGlobal(
      'WebSocket',
      class {
        constructor(url: string) {
          opened.push(url);
        }
        close() {}
      },
    );
    const { http } = setup({ apiBase: 'http://cam:8742/api/v1' });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    await wait();
    http.expectOne('http://cam:8742/api/v1/sessions').flush(created);
    await wait();
    expect(TestBed.inject(SessionService).clientId()).toBe(created.client_id);
    TestBed.tick();
    expect(opened).toEqual([`ws://cam:8742/api/v1/events?session=${created.session_id}`]);
  });

  it('starts nothing with autoStart off', async () => {
    const { http } = setup({ autoStart: false });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    await wait();
    http.expectNone('/api/v1/sessions');
    expect(TestBed.inject(SessionService).clientId()).toBeNull();
  });
});

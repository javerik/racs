import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { FeatureState, GenICamNodeCategory, GenICamNodeInfo } from '../models/racs.models';
import { DeviceSelectionService } from './device-selection.service';
import { GenicamSession, REMOTE_HINT_MS } from './genicam-session.service';
import { RacsService } from './racs.service';
import { ServerEventsService } from './server-events.service';
import { SessionService } from './session.service';

function node(name: string, extra: Partial<GenICamNodeInfo> = {}): GenICamNodeInfo {
  return {
    name,
    display_name: name,
    node_type: 'Integer',
    visibility: 'Beginner',
    access_mode: 'ReadWrite',
    enums: null,
    selected: [],
    ...extra,
  };
}

const CATEGORIES: GenICamNodeCategory[] = [
  {
    name: 'Root',
    display_name: 'Root',
    nodes: [node('Sel', { node_type: 'Enum', selected: ['Dep'] }), node('Dep'), node('Other'), node('W')],
  },
];

function state(name: string, value = '0'): FeatureState {
  return {
    name,
    node_type: 'Integer',
    value,
    available: true,
    locked: false,
    min: null,
    max: null,
    inc: null,
    unit: null,
    representation: null,
    available_entries: null,
    error: null,
  };
}

const STATE_URL = '/api/v1/devices/0/gc/features/state';
/** Lets the session send what it batched in the current task. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup() {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), GenicamSession],
  });
  TestBed.inject(DeviceSelectionService).setSelectedDeviceId(0);
  const session = TestBed.inject(GenicamSession);
  const http = TestBed.inject(HttpTestingController);
  TestBed.tick();
  http.expectOne('/api/v1/devices/0/gc/categories').flush(CATEGORIES);
  return { session, http };
}

/** Answers the pending state request with a state per requested name. */
function answerStates(http: HttpTestingController, value = '0'): string[] {
  const req = http.expectOne(STATE_URL);
  const names: string[] = req.request.body.names;
  req.flush(names.map((n) => state(n, value)));
  return names;
}

describe('GenicamSession', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('batches reads asked for in the same task into one request', async () => {
    const { session, http } = setup();
    session.read(['Dep']);
    session.read(['Other', 'Dep', 'Unknown']);
    await settle();
    expect(answerStates(http, '7')).toEqual(['Dep', 'Other']);
    expect(session.value('Other')).toBe('7');
    expect(session.busy()).toBe(false);

    // Known now: not read again unless forced.
    session.read(['Dep']);
    await settle();
    http.expectNone(STATE_URL);
  });

  it('keeps only one request in flight', async () => {
    const { session, http } = setup();
    session.read(['Dep']);
    await settle();
    session.write('W', '5');
    http.expectNone((r) => r.method === 'PUT');

    answerStates(http);
    await settle();
    const put = http.expectOne((r) => r.method === 'PUT');
    expect(put.request.params.get('value')).toBe('5');
    put.flush(null);
    await settle();
    answerStates(http);
  });

  it('a write still queued takes the newest value', async () => {
    const { session, http } = setup();
    session.read(['Dep']);
    await settle();
    for (const v of ['1', '2', '3']) {
      session.write('W', v);
    }
    answerStates(http);
    await settle();
    const puts = http.match((r) => r.method === 'PUT');
    expect(puts.map((p) => p.request.params.get('value'))).toEqual(['3']);
    puts[0].flush(null);
    await settle();
    answerStates(http);
  });

  it('after a write re-reads the feature, what it selects, then everything watched', async () => {
    const { session, http } = setup();
    session.watch('view', ['Other', 'Dep', 'Sel']);
    await settle();
    answerStates(http);

    session.write('Sel', '1');
    await settle();
    http.expectOne((r) => r.method === 'PUT').flush(null);
    await settle();
    expect(answerStates(http)).toEqual(['Sel', 'Dep', 'Other']);
  });

  it('drops queued requests when the device changes', async () => {
    const { session, http } = setup();
    session.read(['Dep']);
    await settle();
    session.write('W', '5');

    TestBed.inject(DeviceSelectionService).setSelectedDeviceId(1);
    TestBed.tick();
    http.expectOne('/api/v1/devices/1/gc/categories').flush(CATEGORIES);
    answerStates(http);
    await settle();
    http.expectNone((r) => r.method === 'PUT');
  });

  it('a failed write is reported and the device value re-read', async () => {
    const { session, http } = setup();
    session.write('W', '9999');
    await settle();
    http.expectOne((r) => r.method === 'PUT').flush('Value error', { status: 500, statusText: 'Error' });
    await settle();
    expect(session.nodeErrors()['W']).toBe('Value error');
    expect(answerStates(http, '64')).toEqual(['W']);
    expect(session.value('W')).toBe('64');
  });
  it('runs a change in the queue after earlier requests, then re-reads like a write', async () => {
    const { session, http } = setup();
    session.watch('view', ['Other']);
    await settle();
    session.write('W', '5');
    let result: unknown;
    const done = session
      .change('W', (id) => TestBed.inject(RacsService).autoPacketSize(id))
      .then((r) => (result = r));
    expect(session.savingNodes().get('W')).toBe(2);

    answerStates(http);
    await settle();
    http.expectNone('/api/v1/devices/0/stream/packet-size/auto');
    http.expectOne((r) => r.method === 'PUT').flush(null);
    await settle();
    // Queued before the write's refresh, so it goes first; the refresh then covers both.
    const auto = { packet_size: 9000, previous: 1500, test_packets: true, link_mtu: 9000, interface: 'eth1' };
    http.expectOne({ method: 'POST', url: '/api/v1/devices/0/stream/packet-size/auto' }).flush(auto);
    await done;
    expect(result).toEqual(auto);
    expect(session.savingNodes().has('W')).toBe(false);
    await settle();
    expect(answerStates(http, '9000')).toEqual(['W', 'Other']);
    expect(session.value('W')).toBe('9000');
  });

  it('a failed change is reported on its feature and rejects', async () => {
    const { session, http } = setup();
    const done = session.change('W', (id) => TestBed.inject(RacsService).autoPacketSize(id));
    await settle();
    http.expectOne((r) => r.method === 'POST').flush('Busy', { status: 500, statusText: 'Error' });
    await expect(done).rejects.toBeTruthy();
    expect(session.nodeErrors()['W']).toBe('Busy');
    await settle();
    answerStates(http);
  });

  it('a change still queued when the device changes rejects instead of running', async () => {
    const { session, http } = setup();
    session.read(['Dep']);
    await settle();
    const done = session.change('W', (id) => TestBed.inject(RacsService).autoPacketSize(id));

    TestBed.inject(DeviceSelectionService).setSelectedDeviceId(1);
    TestBed.tick();
    http.expectOne('/api/v1/devices/1/gc/categories').flush(CATEGORIES);
    answerStates(http);
    await expect(done).rejects.toThrow('The device changed');
    http.expectNone((r) => r.method === 'POST' && r.url.includes('packet-size'));
  });

  describe('with other clients', () => {
    const script = { client_id: '77d0aa12', name: 'line-script' };
    const changed = (feature: string, by: { client_id: string; name: string | null } | null) => ({
      seq: 9,
      time: '',
      type: 'feature_changed' as const,
      device: 0,
      feature,
      by,
    });

    it('re-reads a feature another client changed, as after its own write, and says so', async () => {
      const { session, http } = setup();
      session.watch('view', ['Sel', 'Dep', 'Other']);
      await settle();
      answerStates(http);

      TestBed.inject(ServerEventsService).events$.next(changed('Sel', script));
      await settle();
      expect(answerStates(http, '4')).toEqual(['Sel', 'Dep', 'Other']);
      expect(session.value('Sel')).toBe('4');
      expect(session.remoteChange()).toBe('Sel · changed by line-script');
    });

    it('ignores its own changes and other devices', async () => {
      const { session, http } = setup();
      TestBed.inject(SessionService).clientId.set('3f2a9c1e');
      session.watch('view', ['Dep']);
      await settle();
      answerStates(http);

      const events = TestBed.inject(ServerEventsService).events$;
      events.next(changed('Dep', { client_id: '3f2a9c1e', name: 'me' }));
      events.next({ ...changed('Dep', script), device: 1 });
      await settle();
      http.expectNone(STATE_URL);
      expect(session.remoteChange()).toBeNull();
    });

    it('re-reads everything shown after another client runs a command, and on resync', async () => {
      const { session, http } = setup();
      session.watch('view', ['Dep', 'Other']);
      await settle();
      answerStates(http);

      const events = TestBed.inject(ServerEventsService);
      events.events$.next({ seq: 9, time: '', type: 'command_executed', device: 0, command: 'UserSetLoad', by: null });
      await settle();
      expect(answerStates(http)).toEqual(['Dep', 'Other']);
      expect(session.remoteChange()).toBe('UserSetLoad · executed by another client');

      events.resync$.next();
      await settle();
      expect(answerStates(http)).toEqual(['Dep', 'Other']);
    });

    it('drops the hint after a while', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        const { session } = setup();
        TestBed.inject(ServerEventsService).events$.next(changed('Other', script));
        expect(session.remoteChange()).not.toBeNull();
        vi.advanceTimersByTime(REMOTE_HINT_MS);
        expect(session.remoteChange()).toBeNull();
      } finally {
        vi.useRealTimers();
      }
      await settle();
      answerStates(TestBed.inject(HttpTestingController));
    });

    it('blocks writes for a reader, with the reason, and reads nothing when locked out', async () => {
      const { session, http } = setup();
      expect(session.writeBlocked()).toBe(false);
      const base = { device: 0, members: [], holder: null, viewers: 0 };
      session.access.set({ ...base, mode: 'ro-shared', owner: script, you: 'reader' });
      expect(session.canWrite()).toBe(false);
      expect(session.writeBlocked()).toBe(true);
      expect(session.readOnlyReason()).toBe('read-only · held by line-script');

      session.access.set({ ...base, mode: 'exclusive', owner: script, you: 'meta' });
      TestBed.tick();
      session.read(['Dep']);
      await settle();
      http.expectNone(STATE_URL);

      // The lock ends: what is shown is read again.
      session.watch('view', ['Dep']);
      session.access.set({ ...base, mode: 'shared', owner: null, you: 'writer' });
      TestBed.tick();
      await settle();
      expect(answerStates(http)).toEqual(['Dep']);
    });

    it('loads and reads nothing while the device is not connected', async () => {
      const { session, http } = setup();
      session.watch('view', ['Dep']);
      await settle();
      answerStates(http);

      session.present.set(false);
      TestBed.tick();
      session.read(['Dep', 'Other'], true);
      TestBed.inject(ServerEventsService).events$.next(changed('Dep', script));
      await settle();
      http.expectNone(STATE_URL);

      // Connected again: the device loads afresh.
      session.present.set(true);
      TestBed.tick();
      http.expectOne('/api/v1/devices/0/gc/categories').flush(CATEGORIES);
      await settle();
      expect(answerStates(http)).toEqual(['Dep']);
    });
  });
});

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import type { ServerEvent } from '../models/racs.models';
import { RETRY_MIN_MS, ServerEventsService } from './server-events.service';
import { SessionService } from './session.service';

/** Stands in for the browser's WebSocket: the test opens, feeds and closes it. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.CONNECTING;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  closedByClient = false;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.closedByClient = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  receive(event: Partial<ServerEvent> & { type: ServerEvent['type'] }): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onmessage?.({ data: JSON.stringify({ seq: 1, time: '', ...event }) });
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

const latest = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
const hello = { type: 'hello' as const, session: { client_id: 'c1c1c1c1', timeout_s: 30 }, devices: [] };

function setup() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  const session = TestBed.inject(SessionService);
  const heartbeat = vi.spyOn(session, 'heartbeat').mockResolvedValue();
  const renew = vi.spyOn(session, 'renew').mockResolvedValue(null);
  const events = TestBed.inject(ServerEventsService);
  const resyncs: number[] = [];
  events.resync$.subscribe(() => resyncs.push(Date.now()));
  session.id.set('sid-1');
  TestBed.tick();
  return { session, events, heartbeat, renew, resyncs };
}

describe('ServerEventsService', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('opens the events socket with the session and resyncs on hello and resync', () => {
    const { events, resyncs, heartbeat } = setup();
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(latest().url).toMatch(/\/api\/v1\/events\?session=sid-1$/);
    expect(events.connected()).toBe(false);

    latest().receive({
      ...hello,
      devices: [{ device: 0, connected: true, access: { mode: 'shared', owner: null, members: [] }, stream: null, burst: null }],
    });
    expect(events.connected()).toBe(true);
    expect(events.deviceStates().has(0)).toBe(true);
    expect(resyncs.length).toBe(1);

    latest().receive({ type: 'resync' });
    expect(resyncs.length).toBe(2);
    expect(heartbeat).not.toHaveBeenCalled();
  });

  it('reconnects with backoff and heartbeats only while down', () => {
    const { events, heartbeat } = setup();
    latest().receive(hello);

    latest().serverClose(1006);
    expect(events.connected()).toBe(false);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(RETRY_MIN_MS - 1);
    expect(FakeWebSocket.instances.length).toBe(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances.length).toBe(2);

    // Refused again: the next attempt waits twice as long; heartbeats go on meanwhile.
    latest().serverClose(1006);
    vi.advanceTimersByTime(RETRY_MIN_MS);
    expect(FakeWebSocket.instances.length).toBe(2);
    vi.advanceTimersByTime(RETRY_MIN_MS);
    expect(FakeWebSocket.instances.length).toBe(3);
    vi.advanceTimersByTime(10_000);
    const beats = heartbeat.mock.calls.length;
    expect(beats).toBeGreaterThan(1);

    // Back up: no more heartbeats over HTTP.
    latest().receive(hello);
    vi.advanceTimersByTime(60_000);
    expect(heartbeat.mock.calls.length).toBe(beats);
    expect(FakeWebSocket.instances.length).toBe(3);
  });

  it('renews the session when the socket closes with 4001, and follows the new one', () => {
    const { session, renew } = setup();
    latest().receive(hello);
    latest().serverClose(4001, 'session expired');
    expect(renew).toHaveBeenCalledWith('sid-1');
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances.length).toBe(1);

    session.id.set('sid-2');
    TestBed.tick();
    expect(FakeWebSocket.instances.length).toBe(2);
    expect(latest().url).toMatch(/session=sid-2$/);
  });

  it('remembers why a device closed', () => {
    const { events } = setup();
    latest().receive(hello);
    const base = { device: 3, access: { mode: 'shared' as const, owner: null, members: [] }, stream: null, burst: null };
    latest().receive({ type: 'device_state', ...base, connected: true, cause: 'connected', reason: null, by: null });
    expect(events.deviceStates().has(3)).toBe(true);
    latest().receive({ type: 'device_state', ...base, connected: false, cause: 'disconnected', reason: 'idle', by: null });
    expect(events.deviceStates().has(3)).toBe(false);
    expect(events.closed().get(3)).toEqual({ reason: 'idle', by: null });
    latest().receive({ type: 'device_state', ...base, connected: true, cause: 'connected', reason: null, by: null });
    expect(events.closed().has(3)).toBe(false);
  });

  it('closes the socket when the session goes away', () => {
    const { session } = setup();
    const socket = latest();
    session.id.set(null);
    TestBed.tick();
    expect(socket.closedByClient).toBe(true);
  });
});

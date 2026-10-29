import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { ConnectedDevice, DeviceAccess, DeviceConnections, DeviceDiscoverInfo } from '../models/racs.models';
import { DeviceRegistryService } from './device-registry.service';
import { ServerEventsService } from './server-events.service';

function dev(id: number): DeviceDiscoverInfo {
  return {
    id,
    dev_id: `dev${id}`,
    serial_number: `SN${id}`,
    vendor: 'Fake',
    model: `Cam ${id}`,
    manufacturer_info: '',
    ip: `10.0.0.${id}`,
    mac: `00:00:00:00:00:0${id}`,
  };
}

const CONNECTED_URL = '/api/v1/devices/connected';
/** Lets the first poll (a zero-delay timer) go out. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function access(device: number, over: Partial<DeviceAccess> = {}): DeviceAccess {
  return { device, mode: 'shared', owner: null, members: [], holder: null, viewers: 0, you: 'writer', ...over };
}

async function setup(connected: ConnectedDevice[]) {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  const registry = TestBed.inject(DeviceRegistryService);
  const http = TestBed.inject(HttpTestingController);
  TestBed.tick();
  await settle();
  http.expectOne(CONNECTED_URL).flush(connected);
  return { registry, http, events: TestBed.inject(ServerEventsService) };
}

/** Answers a discovery, then the connected list it re-reads for the devices' access. */
function answerDiscovery(http: HttpTestingController, result: DeviceConnections) {
  http.expectOne('/api/v1/devices').flush(result);
  http.expectOne(CONNECTED_URL).flush(result.connected);
}

describe('DeviceRegistryService', () => {
  it('lists discovered devices that are not connected', async () => {
    const { registry, http } = await setup([dev(1)]);
    expect(registry.discovered()).toBe(false);

    registry.discover().subscribe();
    expect(registry.discovering()).toBe(true);
    answerDiscovery(http, { available: [dev(2), dev(1), dev(0)], connected: [dev(1)] });

    expect(registry.discovering()).toBe(false);
    expect(registry.discovered()).toBe(true);
    expect(registry.available().map((d) => d.id)).toEqual([0, 2]);
  });

  it('keeps the last result when a discovery fails', async () => {
    const { registry, http } = await setup([]);
    registry.discover().subscribe();
    answerDiscovery(http, { available: [dev(3)], connected: [] });

    let failed = false;
    registry.discover().subscribe({ error: () => (failed = true) });
    http.expectOne('/api/v1/devices').flush('boom', { status: 500, statusText: 'Error' });

    expect(failed).toBe(true);
    expect(registry.discovering()).toBe(false);
    expect(registry.available().map((d) => d.id)).toEqual([3]);
  });

  it('marks a device busy while it connects, then refreshes the connected list', async () => {
    const { registry, http } = await setup([]);
    registry.discover().subscribe();
    answerDiscovery(http, { available: [dev(4)], connected: [] });

    registry.connect(dev(4)).subscribe();
    expect(registry.isBusy(4)).toBe(true);
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === '/api/v1/devices/4/connect');
    expect(put.request.params.has('mode')).toBe(false);
    put.flush(access(4));
    expect(registry.isBusy(4)).toBe(false);

    http.expectOne(CONNECTED_URL).flush([dev(4)]);
    expect(registry.available()).toEqual([]);
    expect(registry.connected().map((d) => d.id)).toEqual([4]);
  });

  it('puts a disconnected device back among the discovered ones', async () => {
    const { registry, http } = await setup([dev(5)]);
    expect(registry.discovered()).toBe(false);

    registry.disconnect(dev(5)).subscribe();
    expect(registry.isBusy(5)).toBe(true);
    http.expectOne((r) => r.method === 'PUT' && r.url === '/api/v1/devices/5/disconnect').flush({ closed: true, members: 0 });
    http.expectOne(CONNECTED_URL).flush([]);

    expect(registry.isBusy(5)).toBe(false);
    expect(registry.available().map((d) => d.id)).toEqual([5]);
  });

  it('clears the busy mark when a connect fails', async () => {
    const { registry, http } = await setup([]);
    let failed = false;
    registry.connect(dev(6)).subscribe({ error: () => (failed = true) });
    http.expectOne('/api/v1/devices/6/connect').flush('Error: unreachable', { status: 500, statusText: 'Error' });

    expect(failed).toBe(true);
    expect(registry.isBusy(6)).toBe(false);
    http.expectNone(CONNECTED_URL);
  });

  it('connects with the chosen mode, and shared joins without one', async () => {
    const { registry, http } = await setup([]);
    registry.connect(dev(7), undefined, 'exclusive').subscribe();
    const put = http.expectOne('/api/v1/devices/7/connect?mode=exclusive');
    put.flush(access(7, { mode: 'exclusive', you: 'owner' }));
    http.expectOne(CONNECTED_URL).flush([]);

    registry.setConnectMode('ro-shared');
    registry.connect(dev(8)).subscribe();
    http.expectOne('/api/v1/devices/8/connect?mode=ro-shared').flush(access(8));
    http.expectOne(CONNECTED_URL).flush([]);
  });

  it('knows who holds a device, with the live parts from the events', async () => {
    const owner = { client_id: 'aa11bb22', name: 'line-script' };
    const { registry, events } = await setup([
      { ...dev(1), access: access(1, { mode: 'ro-shared', owner, you: 'reader' }) },
      { ...dev(2), access: access(2) },
    ]);
    expect(registry.lockedByOther(1)).toBe(true);
    expect(registry.lockedByOther(2)).toBe(false);
    expect(registry.access(1)?.viewers).toBe(0);
    expect(registry.streamState(1)).toBeNull();

    events.deviceStates.set(
      new Map([
        [
          1,
          {
            device: 1,
            connected: true,
            access: { mode: 'ro-shared', owner, members: [owner] },
            stream: { viewers: 2, pixel_format: 'Mono8', bit_depth: 8 },
            burst: null,
          },
        ],
      ]),
    );
    expect(registry.access(1)?.viewers).toBe(2);
    expect(registry.access(1)?.holder?.kind).toBe('live');
    expect(registry.streamState(1)?.viewers).toBe(2);
  });

  it('reads the list again when another client changes a device', async () => {
    const { registry, http, events } = await setup([{ ...dev(1), access: access(1) }]);
    const changed = {
      seq: 3,
      time: '',
      type: 'device_state' as const,
      device: 1,
      connected: true,
      access: { mode: 'exclusive' as const, owner: { client_id: 'aa11bb22', name: null }, members: [] },
      stream: null,
      burst: null,
      cause: 'access' as const,
      reason: null,
      by: null,
    };
    events.events$.next(changed);
    events.events$.next({ ...changed, seq: 4 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    // One re-read for the burst of events.
    http.expectOne(CONNECTED_URL).flush([
      { ...dev(1), access: access(1, { mode: 'exclusive', owner: changed.access.owner, you: 'meta' }) },
    ]);
    expect(registry.lockedByOther(1)).toBe(true);

    // A stream starting changes no access: no re-read.
    events.events$.next({ ...changed, seq: 5, cause: 'stream' });
    await new Promise((resolve) => setTimeout(resolve, 150));
    http.expectNone(CONNECTED_URL);
  });
});

import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type DeviceAccess, DeviceRegistryService, SessionService } from 'ng-racs-core';
import { DeviceAccessComponent } from './device-access.component';

const CONNECTED_URL = '/api/v1/devices/connected';
const ACCESS_URL = '/api/v1/devices/0/access';
const me = { client_id: '3f2a9c1e', name: 'webapp · Firefox' };
const script = { client_id: '77d0aa12', name: 'line-script' };
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function access(over: Partial<DeviceAccess> = {}): DeviceAccess {
  return { device: 0, mode: 'shared', owner: null, members: [me], holder: null, viewers: 0, you: 'writer', ...over };
}

const device = (a: DeviceAccess) => ({
  id: 0,
  dev_id: 'd0',
  serial_number: 'SN0',
  vendor: 'Fake',
  model: 'Cam',
  manufacturer_info: '',
  ip: '10.0.0.1',
  mac: '00:00:00:00:00:00',
  access: a,
});

async function render(a: DeviceAccess) {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  TestBed.inject(SessionService).clientId.set(me.client_id);
  TestBed.inject(DeviceRegistryService);
  const http = TestBed.inject(HttpTestingController);
  TestBed.tick();
  await settle();
  http.expectOne(CONNECTED_URL).flush([device(a)]);
  const fixture = TestBed.createComponent(DeviceAccessComponent);
  fixture.componentRef.setInput('deviceId', 0);
  fixture.detectChanges();
  const el: HTMLElement = fixture.nativeElement;
  const text = () => el.textContent!.replace(/\s+/g, ' ').trim();
  const button = (label: RegExp) => [...el.querySelectorAll('button')].find((b) => label.test(b.textContent!))!;
  const click = (label: RegExp) => {
    button(label).click();
    fixture.detectChanges();
  };
  return { fixture, http, text, button, click };
}

describe('DeviceAccessComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('shows a shared device and takes control of it', async () => {
    const { http, text, click, fixture } = await render(access({ members: [me, script], viewers: 1 }));
    expect(text()).toContain('shared');
    expect(text()).toContain('2 members · 1 viewer');
    expect(text()).not.toContain('held by');

    click(/Take control/);
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === ACCESS_URL);
    expect(put.request.body).toEqual({ mode: 'ro-shared', force: false });
    put.flush(access({ mode: 'ro-shared', owner: me, you: 'owner' }));
    http.expectOne(CONNECTED_URL).flush([device(access({ mode: 'ro-shared', owner: me, you: 'owner' }))]);
    fixture.detectChanges();
    expect(text()).toContain('held by you');
    expect(text()).toContain('Release');
  });

  it('offers to force going exclusive when others use the device, after a second click', async () => {
    const { http, text, click, fixture } = await render(access({ members: [me, script] }));
    const select = fixture.nativeElement.querySelector('select') as HTMLSelectElement;
    select.value = 'exclusive';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    click(/Take control/);
    http
      .expectOne(ACCESS_URL)
      .flush(
        { error: 'device_in_use', mode: 'shared', owner: null, members: [script], holder: null },
        { status: 409, statusText: 'Conflict' },
      );
    fixture.detectChanges();
    expect(text()).toContain('in use by line-script');

    click(/^\s*Force\s*$/);
    expect(text()).toContain('Confirm force');
    http.expectNone(ACCESS_URL);
    click(/Confirm force/);
    const forced = http.expectOne(ACCESS_URL);
    expect(forced.request.body).toEqual({ mode: 'exclusive', force: true });
    forced.flush(access({ mode: 'exclusive', owner: me, you: 'owner' }));
    http.expectOne(CONNECTED_URL).flush([device(access({ mode: 'exclusive', owner: me, you: 'owner' }))]);
  });

  it('lets the owner release its lease', async () => {
    const { http, click } = await render(access({ mode: 'ro-shared', owner: me, you: 'owner' }));
    click(/Release/);
    const del = http.expectOne((r) => r.method === 'DELETE' && r.url === ACCESS_URL);
    expect(del.request.params.has('force')).toBe(false);
    del.flush(access());
    http.expectOne(CONNECTED_URL).flush([device(access())]);
  });

  it('shows a reader who holds the device, and breaks the lease only when confirmed', async () => {
    const { http, text, click } = await render(
      access({ mode: 'ro-shared', owner: script, members: [script, me], you: 'reader' }),
    );
    expect(text()).toContain('ro-shared');
    expect(text()).toContain('held by line-script · 77d0aa12');
    expect(text()).not.toContain('Take control');

    click(/Force release/);
    http.expectNone(ACCESS_URL);
    click(/Confirm force/);
    const del = http.expectOne((r) => r.method === 'DELETE' && r.url === ACCESS_URL);
    expect(del.request.params.get('force')).toBe('true');
    del.flush(access());
    http.expectOne(CONNECTED_URL).flush([device(access())]);
  });

  it('shows a device locked by another client', async () => {
    const { text } = await render(access({ mode: 'exclusive', owner: script, members: [script], you: 'meta' }));
    expect(text()).toContain('exclusive');
    expect(text()).toContain('held by line-script');
    expect(text()).toContain('Force release');
  });
});

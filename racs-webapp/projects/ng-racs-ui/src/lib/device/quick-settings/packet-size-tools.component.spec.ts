import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import {
  DeviceSelectionService,
  type FeatureState,
  type GenICamNodeCategory,
  GenicamSession,
  type PacketSizeInfo,
} from 'ng-racs-core';
import { PacketSizeToolsComponent } from './packet-size-tools.component';

const CATEGORIES: GenICamNodeCategory[] = [
  {
    name: 'TransportLayerControl',
    display_name: 'Transport',
    nodes: [
      {
        name: 'GevSCPSPacketSize',
        display_name: 'Packet Size',
        node_type: 'Integer',
        visibility: 'Expert',
        access_mode: 'ReadWrite',
        enums: null,
        selected: [],
      },
    ],
  },
];

/** The AT C6 on a jumbo-frame link. */
const INFO: PacketSizeInfo = {
  packet_size: 1500,
  min: 88,
  max: 7960,
  inc: 4,
  link_mtu: 9000,
  interface: 'enp9s0f0',
  local_ip: '169.254.1.1',
};

function packetSize(value: string): FeatureState {
  return {
    name: 'GevSCPSPacketSize',
    node_type: 'Integer',
    value,
    available: true,
    locked: false,
    min: 86,
    max: 7960,
    inc: 4,
    unit: null,
    representation: null,
    available_entries: null,
    error: null,
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function render(info: PacketSizeInfo, value = '1500') {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), GenicamSession],
  });
  TestBed.inject(DeviceSelectionService).setSelectedDeviceId(0);
  const session = TestBed.inject(GenicamSession);
  const http = TestBed.inject(HttpTestingController);
  TestBed.tick();
  http.expectOne('/api/v1/devices/0/gc/categories').flush(CATEGORIES);
  session.states.set({ GevSCPSPacketSize: packetSize(value) });

  const fixture = TestBed.createComponent(PacketSizeToolsComponent);
  fixture.componentRef.setInput('info', info);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement, http };
}

describe('PacketSizeToolsComponent', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('shows the link the camera is reached over', () => {
    const { el } = render(INFO);
    const hint = el.querySelector('span')!;
    expect(hint.textContent!.trim()).toBe('link mtu 9000 · enp9s0f0');
    expect(hint.classList).toContain('text-faint');
  });

  it('warns when the packet size cannot arrive over the link', () => {
    const { el } = render({ ...INFO, link_mtu: 1500, interface: 'eth0' }, '7960');
    const hint = el.querySelector('span')!;
    expect(hint.textContent!.trim()).toBe('exceeds link mtu 1500 · eth0');
    expect(hint.classList).toContain('text-warn');
  });

  it('runs Auto on the server and reports what it found', async () => {
    const { fixture, el, http } = render(INFO);
    el.querySelector('button')!.click();
    fixture.detectChanges();
    expect(el.querySelector('button')!.getAttribute('aria-busy')).toBe('true');

    await settle();
    http
      .expectOne({ method: 'POST', url: '/api/v1/devices/0/stream/packet-size/auto' })
      .flush({ packet_size: 7960, previous: 1500, test_packets: true, link_mtu: 9000, interface: 'enp9s0f0' });
    await settle();
    // Re-read afterwards, like after a write.
    http.expectOne('/api/v1/devices/0/gc/features/state').flush([packetSize('7960')]);
    fixture.detectChanges();

    expect(el.textContent).toContain('auto · 7960 (was 1500)');
    expect(el.querySelector('button')!.getAttribute('aria-busy')).toBe('false');
  });
});

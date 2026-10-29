import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  type CloudScaling,
  composeMetric,
  fitLinearScaling,
  GenicamSession,
  LaserlineLinkService,
  type Mat3,
  metricDomain,
  type MetricMapping,
  metricScaling,
  RacsService,
  type RangeCalibration,
  RangeCalibrationService,
  type RemoteStatus,
} from 'ng-racs-core';
import { MetricScalingComponent } from './metric-scaling.component';

/** A horizontal line through (600, 400), 10 px per mm along it and 8 px per mm of height (up). */
function metric(over: Partial<MetricMapping> = {}): MetricMapping {
  return {
    rev: 1,
    base: { center_px: [600, 400], dir: [1, 0], normal: [0, 1] },
    along_px_per_mm: 10,
    height_px_per_mm: -8,
    u0_mm: 0,
    dv_mm: 0.1,
    rows: 200,
    travel: { mode: 'per_second', rows_per_s: 100, mm_per_s: 10, approximate: false, playing: true, end: 'loop' },
    object_mm: null,
    model_mirrored: false,
    disturbances: [],
    ...over,
  };
}

/** Columns 0..399 across x 100..1100, values 100..2000 across y 380..420 (affine). */
const G: Mat3 = [2.5, 0, 100, 0, 40 / 1900, 380 - (40 * 100) / 1900, 0, 0, 1];

function calibration(over: Partial<RangeCalibration> = {}): RangeCalibration {
  return {
    v: 1,
    g: G,
    model: 'affine',
    viewPx: [1200, 800],
    camera: {},
    rms: 0.05,
    max: 0.2,
    lines: [
      { kind: 'parallel', at: 0, sign: 0, columns: 400, n: 400, dropped: 0, rms: 0.04, max: 0.1 },
      { kind: 'crossing', at: 0, sign: 1, columns: 16, n: 16, dropped: 0, rms: 0.05, max: 0.2 },
    ],
    columns: [0, 399],
    values: [100, 2000],
    band: [-20, 20],
    base: metric().base,
    at: 1,
    ...over,
  };
}

class FakeCalib {
  readonly phase = signal<'idle' | 'running' | 'done' | 'failed'>('idle');
  readonly task = signal<'calibrate' | 'verify'>('calibrate');
  readonly stepText = signal('');
  readonly progress = signal(0);
  readonly error = signal<string | null>(null);
  readonly warnings = signal<string[]>([]);
  readonly blocked = signal<string | null>(null);
  readonly result = signal<RangeCalibration | null>(null);
  readonly report = signal(null);
  readonly staleReason = signal<string | null>(null);
  readonly stale = computed(() => this.staleReason() !== null);
  calibrate = vi.fn();
  verify = vi.fn();
  cancel = vi.fn();
  forget = vi.fn();
}

class FakeLink {
  readonly supported = true;
  readonly host = signal<string | null>('ll');
  readonly status = signal<RemoteStatus | null>({ viewPx: [1200, 800], envelope: null, session: null, field: null, metric: metric() });
  readonly metric = computed(() => this.status()?.metric);
  hello = vi.fn(async () => this.host());
}

class FakeSession {
  readonly nodes = signal(new Map<string, unknown>());
  readonly states = signal({});
  readonly holder = signal(null);
  readonly role = signal('control');
  watch = vi.fn();
  unwatch = vi.fn();
}

const PX: CloudScaling = { unit: 'px', xPitch: 1, ySpacing: 1, zScale: 1, zOffset: 0 };

function setup(scaling: CloudScaling = PX) {
  const calib = new FakeCalib();
  const link = new FakeLink();
  TestBed.configureTestingModule({
    imports: [MetricScalingComponent],
    providers: [
      { provide: RangeCalibrationService, useValue: calib },
      { provide: LaserlineLinkService, useValue: link },
      { provide: GenicamSession, useValue: new FakeSession() },
      { provide: RacsService, useValue: {} },
    ],
  });
  const fixture = TestBed.createComponent(MetricScalingComponent);
  const emitted: CloudScaling[] = [];
  // The parent applies what the section emits.
  fixture.componentInstance.scalingChange.subscribe((s) => {
    emitted.push(s);
    fixture.componentRef.setInput('scaling', s);
  });
  fixture.componentRef.setInput('scaling', scaling);
  fixture.componentRef.setInput('liveRate', 1000);
  fixture.detectChanges();
  const el: HTMLElement = fixture.nativeElement;
  const button = (label: string) => [...el.querySelectorAll('button')].find((b) => b.textContent!.trim() === label)!;
  const states = () => [...el.querySelectorAll('[data-state]')].map((e) => e.getAttribute('data-state'));
  return { fixture, el, calib, link, emitted, button, states };
}

/** The scaling the live follow derives from `m` and the calibration at `rate` profiles/s. */
function derived(m: MetricMapping, rate = 1000): CloudScaling {
  const cal = calibration();
  const fit = fitLinearScaling(metricDomain(cal, m.base, null), composeMetric(cal.g, m))!;
  return metricScaling(fit, m.travel.mm_per_s / rate);
}

describe('MetricScalingComponent', () => {
  afterEach(() => vi.useRealTimers());

  it('switches the source', () => {
    const { el, emitted, button, fixture } = setup();
    // No camera scaling: no *From camera*.
    expect([...el.querySelectorAll('[role=radio]')].map((b) => b.textContent!.trim())).toEqual(['Manual', 'Laserline']);
    expect(button('Manual').getAttribute('aria-checked')).toBe('true');

    button('Laserline').click();
    fixture.detectChanges();
    expect(emitted.at(-1)!.source).toBe('laserline');
    expect(button('Laserline').getAttribute('aria-checked')).toBe('true');
    expect(el.textContent).toContain('Calibrate');

    button('Manual').click();
    fixture.detectChanges();
    expect(emitted.at(-1)!.source).toBe('manual');
    expect(el.textContent).not.toContain('Calibrate');
  });

  it('shows the states from the calibration service and laserline', () => {
    const { calib, link, states, fixture } = setup({ ...PX, source: 'laserline' });
    expect(states()).toEqual(['uncalibrated']);

    calib.result.set(calibration());
    fixture.detectChanges();
    expect(states()).toEqual(['live']);

    calib.staleReason.set('OffsetY changed (300 → 310)');
    link.status.update((s) => ({ ...s!, metric: metric({ disturbances: ['motion'], travel: { ...metric().travel, mode: 'per_frame', approximate: true } }) }));
    fixture.detectChanges();
    expect(states()).toEqual(['live', 'stale', 'y', 'disturbances']);

    // The envelope reaches 30 px below the line, the camera sees 20.
    link.status.update((s) => ({
      ...s!,
      envelope: { corners: [[300, 390], [900, 390], [900, 430], [300, 430]], center_px: [600, 410], dir: [1, 0], normal: [0, 1], along_px: [-300, 300], across_px: [-20, 20] },
    }));
    fixture.detectChanges();
    expect(states()).toContain('band');

    link.host.set(null);
    link.status.set(null);
    fixture.detectChanges();
    expect(states()[0]).toBe('offline');
  });

  it('shows the run while calibrating, with Cancel', () => {
    const { calib, el, button, fixture } = setup({ ...PX, source: 'laserline' });
    calib.phase.set('running');
    calib.stepText.set('band +8 px');
    calib.progress.set(0.3);
    fixture.detectChanges();
    expect(el.querySelector('[role=status]')!.textContent).toContain('calibrating · band +8 px');
    expect(el.querySelector('.animate-pulse')).not.toBeNull();
    button('Cancel').click();
    expect(calib.cancel).toHaveBeenCalled();
  });

  it('switches to Manual on an edit', () => {
    const m = metric();
    const { el, emitted, calib, fixture } = setup({ ...derived(m) });
    calib.result.set(calibration());
    fixture.detectChanges();
    const pitch = el.querySelectorAll('input[type=number]')[0] as HTMLInputElement;
    pitch.value = '0.5';
    pitch.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(emitted.at(-1)).toEqual({ ...derived(m), xPitch: 0.5, source: 'manual' });
    // Manual now: laserline's changes no longer apply.
    const count = emitted.length;
    (TestBed.inject(LaserlineLinkService) as unknown as FakeLink).status.update((s) => ({ ...s!, metric: metric({ rev: 2, along_px_per_mm: 12 }) }));
    fixture.detectChanges();
    expect(emitted.length).toBe(count);
  });

  it('follows laserline only above 0.2 %', () => {
    const m = metric();
    const { emitted, calib, link, fixture } = setup(derived(m));
    calib.result.set(calibration());
    fixture.detectChanges();
    expect(emitted).toEqual([]);

    // 0.1 % finer along the line: x moves by 0.1 %.
    link.status.update((s) => ({ ...s!, metric: metric({ rev: 2, along_px_per_mm: 10.01 }) }));
    fixture.detectChanges();
    expect(emitted).toEqual([]);
    fixture.componentRef.setInput('liveRate', 1001);
    fixture.detectChanges();
    expect(emitted).toEqual([]);

    // 1 %: applied.
    link.status.update((s) => ({ ...s!, metric: metric({ rev: 3, along_px_per_mm: 10.1 }) }));
    fixture.detectChanges();
    expect(emitted).toHaveLength(1);
    expect(emitted[0].xPitch).toBeCloseTo(derived(metric({ along_px_per_mm: 10.1 }), 1001).xPitch, 12);
    fixture.componentRef.setInput('liveRate', 1010);
    fixture.detectChanges();
    expect(emitted).toHaveLength(2);
    expect(emitted[1].ySpacing).toBeCloseTo(10 / 1010, 12);
  });

  it('follows y only above 5 % in per-frame playback', () => {
    const perFrame = metric({ travel: { ...metric().travel, mode: 'per_frame', approximate: true } });
    const { emitted, calib, link, fixture } = setup(derived(perFrame));
    link.status.update((s) => ({ ...s!, metric: perFrame }));
    calib.result.set(calibration());
    fixture.detectChanges();
    expect(emitted).toEqual([]);
    fixture.componentRef.setInput('liveRate', 1040);
    fixture.detectChanges();
    expect(emitted).toEqual([]);
    fixture.componentRef.setInput('liveRate', 1060);
    fixture.detectChanges();
    expect(emitted).toHaveLength(1);
  });

  it('keeps the last mapping while laserline is offline', () => {
    const m = metric();
    const { emitted, calib, link, fixture } = setup(derived(m));
    calib.result.set(calibration());
    link.host.set(null);
    link.status.set(null);
    fixture.detectChanges();
    expect(emitted).toEqual([]);
    expect(fixture.componentInstance.plyComments()).toContain('laserline offline: the last mapping applied');
  });

  it('asks laserline to report while the source is Laserline', () => {
    vi.useFakeTimers();
    const { link, fixture, button } = setup({ ...PX, source: 'laserline' });
    expect(link.hello).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3_000);
    expect(link.hello).toHaveBeenCalledTimes(2);
    button('Manual').click();
    fixture.detectChanges();
    vi.advanceTimersByTime(9_000);
    expect(link.hello).toHaveBeenCalledTimes(2);
  });
});

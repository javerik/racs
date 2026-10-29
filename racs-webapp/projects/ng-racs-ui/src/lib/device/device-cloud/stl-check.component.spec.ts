import { TestBed } from '@angular/core/testing';
import { type CloudScaling, type MetricMapping, ringLayout, RowRing } from 'ng-racs-core';
import { StlCheckComponent } from './stl-check.component';

const MM: CloudScaling = { unit: 'mm', xPitch: 0.5, ySpacing: 0.5, zScale: 0.01, zOffset: 0, mirrorX: true, source: 'laserline' };

/** A 15 mm box, 80 × 60 mm, in a scan of 200 rows of 0.5 mm at 10 mm/s. */
function metric(over: Partial<MetricMapping> = {}): MetricMapping {
  return {
    rev: 1,
    base: { center_px: [600, 400], dir: [1, 0], normal: [0, 1] },
    along_px_per_mm: 10,
    height_px_per_mm: -8,
    u0_mm: 0,
    dv_mm: 0.5,
    rows: 200,
    travel: { mode: 'per_second', rows_per_s: 20, mm_per_s: 10, approximate: false, playing: true, end: 'loop' },
    object_mm: { min: [-40, 20, 15], max: [40, 80, 15] },
    model_mirrored: false,
    disturbances: [],
    ...over,
  };
}

/** A snapshot of the box (value 1500 = 15 mm) on a base (value 1), its rows from `first` on. */
function snapshot(first = 40): RowRing {
  const width = 200;
  const rows = 200;
  const ring = new RowRing(ringLayout(width, rows, 4096, 256), 'stacked', rows);
  for (let k = 0; k < rows; k++) {
    const row = new Uint16Array(width).fill(1);
    if (k >= first && k <= first + 120) {
      row.fill(1500, 20, 181);
    }
    ring.writeStacked(k, 1, 1, row);
  }
  return ring;
}

function setup(m: MetricMapping | null = metric(), rate: number | null = 100) {
  TestBed.configureTestingModule({ imports: [StlCheckComponent] });
  const fixture = TestBed.createComponent(StlCheckComponent);
  fixture.componentRef.setInput('scaling', MM);
  fixture.componentRef.setInput('metric', m);
  fixture.componentRef.setInput('rate', rate);
  fixture.componentRef.setInput('height', 10);
  const captured: number[] = [];
  fixture.componentInstance.capture.subscribe((n) => captured.push(n));
  fixture.detectChanges();
  const el: HTMLElement = fixture.nativeElement;
  const button = () => [...el.querySelectorAll('button')].find((b) => b.textContent!.trim() === 'Check against STL');
  return { fixture, el, captured, button };
}

describe('StlCheckComponent', () => {
  it('proposes one pass and the object, and asks for that snapshot', () => {
    const { el, captured, button } = setup();
    // (100 mm + 60 mm) ÷ 10 mm/s × 1.2 = 19.2 s at 10 fps.
    expect(el.textContent).toContain('19.2 s · 192 frames at 10.0 fps');
    button()!.click();
    expect(captured).toEqual([192]);
  });

  it('says why it can’t check', () => {
    const noRate = setup(metric(), null);
    expect(noRate.button()!.disabled).toBe(true);
    expect(noRate.el.textContent).toContain('profile rate unknown');
    TestBed.resetTestingModule();

    const bounce = setup(metric({ travel: { ...metric().travel, end: 'bounce' }, disturbances: ['bounce'] }));
    expect(bounce.button()!.disabled).toBe(true);
    expect(bounce.el.textContent).toContain('bounce');
    TestBed.resetTestingModule();

    const { fixture, el, button } = setup();
    fixture.componentRef.setInput('captureBlocked', 'a snapshot is being captured');
    fixture.detectChanges();
    expect(button()!.disabled).toBe(true);
    expect(el.textContent).toContain('a snapshot is being captured');
  });

  it('shows capturing while its snapshot runs', () => {
    const { fixture, el, button } = setup();
    fixture.componentRef.setInput('checking', true);
    fixture.detectChanges();
    expect(button()).toBeUndefined();
    expect(el.textContent).toContain('capturing one pass');
  });

  it('compares the finished snapshot per axis', () => {
    const { fixture, el } = setup();
    fixture.componentRef.setInput('cloud', { ring: snapshot(), storeStride: 1 });
    fixture.detectChanges();
    const rows = [...el.querySelectorAll('tr[data-axis]')];
    expect(rows.map((r) => r.getAttribute('data-axis'))).toEqual(['u', 'v', 'z']);
    // 160 columns of 0.5 mm, centre to centre: 80 mm; 120 rows: 60 mm; 15 mm high.
    expect(rows.map((r) => r.querySelectorAll('td')[3].textContent!.trim())).toEqual(['0.0 %', '0.0 %', '0.0 %']);
    expect(el.querySelectorAll('tr[data-axis] .bg-ok').length).toBe(3);
    expect(el.querySelector('[data-check="checked"]')!.textContent).toContain('within 2 %');

    // The next capture clears it.
    fixture.componentRef.setInput('cloud', null);
    fixture.detectChanges();
    expect(el.querySelector('[data-check]')).toBeNull();
  });

  it('marks an axis that is off', () => {
    const { fixture, el } = setup();
    fixture.componentRef.setInput('scaling', { ...MM, ySpacing: 0.53 });
    fixture.componentRef.setInput('cloud', { ring: snapshot(), storeStride: 1 });
    fixture.detectChanges();
    const v = el.querySelector('tr[data-axis="v"]')!;
    expect(v.querySelector('.bg-err')).not.toBeNull();
    expect(v.textContent).toContain('+6.0 %');
    expect(el.querySelector('[data-check="checked"]')!.textContent).toContain('off by more than 2 %');
  });

  it('names a refusal', () => {
    const { fixture, el } = setup();
    fixture.componentRef.setInput('cloud', { ring: snapshot(0), storeStride: 1 });
    fixture.detectChanges();
    expect(el.querySelector('[data-check="refused"]')!.textContent).toContain('first or last profile');
    expect(el.querySelector('tr[data-axis]')).toBeNull();
  });

  it('checks with the requested mapping when laserline is gone by the end', () => {
    const { fixture, el, button } = setup();
    button()!.click();
    fixture.componentRef.setInput('metric', undefined);
    fixture.componentRef.setInput('cloud', { ring: snapshot(), storeStride: 1 });
    fixture.detectChanges();
    expect(el.querySelector('[data-check="checked"]')).not.toBeNull();
  });
});

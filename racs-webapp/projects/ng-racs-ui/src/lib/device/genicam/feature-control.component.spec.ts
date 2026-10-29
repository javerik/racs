import { TestBed } from '@angular/core/testing';
import type { FeatureState, GenICamNodeInfo } from 'ng-racs-core';
import { FeatureControlComponent } from './feature-control.component';

const EXPOSURE: GenICamNodeInfo = {
  name: 'ExposureTime',
  display_name: 'Exposure Time',
  node_type: 'Float',
  visibility: 'Beginner',
  access_mode: 'ReadWrite',
  enums: null,
  selected: [],
};

/** The AT C6's ExposureTime as `POST /gc/features/state` reports it. */
function exposureState(value: string): FeatureState {
  return {
    name: 'ExposureTime',
    node_type: 'Float',
    value,
    available: true,
    locked: false,
    min: 0.01,
    max: 1_000_000,
    inc: 0.01,
    unit: 'us',
    representation: 'Linear',
    available_entries: null,
    error: null,
  };
}

function render(layout: 'wide' | 'inline', value = '60000') {
  const fixture = TestBed.createComponent(FeatureControlComponent);
  fixture.componentRef.setInput('node', EXPOSURE);
  fixture.componentRef.setInput('state', exposureState(value));
  fixture.componentRef.setInput('layout', layout);
  fixture.detectChanges();
  const commits: string[] = [];
  fixture.componentInstance.commit.subscribe((v) => commits.push(v));
  return { fixture, el: fixture.nativeElement as HTMLElement, commits };
}

describe('FeatureControlComponent, wide-range number', () => {
  it('shows the value readably with a chip per decade, the current one active', () => {
    const { el } = render('wide');
    expect(el.textContent).toContain('60 ms');
    const chips = [...el.querySelectorAll('[role=radio]')];
    expect(chips.map((c) => c.textContent!.trim())).toEqual([
      '≤ 10 µs',
      '10–100 µs',
      '0.1–1 ms',
      '1–10 ms',
      '10–100 ms',
      '0.1–1 s',
    ]);
    expect(chips[4].getAttribute('aria-checked')).toBe('true');
  });

  it('slides linearly within the decade and writes only on release', () => {
    const { el, fixture, commits } = render('wide');
    const slider = el.querySelector<HTMLInputElement>('input[type=range]')!;
    slider.value = '500';
    slider.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(commits).toEqual([]);
    expect(el.textContent).toContain('55 ms');
    slider.dispatchEvent(new Event('change'));
    expect(commits).toEqual(['55000']);
  });

  it('a chip moves a value outside its decade to the nearest edge', () => {
    const { el, commits } = render('wide');
    el.querySelectorAll<HTMLButtonElement>('[role=radio]')[2].click();
    expect(commits).toEqual(['1000']);
  });

  it('halves and doubles', () => {
    const { el, commits } = render('inline');
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('button')];
    buttons.find((b) => b.textContent!.includes('½'))!.click();
    expect(commits).toEqual(['30000']);
    expect(el.querySelector('input[type=range]')).toBeNull();
    expect(el.querySelector('[role=radio]')).toBeNull();
  });
});

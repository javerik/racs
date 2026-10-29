import { Component, input } from '@angular/core';

export type IconName =
  | 'discover'
  | 'connect'
  | 'disconnect'
  | 'minimize'
  | 'restore'
  | 'rotate-cw'
  | 'rotate-ccw'
  | 'zoom-in'
  | 'zoom-out'
  | 'fullscreen'
  | 'fullscreen-exit'
  | 'menu'
  | 'close'
  | 'camera'
  | 'chevron-up'
  | 'chevron-down'
  | 'region'
  | 'roi-rect'
  | 'roi-line'
  | 'trash'
  | 'sidebar-collapse'
  | 'sidebar-expand'
  | 'laser'
  | 'external'
  | 'lock'
  | 'measure';

/**
 * Line icons drawn in the text colour, 16 px grid, for buttons too small for a label. A button
 * using one carries the words in `aria-label` and `title`.
 */
@Component({
  selector: 'racs-icon',
  standalone: true,
  template: `
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true" class="block h-full w-full">
      @switch (name()) {
      @case ('laser') {
      <!-- An emitter fanning a line onto a surface: a laser line projector. -->
      <rect x="6" y="1.5" width="4" height="3" rx="0.5" />
      <path d="M8 4.5 3 12.5M8 4.5l5 8M2 12.5h12" />
      }
      @case ('lock') {
      <!-- A padlock: another client holds the device's lease. -->
      <rect x="3.5" y="7" width="9" height="6.5" rx="0.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2M8 9.75v1.5" />
      }
      @case ('external') {
      <!-- A box with an arrow leaving it: opens in a new window. -->
      <path d="M7 3H3.5v9.5H13V9M9.5 2.5h4v4M13.5 2.5 7.5 8.5" />
      }
      @case ('discover') {
      <!-- A broadcast: discovery is a GVCP broadcast that cameras answer. -->
      <circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none" />
      <path d="M5.2 5.2a4 4 0 0 0 0 5.6M10.8 5.2a4 4 0 0 1 0 5.6" />
      <path d="M3.1 3.1a7 7 0 0 0 0 9.8M12.9 3.1a7 7 0 0 1 0 9.8" />
      }
      @case ('connect') {
      <!-- A plug. -->
      <path d="M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0V5ZM8 11v3" />
      }
      @case ('disconnect') {
      <!-- The plug, struck through. -->
      <path d="M6 2v3M10 2v3M11.5 5v2.5a3.5 3.5 0 0 1-5.6 2.8M4.5 7.5V5h4M8 11v3M2.5 2.5l11 11" />
      }
      @case ('minimize') {
      <path d="M3.5 12.5h9" />
      }
      @case ('restore') {
      <rect x="3" y="3" width="10" height="10" rx="0.5" />
      <path d="M3 5.5h10" />
      }
      @case ('rotate-cw') {
      <path d="M12.5 7.5A4.5 4.5 0 1 1 8 3h1.5" />
      <path d="M8 1.2 10 3 8 4.8" />
      }
      @case ('rotate-ccw') {
      <path d="M3.5 7.5A4.5 4.5 0 1 0 8 3H6.5" />
      <path d="M8 1.2 6 3 8 4.8" />
      }
      @case ('zoom-in') {
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.3 10.3 14 14M5 7h4M7 5v4" />
      }
      @case ('zoom-out') {
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.3 10.3 14 14M5 7h4" />
      }
      @case ('fullscreen') {
      <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />
      }
      @case ('fullscreen-exit') {
      <path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5" />
      }
      @case ('menu') {
      <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
      }
      @case ('close') {
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
      }
      @case ('chevron-up') {
      <path d="M4 10l4-4 4 4" />
      }
      @case ('chevron-down') {
      <path d="M4 6l4 4 4-4" />
      }
      @case ('sidebar-collapse') {
      <!-- A window with its side panel ruled off, and a chevron folding it away. -->
      <rect x="2.5" y="3" width="11" height="10" rx="0.5" />
      <path d="M6 3v10M10.5 6.5L9 8l1.5 1.5" />
      }
      @case ('sidebar-expand') {
      <rect x="2.5" y="3" width="11" height="10" rx="0.5" />
      <path d="M6 3v10M9 6.5L10.5 8 9 9.5" />
      }
      @case ('region') {
      <!-- Crop marks around the sensor area kept: the camera's region. -->
      <path d="M4.5 1.5v10h10M1.5 4.5h10v10" />
      }
      @case ('roi-rect') {
      <!-- A rectangle with corner handles: a soft rectangular ROI. -->
      <rect x="3.5" y="4.5" width="9" height="7" stroke-dasharray="2 1.6" />
      <rect x="2.5" y="3.5" width="2" height="2" fill="currentColor" stroke="none" />
      <rect x="11.5" y="10.5" width="2" height="2" fill="currentColor" stroke="none" />
      }
      @case ('measure') {
      <!-- A ruler laid across, with its ticks: the 3D view's measuring tool. -->
      <path d="M1.8 11.2 11.2 1.8l3 3-9.4 9.4z" />
      <path d="M4.6 8.4 6 9.8M6.9 6.1l2 2M9.2 3.8 10.6 5.2" />
      }
      @case ('roi-line') {
      <!-- A line between two end points: a profile ROI. -->
      <path d="M4 12 12 4" />
      <circle cx="3.5" cy="12.5" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12.5" cy="3.5" r="1.3" fill="currentColor" stroke="none" />
      }
      @case ('trash') {
      <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M7 7v4M9 7v4" />
      }
      @case ('camera') {
      <!-- A machine-vision camera body with its lens. -->
      <rect x="2" y="4.5" width="9" height="7" rx="0.5" />
      <path d="M11 6.5 14 5v6l-3-1.5" />
      <circle cx="6.5" cy="8" r="1.6" />
      }
      }
    </svg>
  `,
  styles: `
    :host {
      display: inline-block;
      width: 0.875rem;
      height: 0.875rem;
      flex-shrink: 0;
    }
  `,
})
export class IconComponent {
  readonly name = input.required<IconName>();
}

import { Component, inject } from '@angular/core';
import { LayoutService, type LayoutPreference } from '../services/layout.service';

/** Auto / Desktop / Mobile: overrides the detected layout. */
@Component({
  selector: 'racs-layout-switch',
  standalone: true,
  template: `
    <div class="flex flex-col gap-1">
      <div class="inline-flex" role="radiogroup" aria-label="Layout">
        @for (o of options; track o.id; let first = $first) {
        <button type="button" role="radio" class="btn flex-1 rounded-none px-2" [class.-ml-px]="!first"
          [attr.aria-checked]="layout.preference() === o.id"
          [class.!border-accent]="layout.preference() === o.id" [class.!text-fg]="layout.preference() === o.id"
          [class.text-muted]="layout.preference() !== o.id" [attr.title]="o.hint"
          (click)="layout.setPreference(o.id)">
          {{ o.label }}
        </button>
        }
      </div>
      @if (layout.preference() === 'auto') {
      <span class="font-mono text-2xs text-faint">auto · {{ layout.detected() }} detected</span>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
  `,
})
export class LayoutSwitchComponent {
  readonly layout = inject(LayoutService);

  readonly options: { id: LayoutPreference; label: string; hint: string }[] = [
    { id: 'auto', label: 'Auto', hint: 'Pick the layout from the screen and input' },
    { id: 'desktop', label: 'Desktop', hint: 'Sidebar layout for mouse and large screens' },
    { id: 'mobile', label: 'Mobile', hint: 'Touch layout with a bottom tab bar' },
  ];
}

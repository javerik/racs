import { Component, inject } from '@angular/core';
import { ThemeService, type ThemePreference } from '../services/theme.service';

/** Auto / Dark / Tech light / Light: the colour theme, Auto following the OS. */
@Component({
  selector: 'racs-theme-switch',
  standalone: true,
  template: `
    <div class="flex flex-col gap-1">
      <div class="flex" role="radiogroup" aria-label="Theme">
        @for (o of options; track o.id; let first = $first) {
        <button type="button" role="radio" class="btn min-w-0 flex-1 rounded-none px-1" [class.-ml-px]="!first"
          [attr.aria-checked]="theme.preference() === o.id"
          [class.!border-accent]="theme.preference() === o.id" [class.!text-fg]="theme.preference() === o.id"
          [class.text-muted]="theme.preference() !== o.id" [attr.title]="o.hint"
          (click)="theme.setPreference(o.id)">
          {{ o.label }}
        </button>
        }
      </div>
      @if (theme.preference() === 'auto') {
      <span class="font-mono text-2xs text-faint">auto · {{ theme.detected() }} from the system</span>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
  `,
})
export class ThemeSwitchComponent {
  readonly theme = inject(ThemeService);

  readonly options: { id: ThemePreference; label: string; hint: string }[] = [
    { id: 'auto', label: 'Auto', hint: 'Technical dark or light, following the system' },
    { id: 'technical-dark', label: 'Dark', hint: 'Technical dark: the instrument panel' },
    { id: 'technical-light', label: 'Tech', hint: 'Technical light: the instrument panel on light grey' },
    { id: 'light', label: 'Light', hint: 'Light: warm paper tones and a softer style' },
  ];
}

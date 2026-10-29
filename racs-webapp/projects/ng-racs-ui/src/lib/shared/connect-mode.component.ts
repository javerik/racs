import { booleanAttribute, Component, inject, input } from '@angular/core';
import { type AccessMode, DeviceRegistryService } from 'ng-racs-core';

const MODES: { id: AccessMode; title: string }[] = [
  { id: 'shared', title: 'shared · every client reads and writes' },
  { id: 'ro-shared', title: 'ro-shared · you write, the other clients read and watch' },
  { id: 'exclusive', title: 'exclusive · only you use the device' },
];

/**
 * The mode a connect asks for (`registry.connectMode`, shared by Discovery and the sidebar): a
 * segmented control, or a compact select where there is no room.
 */
@Component({
  selector: 'racs-connect-mode',
  standalone: true,
  template: `
    @if (compact()) {
    <select class="field h-6 w-auto px-1 text-2xs" aria-label="Connect as" title="The mode a connect takes"
      (change)="registry.setConnectMode($any($event.target).value)">
      @for (m of modes; track m.id) {
      <option [value]="m.id" [selected]="m.id === registry.connectMode()" [title]="m.title">{{ m.id }}</option>
      }
    </select>
    } @else {
    <div class="inline-flex mobile:w-full" role="radiogroup" aria-label="Connect as">
      @for (m of modes; track m.id; let first = $first) {
      @let on = registry.connectMode() === m.id;
      <button type="button" role="radio" class="btn rounded-none normal-case tracking-normal mobile:flex-1"
        [class.-ml-px]="!first" [attr.aria-checked]="on" [class.!border-accent]="on" [class.!text-fg]="on"
        [class.text-muted]="!on" [class.z-10]="on" [title]="m.title" (click)="registry.setConnectMode(m.id)">
        {{ m.id }}
      </button>
      }
    </div>
    }
  `,
})
export class ConnectModeComponent {
  readonly registry = inject(DeviceRegistryService);
  /** A select instead of the segmented control. */
  readonly compact = input(false, { transform: booleanAttribute });
  readonly modes = MODES;
}

import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import {
  type AccessMode,
  clientLabel,
  DeviceRegistryService,
  errorMessage,
  refusalMessage,
  refusalOf,
  SessionService,
} from 'ng-racs-core';
import { ArmedDirective } from '../../shared/armed.directive';

type LeaseMode = Exclude<AccessMode, 'shared'>;

const MODE_TITLES: Record<AccessMode, string> = {
  shared: 'shared · every client reads and writes',
  'ro-shared': 'ro-shared · the owner writes, the others read and watch',
  exclusive: 'exclusive · only the owner uses the device',
};

/**
 * The device's access mode and what this client can do about it (specs/multi-user.md §3): the
 * mode as a tag, the owner, the member and viewer counts, and Take control / Release / Force
 * release. Going exclusive while others use the device is refused (`409`); the button then
 * offers to force it, which evicts them. Forcing asks for a second click.
 */
@Component({
  selector: 'racs-device-access',
  standalone: true,
  imports: [ArmedDirective],
  template: `
    @if (access(); as a) {
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2 font-mono text-2xs">
      <span class="tag" [title]="modeTitle(a.mode)">{{ a.mode }}</span>
      @if (a.owner) {
      <span class="min-w-0 truncate text-muted" [title]="'owner · ' + ownerLabel()">held by {{ ownerLabel() }}</span>
      }
      <span class="text-faint">{{ counts() }}</span>
      @switch (a.you) {
      @case ('owner') {
      <select class="field w-auto" aria-label="Access mode" title="Change the mode of your lease" [disabled]="busy()"
        (change)="setTakeMode($any($event.target).value); take(takeMode())">
        @for (m of leaseModes; track m) {
        <option [value]="m" [selected]="m === a.mode">{{ m }}</option>
        }
      </select>
      @if (inUse()) {
      <button type="button" class="btn" racsArmed #force="armed" [disabled]="busy()"
        title="Go exclusive anyway: the other clients lose the device, their streams and bursts stop"
        (confirmed)="take(takeMode(), true)">{{ force.armed() ? 'Confirm force' : 'Force' }}</button>
      }
      <button type="button" class="btn" [disabled]="busy()" title="Give the lease up: the device is shared again"
        (click)="release()">Release</button>
      }
      @case ('writer') {
      <select class="field w-auto" aria-label="Mode to take" [disabled]="busy()"
        (change)="setTakeMode($any($event.target).value)">
        @for (m of leaseModes; track m) {
        <option [value]="m" [selected]="m === takeMode()" [title]="modeTitle(m)">{{ m }}</option>
        }
      </select>
      @if (inUse()) {
      <button type="button" class="btn" racsArmed #force="armed" [disabled]="busy()"
        title="Take it anyway: the other clients lose the device, their streams and bursts stop"
        (confirmed)="take(takeMode(), true)">{{ force.armed() ? 'Confirm force' : 'Force' }}</button>
      } @else {
      <button type="button" class="btn" [disabled]="busy()" [title]="'Take the lease: ' + modeTitle(takeMode())"
        (click)="take(takeMode())">Take control</button>
      }
      }
      @default {
      <button type="button" class="btn" racsArmed #force="armed" [disabled]="busy()"
        title="Break the other client's lease: the device is shared again" (confirmed)="forceRelease()">
        {{ force.armed() ? 'Confirm force' : 'Force release' }}
      </button>
      }
      }
      @if (inUse(); as why) {
      <span class="text-faint">{{ why }}</span>
      }
      @if (error(); as err) {
      <span class="text-err">{{ err }}</span>
      }
    </div>
    }
  `,
})
export class DeviceAccessComponent {
  private readonly registry = inject(DeviceRegistryService);
  private readonly session = inject(SessionService);

  readonly deviceId = input.required<number>();

  readonly leaseModes: readonly LeaseMode[] = ['ro-shared', 'exclusive'];
  readonly access = computed(() => this.registry.access(this.deviceId()));
  readonly busy = computed(() => this.registry.busy().has(this.deviceId()));
  /** The mode Take control takes. */
  readonly takeMode = signal<LeaseMode>('ro-shared');
  /** Who is in the way of going exclusive (a `409`); the button then forces. */
  readonly inUse = signal<string | null>(null);
  readonly error = signal<string | null>(null);

  readonly ownerLabel = computed(() => clientLabel(this.access()?.owner, this.session.clientId()));

  readonly counts = computed(() => {
    const a = this.access();
    if (!a) {
      return '';
    }
    const members = a.members.length;
    return `${members} ${members === 1 ? 'member' : 'members'} · ${a.viewers} ${a.viewers === 1 ? 'viewer' : 'viewers'}`;
  });

  constructor() {
    // A refusal is about the state it met: drop it once the device or its mode changes.
    effect(() => {
      this.deviceId();
      this.access()?.mode;
      untracked(() => {
        this.inUse.set(null);
        this.error.set(null);
      });
    });
  }

  modeTitle(mode: AccessMode): string {
    return MODE_TITLES[mode];
  }

  setTakeMode(mode: LeaseMode): void {
    this.takeMode.set(mode);
    this.inUse.set(null);
  }

  take(mode: AccessMode, force = false): void {
    this.error.set(null);
    this.registry.setAccess(this.deviceId(), mode, force).subscribe({
      next: () => this.inUse.set(null),
      error: (e) => {
        const refusal = refusalOf(e);
        if (refusal?.error === 'device_in_use' && !force) {
          this.inUse.set(refusalMessage(refusal, this.session.clientId()));
        } else {
          this.error.set(errorMessage(e));
        }
      },
    });
  }

  release(): void {
    this.error.set(null);
    this.registry.release(this.deviceId()).subscribe({ error: (e) => this.error.set(errorMessage(e)) });
  }

  forceRelease(): void {
    this.error.set(null);
    this.registry.release(this.deviceId(), true).subscribe({ error: (e) => this.error.set(errorMessage(e)) });
  }
}

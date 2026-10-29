import { Component, inject } from '@angular/core';
import { SessionService } from 'ng-racs-core';

/**
 * This tab's client name as other clients see it (owner, members, "changed by …"), editable.
 * Saved on Enter or when the field is left; an empty name goes back to `webapp · <browser>`.
 */
@Component({
  selector: 'racs-client-name',
  standalone: true,
  template: `
    <div class="flex min-w-0 flex-col gap-1">
      <input class="field" aria-label="Client name" title="How other clients see this tab"
        [value]="session.name()" (keydown.enter)="$any($event.target).blur()" (blur)="save($any($event.target))" />
      <span class="font-mono text-2xs text-faint" title="The id other clients see next to the name">
        {{ session.clientId() ?? 'no session' }}
      </span>
    </div>
  `,
})
export class ClientNameComponent {
  readonly session = inject(SessionService);

  save(input: HTMLInputElement): void {
    void this.session.rename(input.value).then(() => (input.value = this.session.name()));
  }
}

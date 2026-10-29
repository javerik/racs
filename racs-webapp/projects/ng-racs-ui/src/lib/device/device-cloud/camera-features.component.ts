import { Component, computed, effect, inject, input, OnDestroy, untracked } from '@angular/core';
import { categoryNames, categoryRows, GenicamSession, selectorNames, selectorRows } from 'ng-racs-core';
import { FeatureControlComponent } from '../genicam/feature-control.component';

/** Features the acquisition sets itself; shown, not offered for writing. */
const STREAM_OWNED: Readonly<Record<string, string>> = {
  PixelFormat: 'Set by the stream at every start',
};

/**
 * A camera category (`category`) or a selector's branch (`selector`) as rows of feature
 * controls, read and written through the workspace's {@link GenicamSession}, like the quick
 * settings. Rows follow the camera: what it doesn't offer in its current mode is left out, and
 * entries and locks come from the features' live states.
 */
@Component({
  selector: 'racs-camera-features',
  standalone: true,
  imports: [FeatureControlComponent],
  template: `
    @if (session.holder() === 'burst') {
    <p class="m-0 pb-2 font-mono text-2xs text-warn">locked while the burst captures</p>
    } @else if (session.readOnlyReason(); as why) {
    <p class="m-0 pb-2 font-mono text-2xs text-faint">{{ why }}</p>
    }
    @if (rows().length === 0) {
    <p class="m-0 font-mono text-2xs text-faint">{{ session.loading() ? 'loading features…' : 'nothing offered in this mode' }}</p>
    }
    <div class="flex flex-col gap-2.5">
      @for (row of rows(); track row.node.name) {
      @let name = row.node.name;
      <div class="flex min-w-0 flex-col gap-1" [style.padding-left.rem]="row.depth * 0.75">
        <span class="flex min-w-0 items-center gap-1.5 text-xs" [title]="name">
          @if (row.depth > 0) {
          <span class="select-none font-mono text-faint">└</span>
          }
          <span class="truncate">{{ row.node.display_name || name }}</span>
          @if (owned(name); as why) {
          <span class="ml-auto shrink-0 font-mono text-2xs text-faint" [title]="why">stream</span>
          }
        </span>
        <racs-feature-control [node]="row.node" [state]="session.states()[name]"
          [saving]="session.savingNodes().has(name)" [error]="session.nodeErrors()[name]"
          [disabled]="session.writeBlocked() || !!owned(name)" (commit)="session.write(name, $event)"
          (execute)="session.execute(name)" />
      </div>
      }
    </div>
  `,
})
export class CameraFeaturesComponent implements OnDestroy {
  readonly session = inject(GenicamSession);
  readonly category = input<string | null>(null);
  readonly selector = input<string | null>(null);

  private readonly owner = computed(() => `cloud:${this.category() ?? this.selector()}`);

  /** Everything the rows may show, offered now or not: what to read state for. */
  private readonly names = computed(() => {
    const category = this.category();
    const selector = this.selector();
    if (category) {
      return categoryNames(this.session.categories(), category);
    }
    return selector ? selectorNames(this.session.nodes(), selector) : [];
  });

  readonly rows = computed(() => {
    const category = this.category();
    const selector = this.selector();
    const states = this.session.states();
    if (category) {
      return categoryRows(this.session.categories(), category, states);
    }
    return selector ? selectorRows(this.session.nodes(), selector, states) : [];
  });

  constructor() {
    effect(() => {
      const owner = this.owner();
      const names = this.names();
      untracked(() => this.session.watch(owner, names));
    });
  }

  owned(name: string): string | null {
    return STREAM_OWNED[name] ?? null;
  }

  ngOnDestroy(): void {
    this.session.unwatch(this.owner());
  }
}

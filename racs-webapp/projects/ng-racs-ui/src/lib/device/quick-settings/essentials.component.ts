import { Component, computed, effect, inject, OnDestroy, untracked } from '@angular/core';
import {
  ESSENTIAL_FEATURES,
  type FeatureState,
  type GenICamEnumInfo,
  type GenICamNodeInfo,
  GenicamSession,
} from 'ng-racs-core';
import { LayoutService } from '../../services/layout.service';
import { FeatureControlComponent } from '../genicam/feature-control.component';

const WATCH_OWNER = 'essentials';
/** An enum with at most this many offered entries gets buttons instead of a select. */
const SEGMENTED_MAX = 4;

interface EssentialRow {
  node: GenICamNodeInfo;
  /** The entries as buttons, or `null` for the feature's usual control. */
  segments: GenICamEnumInfo[] | null;
}

/**
 * The settings touched most while acquiring (`ESSENTIAL_FEATURES`), above the acquisition tabs so
 * they are at hand on Live, Burst and 3D alike. Hidden on a camera that has none of them.
 */
@Component({
  selector: 'racs-essentials',
  standalone: true,
  imports: [FeatureControlComponent],
  template: `
    @if (rows().length) {
    <section class="panel flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-1.5 mobile:flex-col mobile:items-stretch mobile:gap-y-3 mobile:py-3"
      aria-label="Essential settings">
      <h2 class="label m-0 shrink-0">Essentials</h2>
      @for (row of rows(); track row.node.name) {
      @let name = row.node.name;
      @let st = session.states()[name];
      @let saving = session.savingNodes().has(name);
      <div class="flex min-w-0 items-center gap-3 mobile:flex-col mobile:items-stretch mobile:gap-1"
        [class.flex-1]="!row.segments">
        <span class="shrink-0 text-xs" [title]="name">{{ row.node.display_name || name }}</span>
        @if (row.segments; as entries) {
        <div class="inline-flex items-center gap-2">
          <div class="inline-flex mobile:flex-1" role="radiogroup" [attr.aria-label]="row.node.display_name || name">
            @for (en of entries; track en.value; let first = $first) {
            @let active = st?.value === en.value + '';
            <button type="button" role="radio" [attr.aria-checked]="active"
              class="btn rounded-none normal-case tracking-normal mobile:h-10 mobile:flex-1" [class.-ml-px]="!first"
              [class.!border-accent]="active" [class.!text-fg]="active" [class.text-muted]="!active"
              [class.z-10]="active" [disabled]="saving || !writable(row.node, st)"
              [title]="en.display_name" (click)="!active && session.write(name, en.value + '')">
              {{ en.display_name }}
            </button>
            }
          </div>
          @if (st?.locked && st?.available) {
          <span class="tag h-4 shrink-0 px-1" title="Locked by the camera's current settings">Locked</span>
          }
          @if (saving) {
          <span class="dot shrink-0 animate-pulse bg-warn" title="Applying"></span>
          }
        </div>
        @if (session.nodeErrors()[name]; as err) {
        <p class="m-0 font-mono text-2xs text-err">{{ err }}</p>
        }
        } @else {
        <racs-feature-control class="min-w-0 flex-1" [node]="row.node" [state]="st"
          [layout]="layout.isMobile() ? 'inline' : 'strip'" [saving]="saving"
          [error]="session.nodeErrors()[name]" [disabled]="session.writeBlocked()"
          (commit)="session.write(name, $event)" (execute)="session.execute(name)" />
        }
      </div>
      }
      @if (session.holder() === 'burst') {
      <span class="font-mono text-2xs text-warn">locked while the burst captures</span>
      } @else if (session.readOnlyReason(); as why) {
      <span class="font-mono text-2xs text-faint">{{ why }}</span>
      }
    </section>
    }
  `,
  styles: `
    :host {
      display: block;
    }
  `,
})
export class EssentialsComponent implements OnDestroy {
  readonly session = inject(GenicamSession);
  readonly layout = inject(LayoutService);

  /** The essentials this camera has. */
  private readonly present = computed(() => {
    const nodes = this.session.nodes();
    return ESSENTIAL_FEATURES.filter((name) => nodes.has(name));
  });

  readonly rows = computed<EssentialRow[]>(() => {
    if (this.session.loading() || this.session.error()) {
      return [];
    }
    const nodes = this.session.nodes();
    const states = this.session.states();
    const rows: EssentialRow[] = [];
    for (const name of this.present()) {
      const node = nodes.get(name)!;
      const st = states[name];
      if (st?.available === false) {
        continue;
      }
      rows.push({ node, segments: segments(node, st) });
    }
    return rows;
  });

  constructor() {
    effect(() => {
      const names = this.present();
      untracked(() => this.session.watch(WATCH_OWNER, names));
    });
  }

  ngOnDestroy(): void {
    this.session.unwatch(WATCH_OWNER);
  }

  writable(node: GenICamNodeInfo, st: FeatureState | undefined): boolean {
    const mode = node.access_mode;
    return (
      !!st && (mode === 'ReadWrite' || mode === 'WriteOnly') && !st.locked && !this.session.writeBlocked()
    );
  }
}

/**
 * A short enum's entries as the device offers them now (plus the current one), the same filter
 * `FeatureControlComponent` applies to its select; `null` for anything else.
 */
function segments(node: GenICamNodeInfo, st: FeatureState | undefined): GenICamEnumInfo[] | null {
  if (node.node_type !== 'Enum' || !node.enums?.length) {
    return null;
  }
  const offered = st?.available_entries;
  const entries = offered
    ? node.enums.filter((e) => offered.includes(e.value) || String(e.value) === st?.value)
    : node.enums;
  return entries.length <= SEGMENTED_MAX ? entries : null;
}

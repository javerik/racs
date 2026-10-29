import { booleanAttribute, Component, computed, effect, inject, input, OnDestroy, signal, untracked } from '@angular/core';
import {
  candidateNames,
  type FeatureState,
  GenicamSession,
  PACKET_SIZE_FEATURE,
  type PacketSizeInfo,
  POLLED_FEATURES,
  RacsService,
  resolveSections,
  sliderRange,
} from 'ng-racs-core';
import { FeatureControlComponent } from '../genicam/feature-control.component';
import { PacketSizeToolsComponent } from './packet-size-tools.component';

const COLLAPSED_KEY = 'racs.quick.collapsed';
const WATCH_OWNER = 'quick-settings';

/**
 * The GenICam settings used day to day, under the live view. During a live stream they apply
 * immediately: the server carries them out inside the running stream.
 */
@Component({
  selector: 'racs-quick-settings',
  standalone: true,
  imports: [FeatureControlComponent, PacketSizeToolsComponent],
  template: `
    <section class="flex w-full flex-col" [class.panel]="!embedded()"
      [class.border-t]="embedded()" [class.border-line]="embedded()">
      <div class="panel-head">
        <h2 class="label m-0 flex-1">Quick settings</h2>
        @if (session.busy()) {
        <span class="inline-flex items-center gap-2 font-mono text-2xs uppercase tracking-[0.08em] text-muted">
          <span class="dot animate-pulse bg-warn"></span>Sync
        </span>
        }
        @if (session.remoteChange(); as change) {
        <span class="min-w-0 truncate font-mono text-2xs text-faint" [title]="change">{{ change }}</span>
        }
        @if (session.holder() === 'burst') {
        <span class="font-mono text-2xs text-warn">locked while the burst captures</span>
        } @else if (session.readOnlyReason(); as why) {
        <span class="font-mono text-2xs text-faint">{{ why }}</span>
        } @else if (session.holder() === 'live') {
        <span class="font-mono text-2xs text-faint">applies to the running stream</span>
        }
      </div>

      @if (session.loading()) {
      <p class="m-0 px-4 py-4 font-mono text-xs text-muted">Loading features…</p>
      } @else if (session.error(); as err) {
      <div class="notice-err m-3">{{ err }}</div>
      } @else if (sections().length === 0) {
      <p class="m-0 px-4 py-4 font-mono text-xs text-faint">
        None of the usual settings found on this camera. Pin features with ★ in the GenICam list.
      </p>
      } @else {
      <div class="sections gap-0">
        @for (sec of sections(); track sec.id) {
        <div class="break-inside-avoid border-b border-line">
          <button type="button" [attr.aria-expanded]="!collapsed().has(sec.id)"
            class="flex h-8 w-full cursor-pointer items-center gap-2 border-none bg-transparent px-4 text-left hover:bg-raised"
            (click)="toggle(sec.id)">
            <span class="w-3 font-mono text-xs text-muted">{{ collapsed().has(sec.id) ? '+' : '−' }}</span>
            <span class="label flex-1 text-fg">{{ sec.title }}</span>
            <span class="font-mono text-2xs text-faint">{{ sec.rows.length }}</span>
          </button>
          @if (!collapsed().has(sec.id)) {
          <div class="flex flex-col pb-2">
            @for (row of sec.rows; track row.node.name) {
            @let name = row.node.name;
            @let wide = isWide(name);
            <!-- On mobile every row stacks the name above its control, which then gets the full width. -->
            <div class="items-center gap-3 px-4 py-1 mobile:!flex mobile:!flex-col mobile:!items-stretch mobile:!gap-1 mobile:py-2"
              [class]="wide ? 'flex flex-col !items-stretch !gap-1 py-2' : 'grid grid-cols-[minmax(6.5rem,10rem)_minmax(0,1fr)]'">
              <span class="flex min-w-0 items-center gap-1.5 text-xs" [title]="name">
                @if (row.depth > 0) {
                <span class="select-none pl-1 font-mono text-faint">└</span>
                }
                <span class="truncate">{{ row.node.display_name || name }}</span>
              </span>
              <racs-feature-control [node]="row.node" [state]="states()[name]" [layout]="wide ? 'wide' : 'inline'"
                [saving]="session.savingNodes().has(name)" [error]="session.nodeErrors()[name]"
                [disabled]="session.writeBlocked()" (commit)="session.write(name, $event)"
                (execute)="session.execute(name)" />
            </div>
            @if (name === packetSize) {
            <racs-packet-size-tools [info]="packetInfo()" [disabled]="session.writeBlocked()" />
            }
            }
          </div>
          }
        </div>
        }
      </div>
      }
    </section>
  `,
  styles: `
    :host {
      display: block;
      container-type: inline-size;
    }

    /* Two columns when the panel itself is wide, whether it sits beside the image or under it. */
    .sections {
      columns: 1;
    }

    @container (min-width: 44rem) {
      .sections {
        columns: 2;
      }

      .sections > div {
        border-right: 1px solid rgb(var(--line));
      }
    }
  `,
})
export class QuickSettingsComponent implements OnDestroy {
  readonly session = inject(GenicamSession);
  /** Inside another panel (the mobile live view): a rule on top instead of a frame of its own. */
  readonly embedded = input(false, { transform: booleanAttribute });
  readonly collapsed = signal<ReadonlySet<string>>(loadCollapsed());

  readonly sections = computed(() =>
    resolveSections(this.session.nodes(), this.session.states(), this.session.pins()),
  );
  private readonly names = computed(() => candidateNames(this.session.nodes(), this.session.pins()));

  readonly packetSize = PACKET_SIZE_FEATURE;
  /** The server's packet size bounds and link, for the device shown; `null` until known. */
  readonly packetInfo = signal<PacketSizeInfo | null>(null);
  private readonly showsPacketSize = computed(() =>
    this.sections().some((sec) => sec.rows.some((row) => row.node.name === PACKET_SIZE_FEATURE)),
  );

  /**
   * The session's states, with the packet size bounded as the server checks it: multiples of
   * `inc` from `min` to `max`. A camera may declare a minimum off that grid (the AT C6: 86, step
   * 4), and the slider would then only offer sizes like 1498 and 1502.
   */
  readonly states = computed<Partial<Record<string, FeatureState>>>(() => {
    const states = this.session.states();
    const info = this.packetInfo();
    const st = states[PACKET_SIZE_FEATURE];
    if (!info || !st) {
      return states;
    }
    return { ...states, [PACKET_SIZE_FEATURE]: { ...st, min: info.min, max: info.max, inc: info.inc } };
  });

  constructor() {
    effect(() => {
      const names = this.names();
      untracked(() => this.session.watch(WATCH_OWNER, names));
    });
    this.session.setPolled(POLLED_FEATURES);

    // Bounds and link don't change while connected: fetched once per device, and again after a
    // burst if the camera was busy the first time.
    effect(() => {
      const id = this.session.deviceId();
      const wanted = this.showsPacketSize() && this.session.holder() !== 'burst' && this.session.role() !== 'meta';
      untracked(() => {
        if (id === null) {
          this.packetInfo.set(null);
          this.packetInfoFor = null;
          return;
        }
        if (!wanted || this.packetInfoFor === id) {
          return;
        }
        this.packetInfoFor = id;
        this.packetInfo.set(null);
        this.racs.getPacketSize(id).subscribe({
          next: (info) => this.session.deviceId() === id && this.packetInfo.set(info),
          error: () => {
            if (this.packetInfoFor === id) {
              this.packetInfoFor = null;
            }
          },
        });
      });
    });
  }

  private readonly racs = inject(RacsService);
  /** The device `packetInfo` was asked for. */
  private packetInfoFor: number | null = null;

  /** A number spanning decades gets a full-width row: range chips plus a slider within one. */
  isWide(name: string): boolean {
    const st = this.session.states()[name];
    const node = this.session.nodes().get(name);
    if (!st || !node || (node.node_type !== 'Float' && node.node_type !== 'Integer') || st.locked) {
      return false;
    }
    const writable = node.access_mode === 'ReadWrite' || node.access_mode === 'WriteOnly';
    return writable && !!sliderRange(st.min, st.max, st.inc, st.representation, node.node_type === 'Integer')?.log;
  }

  ngOnDestroy(): void {
    this.session.unwatch(WATCH_OWNER);
  }

  toggle(id: string): void {
    const next = new Set(this.collapsed());
    if (!next.delete(id)) {
      next.add(id);
    }
    this.collapsed.set(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
    } catch {
      // Remembering is a convenience only.
    }
  }
}

function loadCollapsed(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

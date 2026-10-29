import { booleanAttribute, Component, computed, inject, input, OnDestroy, OnInit, signal } from '@angular/core';
import { LayoutService } from '../services/layout.service';

interface Registered {
  id: string;
  title: string;
  order: number;
  camera: boolean;
}

/**
 * A settings column of named sections ({@link InspectorSectionComponent}). On desktop every
 * section is a collapsible block with its title, summary and a `+`/`−` marker; on mobile the
 * sections become tabs and one shows at a time. Sections marked `camera` (they write the camera,
 * the rest only change the view) come first, set off from the rest by a rule in the tab row.
 *
 * `storageKey` keeps which sections are folded (desktop) and the open tab (mobile).
 */
@Component({
  selector: 'racs-inspector',
  standalone: true,
  template: `
    @if (layout.isMobile() && tabs().length > 1) {
    <div role="tablist" aria-label="Settings" class="flex overflow-x-auto border-b border-line">
      @for (t of tabs(); track t.id) {
      <button type="button" role="tab" [attr.aria-selected]="activeId() === t.id"
        class="h-11 shrink-0 border-b-2 px-3 font-mono text-2xs uppercase tracking-[0.08em] transition-colors"
        [class.border-accent]="activeId() === t.id" [class.text-fg]="activeId() === t.id"
        [class.border-transparent]="activeId() !== t.id" [class.text-muted]="activeId() !== t.id"
        (click)="select(t.id)">{{ t.title }}</button>
      @if (t.divider) {
      <span class="my-3 w-px shrink-0 bg-line-strong" aria-hidden="true"></span>
      }
      }
    </div>
    }
    <ng-content />
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
  `,
})
export class InspectorComponent {
  readonly layout = inject(LayoutService);
  readonly storageKey = input.required<string>();

  private readonly sections = signal<readonly Registered[]>([]);
  private readonly chosen = signal<string | null>(null);
  private readonly folded = signal<ReadonlySet<string> | null>(null);

  readonly tabs = computed(() => {
    const sorted = [...this.sections()].sort((a, b) => a.order - b.order);
    return sorted.map((s, i) => ({ ...s, divider: s.camera && sorted[i + 1] !== undefined && !sorted[i + 1].camera }));
  });

  /** The open tab on mobile: the one chosen, else the first. */
  readonly activeId = computed(() => {
    const tabs = this.tabs();
    const chosen = this.chosen() ?? load(`${this.storageKey()}.tab`);
    return tabs.find((t) => t.id === chosen)?.id ?? tabs[0]?.id ?? null;
  });

  register(section: Registered): void {
    this.sections.update((list) => [...list.filter((s) => s.id !== section.id), section]);
  }

  unregister(id: string): void {
    this.sections.update((list) => list.filter((s) => s.id !== id));
  }

  select(id: string): void {
    this.chosen.set(id);
    save(`${this.storageKey()}.tab`, id);
  }

  isFolded(id: string): boolean {
    return this.foldedSet().has(id);
  }

  toggleFolded(id: string): void {
    const next = new Set(this.foldedSet());
    if (!next.delete(id)) {
      next.add(id);
    }
    this.folded.set(next);
    save(`${this.storageKey()}.folded`, JSON.stringify([...next]));
  }

  /** The folded sections: as changed here, else as stored. */
  private readonly foldedSet = computed<ReadonlySet<string>>(() => {
    const known = this.folded();
    if (known) {
      return known;
    }
    try {
      const parsed: unknown = JSON.parse(load(`${this.storageKey()}.folded`) ?? '[]');
      return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
    } catch {
      return new Set();
    }
  });
}

/**
 * One section of an {@link InspectorComponent}: a header that folds it on desktop, a tab on
 * mobile. The content is only created while it shows.
 */
@Component({
  selector: 'racs-inspector-section',
  standalone: true,
  template: `
    @if (!inspector.layout.isMobile()) {
    <button type="button" [attr.aria-expanded]="open()"
      class="flex h-8 w-full cursor-pointer items-center gap-2 border-none bg-transparent px-3 text-left hover:bg-raised"
      (click)="inspector.toggleFolded(id())">
      <span class="w-3 font-mono text-xs text-muted">{{ open() ? '−' : '+' }}</span>
      <span class="label flex-1 text-fg">{{ title() }}</span>
      @if (summary(); as s) {
      <span class="min-w-0 truncate font-mono text-2xs text-faint" [title]="s">{{ s }}</span>
      }
      @if (camera()) {
      <span class="tag h-4 px-1" title="These settings write the camera">camera</span>
      }
    </button>
    }
    @if (open()) {
    <div class="pb-3 desktop:px-3 mobile:px-3 mobile:pt-3">
      <ng-content />
    </div>
    }
  `,
  styles: `
    :host {
      display: block;
      border-bottom: 1px solid rgb(var(--line));
    }

    :host-context([data-layout='mobile']) {
      border-bottom: 0;
    }
  `,
  host: {
    '[attr.hidden]': 'hidden() ? "" : null',
    role: 'region',
    '[attr.aria-label]': 'title()',
  },
})
export class InspectorSectionComponent implements OnInit, OnDestroy {
  readonly inspector = inject(InspectorComponent);
  readonly id = input.required<string>();
  readonly title = input.required<string>();
  /** A short line beside the title on desktop: the state at a glance. */
  readonly summary = input<string | null>(null);
  /** Position among the sections, wherever it is declared. */
  readonly order = input(0);
  /** Writes the camera rather than the view. */
  readonly camera = input(false, { transform: booleanAttribute });

  readonly open = computed(() =>
    this.inspector.layout.isMobile() ? this.inspector.activeId() === this.id() : !this.inspector.isFolded(this.id()),
  );
  /** On mobile only the open tab shows; its header is the tab. */
  readonly hidden = computed(() => this.inspector.layout.isMobile() && !this.open());

  ngOnInit(): void {
    this.inspector.register({ id: this.id(), title: this.title(), order: this.order(), camera: this.camera() });
  }

  ngOnDestroy(): void {
    this.inspector.unregister(this.id());
  }
}

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Remembering is a convenience only.
  }
}

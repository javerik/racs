import { Component, computed, effect, HostListener, inject, input, OnDestroy, output, signal, untracked } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  buildRows,
  FeatureCategory,
  type GenICamNodeInfo,
  GenicamSession,
  type GenICamVisibility,
  isSelector,
  selectorsOf,
} from 'ng-racs-core';
import { LayoutService } from '../../services/layout.service';
import { FeatureControlComponent } from '../genicam/feature-control.component';

/** GenICam visibility: a lower rank is meant for a wider audience (SFNC). */
const VISIBILITY_RANK: Record<GenICamVisibility, number> = {
  Beginner: 0,
  Expert: 1,
  Guru: 2,
  Undefined: 0,
  Invisible: 99,
};

export type GenicamDetailLevel = 'beginner' | 'expert' | 'guru' | 'all';

const DETAIL_LEVEL_MAX_RANK: Record<GenicamDetailLevel, number> = {
  beginner: 0,
  expert: 1,
  guru: 2,
  all: 99,
};

const DETAIL_KEY = 'racs.features.detail';

/**
 * Every GenICam feature of the device, by category, filtered by visibility. `compact` is the
 * workspace's "All features" tab beside the acquisition view; `max` is the full-screen version with a search and a multi-column layout. Both
 * share the workspace's {@link GenicamSession}, so values, pins and expanded categories carry
 * over between them.
 */
@Component({
  selector: 'racs-device-configuration',
  standalone: true,
  imports: [CommonModule, FormsModule, FeatureControlComponent],
  templateUrl: './device-configuration.component.html',
  styleUrl: './device-configuration.component.scss',
})
export class DeviceConfigurationComponent implements OnDestroy {
  readonly session = inject(GenicamSession);
  readonly layout = inject(LayoutService);

  readonly mode = input<'compact' | 'max'>('compact');
  readonly maximize = output<void>();
  readonly closed = output<void>();

  readonly detailLevel = signal<GenicamDetailLevel>(loadDetail());
  readonly filter = signal('');

  /** Categories after the visibility filter and search, each ordered and nested by selector. */
  readonly view = computed<FeatureCategory[]>(() => {
    const maxRank = DETAIL_LEVEL_MAX_RANK[this.detailLevel()];
    const query = this.filter().trim().toLowerCase();
    const matches = (n: GenICamNodeInfo) =>
      !query || n.name.toLowerCase().includes(query) || (n.display_name ?? '').toLowerCase().includes(query);
    const all = this.session.categories();
    const selectors = selectorsOf(all);
    return all
      .map((cat) => ({
        name: cat.name,
        display_name: cat.display_name,
        rows: buildRows(
          cat.nodes.filter((n) => VISIBILITY_RANK[n.visibility] <= maxRank && matches(n)),
          selectors,
        ),
      }))
      .filter((cat) => cat.rows.length > 0);
  });

  /** Nodes of the expanded categories, as currently filtered. */
  private readonly visibleRows = computed(() =>
    this.view()
      .filter((c) => this.isExpanded(c.name))
      .flatMap((c) => c.rows.map((r) => r.node.name)),
  );

  readonly isSelector = isSelector;

  constructor() {
    // The maximized view is for seeing everything: open it expanded unless the compact one
    // already had a selection of categories open.
    let opened = false;
    effect(() => {
      const categories = this.view();
      if (opened || this.mode() !== 'max' || categories.length === 0) {
        return;
      }
      opened = true;
      untracked(() => {
        if (this.session.expanded().size === 0) {
          this.expandAll();
        }
      });
    });

    // Read whatever became visible: a category was expanded, or the filters now show more.
    effect(() => {
      const names = this.visibleRows();
      const owner = this.owner();
      untracked(() => this.session.watch(owner, names));
    });
  }

  ngOnDestroy(): void {
    this.session.unwatch(this.owner());
  }

  private owner(): string {
    return `feature-tree-${this.mode()}`;
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.mode() === 'max') {
      this.closed.emit();
    }
  }

  setDetailLevel(level: GenicamDetailLevel): void {
    this.detailLevel.set(level);
    try {
      localStorage.setItem(DETAIL_KEY, level);
    } catch {
      // Remembering is a convenience only.
    }
  }

  isExpanded(name: string): boolean {
    // A search shows its hits wherever they are.
    return this.filter().trim() !== '' || this.session.expanded().has(name);
  }

  expandAll(): void {
    this.session.setExpanded(this.view().map((c) => c.name));
  }

  collapseAll(): void {
    this.session.setExpanded([]);
  }

  isPinned(name: string): boolean {
    return this.session.pins().includes(name);
  }

  /** Short access-mode tag shown next to each feature. */
  accessTag(node: GenICamNodeInfo): string {
    switch (node.access_mode) {
      case 'ReadWrite':
        return 'RW';
      case 'ReadOnly':
        return 'RO';
      case 'WriteOnly':
        return 'WO';
      default:
        return '—';
    }
  }
}

function loadDetail(): GenicamDetailLevel {
  try {
    const v = localStorage.getItem(DETAIL_KEY);
    return v === 'expert' || v === 'guru' || v === 'all' ? v : 'beginner';
  } catch {
    return 'beginner';
  }
}

import { Component, booleanAttribute, inject, input } from '@angular/core';
import { RoiSession, type ViewTool } from 'ng-racs-core';
import { IconComponent, type IconName } from '../../shared/icon.component';

interface Tool {
  id: Exclude<ViewTool, null>;
  icon: IconName;
  label: string;
}

const TOOLS: Tool[] = [
  { id: 'region', icon: 'region', label: 'Camera region: drag to set Width, Height and offsets' },
  { id: 'rect', icon: 'roi-rect', label: 'Rectangle ROI: drag on the image to draw one' },
  { id: 'line', icon: 'roi-line', label: 'Line ROI: drag on the image to draw a profile line' },
];

/**
 * The drawing tools for a frame canvas toolbar (`<racs-view-tools viewTools />`): the camera
 * region (live only) and the rect and line ROIs. One at a time; pressing the active one (or Esc
 * in the view) switches it off.
 */
@Component({
  selector: 'racs-view-tools',
  standalone: true,
  imports: [IconComponent],
  template: `
    <div class="inline-flex items-center gap-1 mobile:w-full" role="toolbar" aria-label="Tools">
      @for (t of tools(); track t.id) {
      @let on = session.tool() === t.id;
      <button type="button" class="icon-btn" [class.!border-accent]="on" [class.!text-fg]="on"
        [attr.aria-pressed]="on" [title]="t.label" [attr.aria-label]="t.label" [disabled]="t.id === 'region' && regionDisabled()"
        (click)="session.toggleTool(t.id)">
        <racs-icon [name]="t.icon" />
      </button>
      @if (t.id === 'region') {
      <span class="mx-1 h-4 w-px bg-line" aria-hidden="true"></span>
      }
      }
    </div>
  `,
  styles: `
    :host {
      display: contents;
    }
  `,
})
export class ViewToolsComponent {
  /** Offer the camera region tool. */
  readonly region = input(false, { transform: booleanAttribute });
  readonly regionDisabled = input(false);

  readonly session = inject(RoiSession);

  tools(): Tool[] {
    return this.region() ? TOOLS : TOOLS.filter((t) => t.id !== 'region');
  }
}

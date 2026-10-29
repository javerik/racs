import { Component, computed, inject, input } from '@angular/core';
import { paletteGradient, paletteStops } from 'ng-racs-core';
import { ThemeService } from '../../services/theme.service';
import { InspectorSectionComponent } from '../../shared/inspector.component';
import { SliderDirective } from '../../shared/slider.directive';
import type { CloudViewComponent } from './cloud-view.component';
import { LightDialComponent } from './light-dial.component';

/**
 * The cloud view's own settings as inspector sections: Draw (points or surface, density, point
 * size, palette), Scene (stretch per axis, height scale, where a surface breaks) and Light. They
 * change the view only; the export keeps the scaling's units.
 */
@Component({
  selector: 'racs-cloud-view-settings',
  standalone: true,
  imports: [InspectorSectionComponent, LightDialComponent, SliderDirective],
  template: `
    @let v = view();
    @let s = v.settings();
    <racs-inspector-section id="draw" title="Draw" [order]="order()" [summary]="drawSummary()">
      <div class="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-2.5">
        <!-- On desktop Points/Surface sit on the view; a phone has no room there. -->
        <span class="label desktop:hidden">Draw as</span>
        <div class="flex desktop:hidden" role="radiogroup" aria-label="Draw as">
          @for (r of v.renders; track r.id; let first = $first) {
          @let on = s.render === r.id;
          <button type="button" role="radio" class="btn flex-1 rounded-none" [style.margin-left.px]="first ? 0 : -1"
            [attr.aria-checked]="on" [class.!border-accent]="on" [class.!text-fg]="on" [class.text-muted]="!on"
            [title]="r.hint" (click)="v.setRender(r.id)">{{ r.label }}</button>
          }
        </div>

        <span class="label">Density</span>
        <select class="field" title="Draw every n-th column and profile; Auto thins to what the device draws smoothly"
          aria-label="Density" (change)="v.setDensity($any($event.target).value)">
          @for (d of v.densities; track d) {
          <!-- [selected], not the select's [value]: that is set before these options exist. -->
          <option [value]="d + ''" [selected]="s.density === d">{{ d === 'auto' ? 'Auto' : d === 1 ? 'All' : '1/' + d }}</option>
          }
        </select>

        @if (s.render === 'points') {
        <span class="label">Point</span>
        <label class="flex items-center gap-2" title="Point size ([ and ])">
          <input type="range" class="slider min-w-0 flex-1" [min]="v.pointSize.min" [max]="v.pointSize.max"
            [step]="v.pointSize.step" [value]="s.pointSize" aria-label="Point size"
            (input)="v.setPointSize($any($event.target).valueAsNumber)" />
          <span class="w-9 text-right font-mono text-2xs text-muted">{{ s.pointSize }} px</span>
        </label>
        } @else {
        <span class="label">Break</span>
        <label class="flex items-center gap-2"
          title="The surface breaks where neighbouring values differ by more than this share of the display window, instead of drawing a wall">
          <input type="range" class="slider min-w-0 flex-1" [min]="v.jumpRange.min" [max]="v.jumpRange.max"
            [step]="v.jumpRange.step" [value]="s.jump" aria-label="Break the surface at steps larger than"
            (input)="v.setJump($any($event.target).valueAsNumber)" />
          <span class="w-9 text-right font-mono text-2xs text-muted">{{ (s.jump * 100).toFixed(0) }} %</span>
        </label>
        }

        <span class="label">Colour</span>
        <div class="grid grid-cols-2 gap-1" role="radiogroup" aria-label="Colour by height">
          @for (p of swatches(); track p.id) {
          @let on = s.palette === p.id;
          <button type="button" role="radio" [attr.aria-checked]="on" [title]="p.label + ' · ' + p.hint"
            class="flex h-8 cursor-pointer flex-col justify-center gap-1 rounded border bg-bg px-1 transition-colors hover:bg-raised mobile:h-10"
            [class.border-accent]="on" [class.border-line-strong]="!on" (click)="v.setPalette(p.id)">
            <span class="block h-1.5 w-full rounded" [style.background]="p.gradient"></span>
            <span class="truncate font-mono text-2xs uppercase tracking-normal" [class.text-fg]="on"
              [class.text-muted]="!on">{{ p.label }}</span>
          </button>
          }
        </div>
      </div>
    </racs-inspector-section>

    <racs-inspector-section id="scene" title="Scene" [order]="order() + 1" [summary]="sceneSummary()">
      <div class="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-2.5">
        <span class="label">Stretch</span>
        <div class="grid grid-cols-3 gap-1">
          @for (a of v.axes; track a) {
          <label class="flex min-w-0 items-center gap-1" [title]="'Stretch ' + a + ' in the view only; the export keeps the units'">
            <span class="font-mono text-2xs text-faint">{{ a }}</span>
            <input type="number" class="field" [min]="v.stretchRange.min" [max]="v.stretchRange.max" step="any"
              [value]="s.stretch[a]" [attr.aria-label]="'Stretch ' + a" (change)="v.setStretch(a, $any($event.target).value)" />
          </label>
          }
        </div>
        <span class="label">Height</span>
        <div class="flex flex-wrap gap-1">
          <div class="inline-flex" role="radiogroup" aria-label="Height scale">
            @for (a of v.aspects; track a.id; let first = $first) {
            @let on = s.zAspect === a.id;
            <button type="button" role="radio" class="btn rounded-none" [style.margin-left.px]="first ? 0 : -1"
              [attr.aria-checked]="on" [class.!border-accent]="on" [class.!text-fg]="on" [class.text-muted]="!on"
              [title]="a.hint" (click)="v.setZAspect(a.id)">{{ a.label }}</button>
            }
          </div>
          <button type="button" class="btn" [disabled]="v.noStretch()" title="Every axis back to ×1" (click)="v.resetStretch()">1:1:1</button>
        </div>
      </div>
    </racs-inspector-section>

    @let light = s.light;
    <racs-inspector-section id="light" title="Light" [order]="order() + 2" [summary]="lightSummary()">
      <div class="flex items-start gap-3">
        <racs-light-dial [azimuth]="light.azimuth" [elevation]="light.elevation" [disabled]="!light.enabled || light.followView"
          [viewAzimuth]="v.viewAzimuth()" (angles)="v.setLight($event)" />
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
          <div class="flex flex-wrap gap-1">
            <button type="button" class="btn px-2" [attr.aria-pressed]="light.enabled" [class.!border-accent]="light.enabled"
              [class.!text-fg]="light.enabled" [class.text-muted]="!light.enabled"
              title="Shade by a light, or colour by height only (L)" (click)="v.setLight({ enabled: !light.enabled })">
              {{ light.enabled ? 'On' : 'Off' }}
            </button>
            <button type="button" class="btn px-2" [disabled]="!light.enabled" [attr.aria-pressed]="light.followView"
              [class.!border-accent]="light.followView" [class.!text-fg]="light.followView" [class.text-muted]="!light.followView"
              title="Keep the light just above and beside the eye, wherever the view turns"
              (click)="v.setLight({ followView: !light.followView })">Follow</button>
            <button type="button" class="btn px-2" [disabled]="!light.enabled" [attr.aria-pressed]="light.shadows"
              [class.!border-accent]="light.shadows" [class.!text-fg]="light.shadows" [class.text-muted]="!light.shadows"
              title="Cast shadows from the surface, away from the light" (click)="v.setLight({ shadows: !light.shadows })">Shadows</button>
          </div>
          @for (c of v.lightControls; track c.key) {
          <label class="flex items-center gap-2" [title]="c.hint">
            <span class="w-12 shrink-0 font-mono text-2xs uppercase tracking-[0.08em] text-faint">{{ c.label }}</span>
            <input type="range" class="slider min-w-0 flex-1" [min]="c.range.min" [max]="c.range.max" [step]="c.range.step"
              [value]="light[c.key]" [disabled]="!light.enabled" [attr.aria-label]="c.hint"
              (input)="v.setLightValue(c.key, $any($event.target).valueAsNumber)" />
          </label>
          }
        </div>
      </div>
    </racs-inspector-section>
  `,
  styles: `
    :host {
      display: contents;
    }
  `,
})
export class CloudViewSettingsComponent {
  readonly view = input.required<CloudViewComponent>();
  /** Where the three sections go among the inspector's. */
  readonly order = input(0);

  private readonly themes = inject(ThemeService);

  /** Each palette with its ramp as a CSS gradient, read from the tokens of the current theme. */
  readonly swatches = computed(() => {
    this.themes.theme();
    const v = this.view();
    if (typeof document === 'undefined') {
      return v.palettes.map((p) => ({ ...p, gradient: '' }));
    }
    const style = getComputedStyle(document.documentElement);
    return v.palettes.map((p) => ({
      ...p,
      gradient: paletteGradient(paletteStops(p.id, (name) => style.getPropertyValue(name))),
    }));
  });

  readonly drawSummary = computed(() => {
    const s = this.view().settings();
    const density = s.density === 'auto' ? 'auto' : s.density === 1 ? 'all' : `1/${s.density}`;
    return `${s.render} · ${density} · ${s.palette}`;
  });

  readonly sceneSummary = computed(() => {
    const s = this.view().settings();
    const st = s.stretch;
    const stretch = this.view().noStretch() ? '' : ` · ${st.x}:${st.y}:${st.z}`;
    return `z ${s.zAspect === 'auto' ? 'auto' : '1:1'}${stretch}`;
  });

  readonly lightSummary = computed(() => {
    const l = this.view().settings().light;
    if (!l.enabled) {
      return 'off';
    }
    return l.followView ? 'follows the view' : `${Math.round(l.azimuth)}° / ${Math.round(l.elevation)}°`;
  });
}

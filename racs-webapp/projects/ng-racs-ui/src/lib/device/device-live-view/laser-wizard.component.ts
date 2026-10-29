import { Component, computed, effect, inject, output } from '@angular/core';
import {
  LaserCalibrationService,
  LaserlineLinkService,
  MAX_RMS_PX,
  overflowEdges,
  RMS_WARN_PX,
  WIZARD_STEPS,
  type WizardStep,
} from 'ng-racs-core';
import { IconComponent } from '../../shared/icon.component';

const STEP_NAMES: Record<WizardStep, string> = {
  prepare: 'Prepare',
  capture: 'Capture',
  review: 'Review',
  tilt: 'Tilt',
  region: 'Region',
  limits: 'Limits',
  check: 'Check',
};

/** How often the prepare step looks for a laserline window. */
const LOOK_MS = 2_000;

interface Row {
  name: string;
  detail: string;
  state: 'done' | 'running' | 'pending' | 'failed';
}

/**
 * The laserline calibration as a wizard beside the live image (under it on mobile): prepare the
 * camera and laserline, film the patterns, review the mapping, level the line (the laserline tilt at
 * which the camera sees it along the sensor rows), choose and apply the camera region
 * (around the user's line, or everywhere a line can travel), keep laserline's line inside it, and
 * check the live line. Its state lives in `LaserCalibrationService`, so a layout switch that
 * re-creates it loses nothing.
 */
@Component({
  selector: 'racs-laser-wizard',
  standalone: true,
  imports: [IconComponent],
  host: { class: 'flex min-w-0 flex-col bg-surface', role: 'region', 'aria-label': 'Laserline calibration' },
  template: `
    <div class="panel-head !pr-2">
      <racs-icon name="laser" class="!h-3.5 !w-3.5 text-muted" />
      <span class="label text-fg">Laserline calibration</span>
      <span class="flex-1"></span>
      @if (mobileCounter(); as c) {
        <span class="hidden font-mono text-2xs text-muted mobile:inline">step <span class="text-accent">{{ c }}</span>/{{ steps.length }}</span>
      }
      <button type="button" class="icon-btn" aria-label="Close the calibration"
        title="Close (a running calibration stops and the region is put back)" (click)="close()">
        <racs-icon name="close" />
      </button>
    </div>

    <nav class="flex border-b border-line px-1 mobile:hidden" aria-label="Steps">
      @for (s of stepper(); track s.key) {
        <!-- The current step is named; the others are numbers, named in their title. -->
        <button type="button" class="chrome chrome-tight flex h-10 min-w-0 items-center justify-center gap-1.5 border-b-2 px-2 text-2xs transition-colors
            focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:cursor-default"
          [class]="s.cls" [disabled]="!s.reachable" [attr.aria-current]="s.current ? 'step' : null"
          [attr.aria-label]="s.num + ' ' + s.name" [title]="s.name" (click)="calib.wizard.set(s.key)">
          <span [class.text-accent]="s.current">{{ s.num }}</span>
          @if (s.current) {
            <span class="truncate">{{ s.name }}</span>
          }
        </button>
      }
    </nav>
    <div class="hidden gap-1 px-4 pt-3 mobile:flex" aria-hidden="true">
      @for (s of stepper(); track s.key) {
        <span class="h-0.5 flex-1" [class]="s.current ? 'bg-accent' : s.done ? 'bg-muted' : 'bg-line-strong'"></span>
      }
    </div>

    <div class="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
      @switch (step()) {
        @case ('prepare') {
          <div class="flex flex-col gap-1">
            <h2 class="text-sm font-medium">Prepare the camera and laserline</h2>
            <p class="text-xs leading-relaxed text-muted">
              The camera films the laserline window while it shows test patterns. Afterwards the camera region and
              laserline's line can be matched to what the camera sees.
            </p>
          </div>
          <div class="border border-line">
            <div class="flex min-h-9 items-center gap-2.5 border-b border-line px-3 py-1">
              <span class="dot" [class]="calib.live() ? 'bg-ok' : 'bg-warn'"></span>
              <span class="flex-1 text-xs">Live stream</span>
              <span class="font-mono text-2xs text-muted">{{ calib.live() ? 'running' : 'stopped' }}</span>
              @if (!calib.live()) {
                <button type="button" class="btn" (click)="startLive.emit()">Start live</button>
              }
            </div>
            @if (calib.areascan() !== null) {
              <div class="flex min-h-9 items-center gap-2.5 border-b border-line px-3 py-1">
                <span class="dot" [class]="calib.areascan() ? 'bg-ok' : 'bg-warn'"></span>
                <span class="flex-1 text-xs">Scan type</span>
                <span class="font-mono text-2xs text-muted">{{ (calib.scanType() ?? '').toLowerCase() }}</span>
                @if (!calib.areascan()) {
                  <button type="button" class="btn" [disabled]="!!calib.regionBlocked()" (click)="calib.useAreascan()">Use areascan</button>
                }
              </div>
            }
            <div class="flex min-h-9 items-center gap-2.5 border-b border-line px-3 py-1">
              <span class="dot" [class]="linkView() ? 'bg-ok' : 'bg-warn'"></span>
              <span class="flex-1 text-xs">Laserline window</span>
              <span class="font-mono text-2xs text-muted">{{ linkView() ? 'open · ' + linkView() : 'not open' }}</span>
              @if (!linkView()) {
                <button type="button" class="btn" [disabled]="!link.supported" (click)="calib.openLaserline()">Open laserline</button>
              }
            </div>
            <div class="flex min-h-9 items-center gap-2.5 px-3 py-1">
              <span class="dot border border-muted"></span>
              <span class="flex-1 text-xs">The camera sees the laserline view</span>
              <span class="font-mono text-2xs text-faint">check the image</span>
            </div>
          </div>
          <ul class="flex list-disc flex-col gap-1.5 pl-4 text-xs leading-relaxed text-muted">
            <li>Keep the laserline window in front and visible: a hidden window does not draw the patterns.</li>
            <li>Focus the camera and set the exposure so the white view is bright but not saturated.</li>
            <li>The region is set to the full sensor while calibrating and put back afterwards.</li>
          </ul>
          @if (calib.calibration(); as cal) {
            @if (!calib.stale()) {
              <div class="flex flex-wrap items-center gap-2 border border-line bg-bg px-3 py-2">
                <span class="flex-1 font-mono text-2xs text-muted">kept calibration · rms {{ cal.rms.toFixed(2) }} px · {{ cal.pairs }} pts</span>
                <button type="button" class="btn" title="Use the kept calibration and review it" (click)="calib.wizard.set('review')">Use kept</button>
              </div>
            } @else {
              <span class="font-mono text-2xs text-warn">laserline view resized since the kept calibration · calibrate again</span>
            }
          }
        }

        @case ('capture') {
          <div class="flex flex-col gap-1">
            <h2 class="text-sm font-medium">{{ running() ? 'Capturing patterns' : calib.phase() === 'failed' ? 'Capture failed' : 'Capture' }}</h2>
            <p class="text-xs leading-relaxed text-muted">Don't move the camera or the laserline window until this is done.</p>
          </div>
          <div class="flex flex-col gap-2">
            <div class="flex items-baseline">
              <span class="label flex-1">Progress</span>
              <span class="font-mono text-xs">{{ percent() }} %</span>
            </div>
            <div class="h-0.5 bg-line"><div class="h-0.5 bg-accent" [style.width.%]="percent()"></div></div>
          </div>
          <div class="border border-line">
            @for (r of rows(); track r.name; let last = $last) {
              <div class="flex h-9 items-center gap-2.5 px-3" [class.border-b]="!last" [class.border-line]="!last">
                <span class="dot shrink-0" [class]="dotClass(r.state)"></span>
                <span class="flex-1 text-xs" [class]="r.state === 'running' || r.state === 'failed' ? 'text-fg' : r.state === 'done' ? 'text-muted' : 'text-faint'">{{ r.name }}</span>
                <span class="font-mono text-2xs" [class]="r.state === 'failed' ? 'text-err' : 'text-faint'">{{ r.detail }}</span>
              </div>
            }
          </div>
        }

        @case ('review') {
          @if (calib.calibration(); as cal) {
            <div class="flex flex-col gap-1">
              <h2 class="text-sm font-medium">Review the mapping</h2>
              <p class="text-xs leading-relaxed text-muted">
                The laserline view is mapped onto the sensor. A few pixels of error are normal: the mapping has no lens distortion.
              </p>
            </div>
            <div class="grid grid-cols-3 gap-px border border-line bg-line">
              <div class="flex flex-col gap-1 bg-surface px-3 py-2.5">
                <span class="label">rms</span>
                <span class="font-mono text-lg" [class.text-warn]="rough()">{{ cal.rms.toFixed(2) }}<span class="text-2xs text-muted"> px</span></span>
                <span class="inline-flex items-center gap-1.5 font-mono text-2xs text-muted">
                  <span class="dot" [class]="rough() ? 'bg-warn' : 'bg-ok'"></span>{{ rough() ? 'rough' : 'good' }}
                </span>
              </div>
              <div class="flex flex-col gap-1 bg-surface px-3 py-2.5">
                <span class="label">field</span>
                <span class="font-mono text-lg">{{ fieldPct() }}<span class="text-2xs text-muted"> %</span></span>
                <span class="font-mono text-2xs text-faint">of the view seen</span>
              </div>
              <div class="flex flex-col gap-1 bg-surface px-3 py-2.5">
                <span class="label">points</span>
                <span class="font-mono text-lg">{{ cal.pairs }}</span>
                <span class="font-mono text-2xs text-faint">decoded cells</span>
              </div>
            </div>
            @if (cal.tiles; as tiles) {
              <div class="flex flex-col gap-2">
                <div class="flex items-baseline"><span class="label flex-1">Error per sensor tile</span><span class="font-mono text-2xs text-faint">px</span></div>
                <div class="grid grid-cols-3 gap-px border border-line bg-line">
                  @for (t of tiles; track $index) {
                    <div class="flex h-8 items-center justify-center bg-surface font-mono text-2xs"
                      [class]="t === null ? 'text-faint' : t > roughPx ? 'text-warn' : 'text-muted'">{{ t === null ? '—' : t.toFixed(1) }}</div>
                  }
                </div>
              </div>
            }
            @if (rough()) {
              <p class="text-xs leading-relaxed text-muted">
                The region gets a margin of {{ calib.margin() }} px to make up for it. For a tighter one, let the laserline view
                fill more of the image and calibrate again.
              </p>
            }
            <span class="font-mono text-2xs text-faint">under {{ roughPx }} px good · over {{ maxPx }} px refused</span>
          } @else {
            <span class="font-mono text-2xs text-faint">no calibration yet · capture one first</span>
          }
        }

        @case ('tilt') {
          <div class="flex flex-col gap-1">
            <h2 class="text-sm font-medium">Level the line</h2>
            <p class="text-xs leading-relaxed text-muted">
              Laserline tilts its line in small steps while the camera films it, until the line runs along the sensor
              {{ axisWord() }} in the image. The line is shown where yours runs.
            </p>
          </div>
          @if (calib.tiltResult(); as r) {
            <div class="grid grid-cols-3 gap-px border border-line bg-line">
              <div class="flex flex-col gap-1 bg-surface px-3 py-2.5">
                <span class="label">tilt</span>
                <span class="font-mono text-lg">{{ signed(r.tilt) }}<span class="text-2xs text-muted"> °</span></span>
                <span class="inline-flex items-center gap-1.5 font-mono text-2xs text-muted">
                  <span class="dot" [class]="calib.tiltApplied() ? 'bg-ok' : 'border border-line-strong'"></span>{{ calib.tiltApplied() ? 'set' : 'to apply' }}
                </span>
              </div>
              <div class="flex flex-col gap-1 bg-surface px-3 py-2.5">
                <span class="label">off axis</span>
                <span class="font-mono text-lg">{{ signed(r.angle, 3) }}<span class="text-2xs text-muted"> °</span></span>
                <span class="font-mono text-2xs text-faint">to the {{ r.axis === 'x' ? 'rows' : 'columns' }}</span>
              </div>
              <div class="flex flex-col gap-1 bg-surface px-3 py-2.5">
                <span class="label">rms</span>
                <span class="font-mono text-lg">{{ r.rms.toFixed(2) }}<span class="text-2xs text-muted"> px</span></span>
                <span class="font-mono text-2xs text-faint">off straight</span>
              </div>
            </div>
            @if (tiltStale()) {
              <span class="font-mono text-2xs text-warn">laserline view resized since the levelling · level again</span>
            }
          }
          @if (calib.levelling()) {
            <div class="flex flex-col gap-2">
              <div class="flex items-baseline gap-2">
                <span class="dot bg-accent animate-pulse"></span>
                <span class="flex-1 font-mono text-2xs text-muted">{{ calib.step() }}</span>
                <span class="font-mono text-xs">{{ percent() }} %</span>
              </div>
              <div class="h-0.5 bg-line"><div class="h-0.5 bg-accent" [style.width.%]="percent()"></div></div>
            </div>
          }
          @if (calib.tiltSamples().length) {
            <table class="w-full border-collapse font-mono text-xs">
              <thead>
                <tr class="border-b border-line">
                  <th class="label h-7 text-left font-normal">Tilt</th>
                  <th class="label h-7 text-right font-normal">In image</th>
                  <th class="label h-7 text-right font-normal">rms</th>
                </tr>
              </thead>
              <tbody>
                @for (t of calib.tiltSamples(); track $index) {
                  @let best = t === bestSample();
                  <tr class="h-8 border-b border-line">
                    <td [class]="best ? 'text-fg' : 'text-muted'">{{ signed(t.tilt) }}°</td>
                    <td class="text-right" [class]="best ? 'text-fg' : 'text-muted'">{{ signed(t.angle, 3) }}°</td>
                    <td class="text-right text-muted">{{ t.rms.toFixed(2) }} px</td>
                  </tr>
                }
              </tbody>
            </table>
          }
          <div class="flex flex-wrap items-center gap-2 border border-line bg-bg px-3 py-2">
            <span class="flex-1 font-mono text-2xs text-muted">
              laserline tilt now {{ calib.currentTilt() === null ? '—' : signed(calib.currentTilt()!) + '°' }}
            </span>
            @if (calib.levelling()) {
              <button type="button" class="btn" (click)="calib.cancel()">Stop</button>
            } @else if (calib.tiltResult()) {
              <button type="button" class="btn" [disabled]="!!calib.blocked()" title="Measure the tilt again" (click)="calib.levelLine()">Level again</button>
            } @else {
              <button type="button" class="btn" title="Keep laserline's tilt and go on" (click)="calib.wizard.set('region')">Skip</button>
            }
          </div>
          @if (calib.tiltError(); as err) {
            <div class="notice-err">{{ err }}</div>
          }
        }

        @case ('region') {
          <div class="flex flex-col gap-1">
            <h2 class="text-sm font-medium">Set the camera region</h2>
            <p class="text-xs leading-relaxed text-muted">Nothing is written until you apply it.</p>
          </div>
          <div class="flex flex-col gap-1.5">
            <span class="label">Region from</span>
            <div class="grid grid-cols-2" role="radiogroup" aria-label="Region from">
              @for (m of modes; track m.key; let first = $first) {
                @let active = calib.regionMode() === m.key;
                <button type="button" role="radio" [attr.aria-checked]="active"
                  class="flex min-h-16 flex-col items-start justify-center gap-1 rounded-none border px-2.5 py-2 text-left transition-colors
                    hover:bg-raised focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
                  [class.-ml-px]="!first" [class]="active ? 'z-10 border-accent bg-raised text-fg' : 'border-line-strong text-muted'"
                  (click)="calib.regionMode.set(m.key); calib.limitsOn.set(m.key === 'travel')">
                  <span class="chrome chrome-tight text-2xs">{{ m.name }}</span>
                  <span class="text-xs normal-case text-muted">{{ m.hint }}</span>
                </button>
              }
            </div>
          </div>

          @if (calib.regionMode() === 'line') {
            @if (calib.proposal(); as p) {
              @if (p.complete) {
                <span class="inline-flex items-center gap-2 font-mono text-2xs">
                  <span class="dot bg-ok"></span>line fits the sensor<span class="text-faint">· margin {{ calib.margin() }} px</span>
                </span>
              } @else {
                <span class="inline-flex items-center gap-2 font-mono text-2xs text-err">
                  <span class="dot bg-err"></span>line leaves the sensor · {{ overflowText() }}
                </span>
                <p class="text-xs leading-relaxed text-muted">Laserline can move the line into the middle of the field and shrink its length and movement.</p>
              }
            } @else {
              <span class="font-mono text-2xs text-faint">{{ link.status() ? 'waiting for laserline’s line' : 'laserline not open · its line decides the region' }}</span>
            }
          } @else {
            @if (calib.travel()) {
              <span class="inline-flex items-center gap-2 font-mono text-2xs">
                <span class="dot bg-ok"></span>sensor part that sees the view<span class="text-faint">· {{ fieldPct() }} % of the view</span>
              </span>
            } @else {
              <span class="font-mono text-2xs text-faint">no calibration for this sensor</span>
            }
          }

          @if (calib.target(); as t) {
            <table class="w-full border-collapse font-mono text-xs">
              <thead>
                <tr class="border-b border-line">
                  <th class="label h-7 text-left font-normal">Feature</th>
                  <th class="label h-7 text-right font-normal">Now</th>
                  <th class="label h-7 text-right font-normal">Proposed</th>
                </tr>
              </thead>
              <tbody>
                @for (r of regionRows(); track r.name) {
                  <tr class="h-8 border-b border-line">
                    <td class="text-muted">{{ r.name }}</td>
                    <td class="text-right text-muted">{{ r.now }}</td>
                    <td class="text-right" [class]="r.changed ? 'text-fg' : 'text-muted'">{{ r.next }}</td>
                  </tr>
                }
              </tbody>
            </table>
          }

          @if (calib.regionMode() === 'line') {
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span class="label">Width</span>
              <div class="inline-flex" role="radiogroup" aria-label="Width">
                @for (o of widthOptions; track o.rows; let first = $first) {
                  @let active = calib.rowsOnly() === o.rows;
                  <button type="button" role="radio" [attr.aria-checked]="active" class="btn rounded-none normal-case tracking-normal"
                    [class.-ml-px]="!first" [class.!border-accent]="active" [class.!text-fg]="active" [class.text-muted]="!active"
                    [class.z-10]="active" [title]="o.title" (click)="calib.rowsOnly.set(o.rows)">{{ o.name }}</button>
                }
              </div>
            </div>
          }
          <div class="flex flex-wrap items-center gap-2 border border-line bg-bg px-3 py-2">
            <span class="flex-1 font-mono text-2xs text-muted">edit it by hand in the region tool instead</span>
            <button type="button" class="btn" [disabled]="!calib.target()" title="Put the proposal into the region editor and close the wizard"
              (click)="toEditor()">To editor</button>
          </div>
        }

        @case ('limits') {
          <div class="flex flex-col gap-1">
            <h2 class="text-sm font-medium">Limit laserline to the region</h2>
            <p class="text-xs leading-relaxed text-muted">
              Laserline keeps the line, its movement and its height inside the region mapped back into its view, so the camera
              always sees the whole line. Its controls stop at these limits until they are released.
            </p>
          </div>
          <div class="inline-flex" role="radiogroup" aria-label="Laserline limits">
            @for (o of limitOptions; track o.on; let first = $first) {
              @let active = calib.limitsOn() === o.on;
              <button type="button" role="radio" [attr.aria-checked]="active" class="btn flex-1 rounded-none normal-case tracking-normal"
                [class.-ml-px]="!first" [class.!border-accent]="active" [class.!text-fg]="active" [class.text-muted]="!active"
                [class.z-10]="active" (click)="calib.limitsOn.set(o.on)">{{ o.name }}</button>
            }
          </div>
          @if (calib.limitsOn()) {
            @if (calib.limitPolygon(); as poly) {
              <div class="flex flex-col gap-1 font-mono text-2xs">
                <span class="text-muted">allowed area · {{ areaText() }} view px</span>
                <span class="text-faint">region {{ targetText() }} less a {{ calib.margin() }} px margin</span>
              </div>
            } @else {
              <span class="font-mono text-2xs text-faint">no region to keep the line in · set one first</span>
            }
          }
          @if (calib.limitResult(); as r) {
            <span class="inline-flex items-start gap-2 font-mono text-2xs leading-relaxed">
              <span class="dot mt-1 shrink-0" [class]="r.clamped.length ? 'bg-warn' : 'bg-ok'"></span>
              @if (r.released) {
                <span class="text-muted">laserline's line is free again</span>
              } @else if (r.clamped.length) {
                <span class="text-muted">laserline keeps the line in the area · clamped {{ r.clamped.join(', ') }}</span>
              } @else {
                <span class="text-muted">laserline keeps the line in the area · nothing had to change</span>
              }
            </span>
          } @else if (calib.limited()) {
            <span class="inline-flex items-center gap-2 font-mono text-2xs text-muted"><span class="dot bg-ok"></span>laserline keeps its line in an area</span>
          }
          @if (calib.limitError(); as err) {
            <div class="notice-err">{{ err }}</div>
          }
        }

        @case ('check') {
          <div class="flex flex-col gap-1">
            <h2 class="text-sm font-medium">Check the line</h2>
            <p class="text-xs leading-relaxed text-muted">
              Let laserline play its movement and watch a few seconds of the stream: every frame should show the whole line.
            </p>
          </div>
          @if (calib.check(); as c) {
            <div class="border border-line">
              <div class="flex h-9 items-center gap-2.5 border-b border-line px-3">
                <span class="dot" [class]="c.frames && c.complete === c.frames ? 'bg-ok' : 'bg-warn'"></span>
                <span class="flex-1 text-xs">Whole line</span>
                <span class="font-mono text-2xs">{{ c.complete }}/{{ c.frames }} <span class="text-faint">frames</span></span>
              </div>
              <div class="flex h-9 items-center gap-2.5 border-b border-line px-3">
                <span class="dot" [class]="c.cut ? 'bg-warn' : 'bg-line-strong'"></span>
                <span class="flex-1 text-xs text-muted">Cut by an edge</span>
                <span class="font-mono text-2xs text-muted">{{ c.cut }}@if (c.edges.length) { · {{ c.edges.join(', ') }}}</span>
              </div>
              <div class="flex h-9 items-center gap-2.5 px-3">
                <span class="dot" [class]="c.none ? 'bg-warn' : 'bg-line-strong'"></span>
                <span class="flex-1 text-xs text-muted">No line</span>
                <span class="font-mono text-2xs text-muted">{{ c.none }}</span>
              </div>
            </div>
          } @else {
            <span class="font-mono text-2xs text-faint">{{ appliedText() }} · not checked yet</span>
          }
          <div>
            <button type="button" class="btn" [disabled]="calib.checking() || !calib.live()" [attr.aria-busy]="calib.checking()"
              [title]="calib.live() ? 'Watch the stream for a few seconds and count frames showing the whole line' : 'Start the live stream first'"
              (click)="calib.checkLine()">{{ calib.checking() ? 'Checking…' : 'Check' }}</button>
          </div>
          <span class="font-mono text-2xs leading-relaxed text-faint">
            the calibration is kept for this camera · calibrate again when the camera or the laserline window moves
          </span>
        }
      }

      @if (calib.note(); as note) {
        <span class="font-mono text-2xs text-warn">{{ note }}</span>
      }
      @if (calib.error(); as err) {
        <div class="notice-err">{{ err }}</div>
      }
    </div>

    <div class="flex min-h-12 flex-wrap items-center gap-2 border-t border-line px-4 py-2">
      <button type="button" class="btn border-transparent text-muted" (click)="close()">{{ step() === 'check' ? 'Close' : 'Cancel' }}</button>
      <span class="flex-1"></span>
      @if (blockedText(); as why) {
        <span class="font-mono text-2xs text-faint mobile:w-full mobile:text-right">{{ why }}</span>
      }
      @if (canBack()) {
        <button type="button" class="btn" (click)="back()">Back</button>
      }
      @if (primary(); as p) {
        <button type="button" class="btn btn-primary min-w-[6.5rem]" [disabled]="p.disabled" [attr.aria-busy]="p.busy" (click)="p.run()">
          {{ p.label }}
        </button>
      }
    </div>
  `,
})
export class LaserWizardComponent {
  readonly calib = inject(LaserCalibrationService);
  readonly link = inject(LaserlineLinkService);

  /** The prepare step's Start live: the live view starts its stream. */
  readonly startLive = output<void>();
  /** The wizard closed; `toEditor` when the region editor should stay open with the proposal. */
  readonly closed = output<{ toEditor: boolean }>();

  readonly steps = WIZARD_STEPS;
  readonly roughPx = RMS_WARN_PX;
  readonly maxPx = MAX_RMS_PX;
  readonly modes = [
    { key: 'travel' as const, name: 'Travel area', hint: 'everywhere a line can go that the camera still sees' },
    { key: 'line' as const, name: 'Current line', hint: 'smallest region holding today’s line and its movement' },
  ];
  readonly widthOptions = [
    { rows: false, name: 'Fit', title: 'Crop rows and columns to the line' },
    { rows: true, name: 'Full', title: 'Crop rows only: the whole sensor width, the frame rate gains the same' },
  ];
  readonly limitOptions = [
    { on: true, name: 'Limit laserline' },
    { on: false, name: 'Leave it free' },
  ];

  readonly step = computed(() => this.calib.wizard() ?? 'prepare');
  readonly running = computed(() => this.calib.phase() === 'running');
  /** A capture or a levelling runs: the steps stay put. */
  readonly busy = computed(() => this.running() || this.calib.levelling());
  readonly usable = computed(() => !!this.calib.calibration() && !this.calib.stale());

  readonly stepper = computed(() => {
    const current = WIZARD_STEPS.indexOf(this.step());
    return WIZARD_STEPS.map((key, i) => {
      const reachable = !this.busy() && key !== 'capture' && (i === 0 || this.usable());
      const isCurrent = i === current;
      return {
        key,
        num: i + 1,
        name: STEP_NAMES[key],
        current: isCurrent,
        done: i < current,
        reachable: reachable || isCurrent,
        cls: isCurrent
          ? 'flex-[3] border-accent text-fg'
          : `flex-1 border-transparent hover:text-fg ${i < current ? 'text-muted' : 'text-faint'}`,
      };
    });
  });
  /** On mobile the steps are a bar; the head says which one this is. */
  readonly mobileCounter = computed(() => WIZARD_STEPS.indexOf(this.step()) + 1);

  readonly linkView = computed(() => {
    const v = this.link.status()?.viewPx;
    return v && v[0] > 0 ? `${v[0]}×${v[1]}` : null;
  });

  readonly percent = computed(() => Math.round(this.calib.progress() * 100));
  readonly fieldPct = computed(() => Math.round((this.calib.fieldShare() ?? 0) * 100));
  readonly rough = computed(() => (this.calib.calibration()?.rms ?? 0) > RMS_WARN_PX);

  /** The capture's patterns and how far each got. */
  readonly rows = computed<Row[]>(() => {
    const plan = this.calib.plan();
    const stage = this.calib.stage();
    const failed = this.calib.phase() === 'failed';
    const order = ['blank', 'white', 'x', 'y', 'solve'] as const;
    const at = stage ? order.indexOf(stage.key) : this.calib.phase() === 'done' ? order.length : -1;
    const bits = (n: number | undefined) => (n ? `${n} bits` : 'stripes');
    const rows: [string, string][] = [
      ['Black', 'blank view'],
      ['White', 'measures the lag'],
      ['Columns', bits(plan?.bitsX)],
      ['Rows', bits(plan?.bitsY)],
      ['Solve', 'screen → sensor'],
    ];
    return rows.map(([name, detail], i) => {
      let state: Row['state'] = i < at || (this.calib.phase() === 'done' && i <= at) ? 'done' : i === at ? 'running' : 'pending';
      if (state === 'running' && !this.running()) {
        state = failed ? 'failed' : 'done';
      }
      if (state === 'running' && stage && (stage.key === 'x' || stage.key === 'y')) {
        const of = stage.key === 'x' ? plan?.bitsX : plan?.bitsY;
        detail = `${stage.bit + 1}/${of} bits`;
      } else if (state === 'failed' && stage && (stage.key === 'x' || stage.key === 'y')) {
        const of = stage.key === 'x' ? plan?.bitsX : plan?.bitsY;
        detail = `stopped at ${stage.bit + 1}/${of}`;
      }
      return { name, detail, state };
    });
  });

  readonly overflowText = computed(() => {
    const p = this.calib.proposal();
    return p ? overflowEdges(p.overflow).map((e) => `${e} ${p.overflow[e]} px`).join(' · ') : '';
  });

  readonly regionRows = computed(() => {
    const now = this.calib.current();
    const next = this.calib.target();
    if (!now || !next) {
      return [];
    }
    return (
      [
        ['OffsetX', 'x'],
        ['OffsetY', 'y'],
        ['Width', 'width'],
        ['Height', 'height'],
      ] as const
    ).map(([name, key]) => ({ name, now: now[key], next: next[key], changed: now[key] !== next[key] }));
  });

  readonly targetText = computed(() => {
    const t = this.calib.target();
    return t ? `${t.width}×${t.height} · ${t.x},${t.y}` : '';
  });
  readonly appliedText = computed(() => {
    const c = this.calib.current();
    return c ? `region ${c.width}×${c.height} · ${c.x},${c.y}${this.calib.limited() ? ' · laserline limited' : ''}` : 'reading region…';
  });
  readonly areaText = computed(() => {
    const p = this.calib.limitPolygon();
    if (!p) {
      return '';
    }
    const xs = p.map((q) => q[0]);
    const ys = p.map((q) => q[1]);
    return `${Math.round(Math.max(...xs) - Math.min(...xs))}×${Math.round(Math.max(...ys) - Math.min(...ys))} at ${Math.round(Math.min(...xs))},${Math.round(Math.min(...ys))}`;
  });

  /** Why the primary action can't run, shown beside it. */
  readonly blockedText = computed(() => {
    switch (this.step()) {
      case 'prepare':
        return this.calib.blocked();
      case 'tilt':
        return this.calib.levelling() ? null : this.calib.blocked();
      case 'region':
        return this.calib.target() && !this.calib.targetApplied() ? this.calib.regionBlocked() : null;
      default:
        return null;
    }
  });

  readonly canBack = computed(() => !this.busy() && this.step() !== 'prepare');

  /** The levelling was measured with another laserline view size. */
  readonly tiltStale = computed(() => {
    const r = this.calib.tiltResult();
    const v = this.link.status()?.viewPx;
    return !!r && !!v && v[0] > 0 && (Math.abs(r.viewPx[0] - v[0]) >= 0.5 || Math.abs(r.viewPx[1] - v[1]) >= 0.5);
  });
  /** The sample closest to level. */
  readonly bestSample = computed(() => {
    const samples = this.calib.tiltSamples();
    return samples.length ? samples.reduce((a, b) => (Math.abs(b.angle) < Math.abs(a.angle) ? b : a)) : null;
  });
  readonly axisWord = computed(() => (this.calib.tiltResult()?.axis ?? this.calib.proposal()?.axis ?? 'x') === 'x' ? 'rows' : 'columns');

  readonly primary = computed<{ label: string; disabled: boolean; busy: boolean; run: () => void } | null>(() => {
    const c = this.calib;
    switch (this.step()) {
      case 'prepare':
        return { label: c.calibration() ? 'Calibrate again' : 'Calibrate', disabled: !!c.blocked(), busy: false, run: () => void c.wizardCalibrate() };
      case 'capture':
        return this.running() || c.phase() !== 'failed'
          ? null
          : { label: 'Retry', disabled: !!c.blocked(), busy: false, run: () => void c.wizardCalibrate() };
      case 'review':
        return { label: 'Next', disabled: !this.usable(), busy: false, run: () => c.wizard.set('tilt') };
      case 'tilt':
        if (c.levelling()) {
          return { label: 'Levelling…', disabled: true, busy: true, run: () => undefined };
        }
        if (!c.tiltResult() || this.tiltStale()) {
          return { label: 'Level', disabled: !!c.blocked(), busy: false, run: () => void c.levelLine() };
        }
        if (!c.tiltApplied()) {
          return { label: c.tilting() ? 'Applying…' : 'Apply tilt', disabled: c.tilting(), busy: c.tilting(), run: () => void this.applyTilt() };
        }
        return { label: 'Next', disabled: false, busy: false, run: () => c.wizard.set('region') };
      case 'region': {
        const p = c.proposal();
        if (c.regionMode() === 'line' && p && !p.complete) {
          return { label: c.fitting() ? 'Fitting…' : 'Fit line', disabled: c.fitting(), busy: c.fitting(), run: () => void c.fitLine() };
        }
        if (c.targetApplied()) {
          return { label: 'Next', disabled: false, busy: false, run: () => c.wizard.set('limits') };
        }
        return {
          label: c.applying() ? 'Applying…' : 'Apply region',
          disabled: !c.target() || c.applying() || !!c.regionBlocked(),
          busy: c.applying(),
          run: () => void this.apply(),
        };
      }
      case 'limits': {
        const send = c.limitsOn() || c.limited();
        return {
          label: c.limiting() ? 'Sending…' : c.limitsOn() ? 'Apply limits' : c.limited() ? 'Release limits' : 'Next',
          disabled: c.limiting() || (c.limitsOn() && !c.limitPolygon()),
          busy: c.limiting(),
          run: () => (send ? void this.sendLimits() : c.wizard.set('check')),
        };
      }
      case 'check':
        return { label: 'Finish', disabled: false, busy: false, run: () => this.finish(false) };
    }
  });

  constructor() {
    // While preparing, notice a laserline window opened by hand.
    effect((onCleanup) => {
      if (this.step() !== 'prepare' || !this.link.supported) {
        return;
      }
      const timer = setInterval(() => void this.link.hello(), LOOK_MS);
      onCleanup(() => clearInterval(timer));
    });
  }

  /** `v` with its sign, `digits` decimals. */
  signed(v: number, digits = 2): string {
    return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(digits);
  }

  dotClass(state: Row['state']): string {
    switch (state) {
      case 'done':
        return 'bg-muted';
      case 'running':
        return 'bg-accent animate-pulse';
      case 'failed':
        return 'bg-err';
      default:
        return 'border border-line-strong';
    }
  }

  back(): void {
    const i = WIZARD_STEPS.indexOf(this.step());
    // Back from the review skips the finished capture.
    const to = this.step() === 'review' ? 'prepare' : WIZARD_STEPS[Math.max(0, i - 1)];
    this.calib.error.set(null);
    this.calib.wizard.set(to);
  }

  close(): void {
    this.finish(false);
  }

  toEditor(): void {
    this.calib.useProposal();
    this.finish(true);
  }

  private async apply(): Promise<void> {
    if (await this.calib.applyTarget()) {
      this.calib.wizard.set('limits');
    }
  }

  private async applyTilt(): Promise<void> {
    if ((await this.calib.applyTilt()) && this.calib.wizard() === 'tilt') {
      this.calib.wizard.set('region');
    }
  }

  private async sendLimits(): Promise<void> {
    if ((await this.calib.applyLimits()) && this.calib.wizard() === 'limits') {
      this.calib.wizard.set('check');
    }
  }

  private finish(toEditor: boolean): void {
    this.calib.closeWizard();
    this.closed.emit({ toEditor });
  }
}

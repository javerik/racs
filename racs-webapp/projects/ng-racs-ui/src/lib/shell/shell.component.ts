import { Component, computed, HostListener, inject, OnDestroy, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map, tap } from 'rxjs';
import {
  clientName,
  type DeviceDiscoverInfo,
  DeviceRegistryService,
  DeviceSelectionService,
  errorMessage,
  RACS_CONFIG,
  type Tool,
  ToolWindowService,
} from 'ng-racs-core';
import { LayoutService } from '../services/layout.service';
import { ThemeService } from '../services/theme.service';
import { IconComponent } from '../shared/icon.component';
import { LayoutSwitchComponent } from '../shared/layout-switch.component';
import { ThemeSwitchComponent } from '../shared/theme-switch.component';
import { ClientNameComponent } from '../shared/client-name.component';
import { ConnectModeComponent } from '../shared/connect-mode.component';

/** How long a failed sidebar action stays reported. */
const ERROR_MS = 8000;

const NAV_COLLAPSED_KEY = 'racs.nav.collapsed';

/**
 * The whole RACS UI around a `<router-outlet>`: the sidebar (desktop, foldable to an icon rail) or
 * the top bar with its menu sheet and the bottom tabs (mobile), with discovery, the connected
 * devices, the tools, the client name, the connect mode and the layout and theme switches. Use it
 * with {@link racsRoutes}.
 */
@Component({
  selector: 'racs-shell',
  standalone: true,
  imports: [CommonModule, RouterOutlet, RouterLink, RouterLinkActive, IconComponent, LayoutSwitchComponent, ThemeSwitchComponent,
    ClientNameComponent, ConnectModeComponent],
  templateUrl: './shell.component.html',
  styleUrl: './shell.component.scss',
})
export class RacsShellComponent implements OnDestroy {
  readonly title = 'RACS';
  readonly selection = inject(DeviceSelectionService);
  readonly registry = inject(DeviceRegistryService);
  readonly layout = inject(LayoutService);
  /** Injected here so the theme applies from startup. */
  readonly theme = inject(ThemeService);
  private readonly router = inject(Router);

  /** The mobile top bar's menu sheet. */
  readonly menuOpen = signal(false);
  /** The desktop sidebar folded into an icon rail. */
  readonly navCollapsed = signal(loadNavCollapsed());

  /** The current path, without query or fragment. */
  private readonly path = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      // A navigation closes the mobile menu.
      tap(() => this.menuOpen.set(false)),
      map((e) => e.urlAfterRedirects.split(/[?#]/)[0]),
    ),
    { initialValue: '' },
  );

  /** What the mobile top bar names: the page, or the open device. */
  readonly pageTitle = computed(() => {
    const path = this.path();
    if (path.startsWith('/device-discovery')) {
      return 'Discovery';
    }
    if (path.startsWith('/device')) {
      const id = this.selection.selectedDeviceId();
      return id === null ? 'Device' : `Device #${id}`;
    }
    return '';
  });

  readonly nav = [
    // Lists the devices found by the last discovery beneath it.
    { path: '/device-discovery', label: 'Discovery', devices: false },
    // Lists the connected devices beneath it, and stays active on /device/:id.
    { path: '/device', label: 'Device', devices: true },
  ];

  /**
   * Standalone web apps bundled into the web root (see scripts/build-laserline.sh), each opened
   * in a window of its own beside RACS. `href` is relative to the base href.
   */
  readonly config = inject(RACS_CONFIG);
  readonly tools = this.config.tools;
  /** Focuses a tool's open window instead of reloading it on the next click. */
  private readonly toolWindows = inject(ToolWindowService);

  /** The last sidebar connect, disconnect or discovery that failed. */
  readonly actionError = signal<string | null>(null);
  private errorTimer: ReturnType<typeof setTimeout> | undefined;

  @HostListener('document:keydown.escape')
  closeMenu(): void {
    this.menuOpen.set(false);
  }

  ngOnDestroy(): void {
    clearTimeout(this.errorTimer);
  }

  toggleNav(): void {
    const collapsed = !this.navCollapsed();
    this.navCollapsed.set(collapsed);
    try {
      localStorage.setItem(NAV_COLLAPSED_KEY, String(collapsed));
    } catch {
      // Remembering the sidebar is a convenience only.
    }
  }

  /**
   * Opens the tool in its own window, or brings an already open one to the front without
   * reloading it (it may hold work). A click with a modifier is left to the browser.
   */
  openTool(tool: Tool, event: MouseEvent): void {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    this.menuOpen.set(false);
    this.toolWindows.open(tool);
  }

  discover(): void {
    this.reportError(null);
    this.registry.discover().subscribe({ error: (e) => this.reportError(e) });
  }

  connect(dev: DeviceDiscoverInfo): void {
    this.reportError(null);
    this.registry.connect(dev).subscribe({
      // Straight to the device, as from the Discovery page.
      next: () => this.router.navigate(['/device', dev.id]),
      error: (e) => this.reportError(e),
    });
  }

  /**
   * Leaves the device's page first when it is open: that closes its live stream, so the camera
   * is released cleanly rather than taken away from under the stream.
   */
  async disconnect(dev: DeviceDiscoverInfo): Promise<void> {
    this.reportError(null);
    if (this.selection.selectedDeviceId() === dev.id) {
      this.selection.setSelectedDeviceId(null);
    }
    if (this.router.url.split(/[?#]/)[0] === `/device/${dev.id}`) {
      const next = this.registry.connected().find((d) => d.id !== dev.id);
      await this.router.navigate(next ? ['/device', next.id] : ['/device-discovery']);
    }
    this.registry.disconnect(dev).subscribe({ error: (e) => this.reportError(e) });
  }

  /** ` · ro-shared · held by line-script` for a device another client has locked, else empty. */
  lockTitle(id: number): string {
    const access = this.registry.access(id);
    return access && this.registry.lockedByOther(id) ? ` · ${access.mode} · held by ${clientName(access.owner)}` : '';
  }

  private reportError(e: unknown): void {
    clearTimeout(this.errorTimer);
    if (e === null) {
      this.actionError.set(null);
      return;
    }
    this.actionError.set(errorMessage(e));
    this.errorTimer = setTimeout(() => this.actionError.set(null), ERROR_MS);
  }
}

function loadNavCollapsed(): boolean {
  try {
    return localStorage.getItem(NAV_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

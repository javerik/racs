import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { CommonModule, Location } from '@angular/common';
import { Router, RouterLink } from '@angular/router';
import {
  closedMessage,
  type DeviceDiscoverInfo,
  DeviceRegistryService,
  DeviceSelectionService,
  errorMessage,
  GenicamSession,
  pinsKey,
  RoiSession,
  SessionService,
} from 'ng-racs-core';
import { LayoutService } from '../../services/layout.service';
import { DeviceBurstComponent } from '../device-burst/device-burst.component';
import { DeviceCloudComponent } from '../device-cloud/device-cloud.component';
import { DeviceConfigurationComponent } from '../device-configuration/device-configuration.component';
import { DeviceLiveViewComponent } from '../device-live-view/device-live-view.component';
import { EssentialsComponent } from '../quick-settings/essentials.component';
import { QuickSettingsComponent } from '../quick-settings/quick-settings.component';
import { IconComponent } from '../../shared/icon.component';
import { DeviceAccessComponent } from './device-access.component';

type AcquisitionTab = 'live' | 'burst' | 'cloud';

const TABS: readonly AcquisitionTab[] = ['live', 'burst', 'cloud'];

type SideTab = 'quick' | 'features';

const SIDE_TABS: readonly SideTab[] = ['quick', 'features'];

const TAB_KEY = 'racs.workspace.tab';
const SIDE_TAB_KEY = 'racs.workspace.sideTab';
const FEATURES_MINIMIZED_KEY = 'racs.workspace.featuresMinimized';

@Component({
  selector: 'racs-device-workspace',
  standalone: true,
  imports: [
    CommonModule,
    RouterLink,
    DeviceBurstComponent,
    DeviceCloudComponent,
    DeviceConfigurationComponent,
    DeviceLiveViewComponent,
    EssentialsComponent,
    QuickSettingsComponent,
    IconComponent,
    DeviceAccessComponent,
  ],
  // One session per workspace: the quick settings and both feature-tree views share its values
  // and its request queue.
  providers: [GenicamSession, RoiSession],
  templateUrl: './device-workspace.component.html',
  styleUrl: './device-workspace.component.scss',
})
export class DeviceWorkspaceComponent {
  readonly selection = inject(DeviceSelectionService);
  readonly registry = inject(DeviceRegistryService);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  readonly session = inject(GenicamSession);
  readonly layout = inject(LayoutService);
  private readonly clientSession = inject(SessionService);

  /** The `:id` route parameter; absent on plain `/device`. */
  readonly id = input<string>();
  /** The `features` query parameter: `max` shows every GenICam feature full screen. */
  readonly features = input<string>();

  readonly maximized = computed(() => this.features() === 'max');
  /** The overlay was opened from this page, so closing it can just go back in history. */
  private openedHere = false;

  readonly tabs: { id: AcquisitionTab; label: string; title: string }[] = [
    { id: 'live', label: 'Live', title: 'Live image stream' },
    { id: 'burst', label: 'Burst', title: 'Capture a series of frames' },
    { id: 'cloud', label: '3D', title: 'Profiles as a point cloud (Linescan3D)' },
  ];
  readonly tab = signal<AcquisitionTab>(loadTab());

  readonly sideTabs: { id: SideTab; label: string; title: string }[] = [
    { id: 'quick', label: 'Quick', title: 'The settings used day to day, and pinned features' },
    { id: 'features', label: 'All features', title: 'Every GenICam feature of the camera' },
  ];
  /** What the settings column shows on desktop. */
  readonly sideTab = signal<SideTab>(loadSideTab());
  /** The settings column folded into a bar, giving the acquisition view the width. */
  readonly featuresMinimized = signal(loadFeaturesMinimized());

  /** Beside the acquisition column on wide desktops; on mobile everything is one column. */
  readonly gridColumns = computed(() => {
    if (this.layout.isMobile()) {
      return '';
    }
    return this.featuresMinimized()
      ? 'xl:grid-cols-[minmax(0,1fr)_2.25rem]'
      : 'xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]';
  });

  readonly deviceId = computed(() => {
    const raw = this.id();
    const parsed = raw === undefined ? NaN : Number(raw);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
  });

  readonly device = computed(() => {
    const id = this.deviceId();
    return id === null ? undefined : this.registry.connected().find((d) => d.id === id);
  });

  readonly reconnecting = computed(() => {
    const id = this.deviceId();
    return id !== null && this.registry.busy().has(id);
  });
  readonly reconnectError = signal<string | null>(null);

  /** Why the device is not connected any more, when this tab saw it close. */
  readonly closedReason = computed(() => {
    const id = this.deviceId();
    const closed = id === null ? null : this.registry.closedReason(id);
    return closed ? closedMessage(closed.reason, closed.by, this.clientSession.clientId()) : null;
  });

  /**
   * What the page can show:
   * - `checking`: the connected list has not arrived yet
   * - `none`: no id and nothing to fall back to
   * - `missing`: the id is not (or no longer) connected
   * - `ready`
   */
  readonly state = computed(() => {
    if (!this.registry.loaded()) {
      return 'checking';
    }
    if (this.deviceId() === null) {
      return 'none';
    }
    return this.device() ? 'ready' : 'missing';
  });

  constructor() {
    // Nothing is loaded before the connected list says the device is there (effect below).
    this.session.present.set(false);

    // The URL is the source of truth for which device is open, so a reload or a shared link
    // lands on the same device.
    effect(() => {
      const id = this.deviceId();
      if (id !== null) {
        untracked(() => this.selection.setSelectedDeviceId(id));
      }
    });

    // The GenICam views disable what this client may not do (read-only, locked).
    effect(() => {
      const id = this.deviceId();
      const access = id === null ? null : this.registry.access(id);
      const present = this.state() === 'ready';
      untracked(() => {
        this.session.present.set(present);
        this.session.access.set(access);
      });
    });

    // A device worked with here is joined again if the session has to be renewed.
    effect(() => {
      const id = this.deviceId();
      if (id !== null && this.device()) {
        untracked(() => this.clientSession.markJoined(id));
      }
    });

    // Pins are kept per camera model, so identical cameras share them.
    effect(() => {
      const dev = this.device();
      untracked(() => this.session.setPinScope(dev ? pinsKey(dev.vendor, dev.model) : null));
    });

    // Plain `/device`: go to the selected device, or the first connected one.
    effect(() => {
      if (this.id() !== undefined) {
        return;
      }
      const selected = this.selection.selectedDeviceId();
      const fallback = selected ?? this.registry.connected()[0]?.id ?? null;
      if (fallback !== null) {
        untracked(() =>
          this.router.navigate(['/device', fallback], { replaceUrl: true }),
        );
      }
    });
  }

  /**
   * Connect the missing device again by its id: the server remembers where it was connected,
   * also for a device it found by address or IP rather than by discovery.
   */
  reconnect(): void {
    const id = this.deviceId();
    if (id === null) {
      return;
    }
    this.reconnectError.set(null);
    this.registry.connect({ id } as DeviceDiscoverInfo, undefined, 'shared').subscribe({
      error: (e) => this.reconnectError.set(errorMessage(e)),
    });
  }

  selectTab(tab: AcquisitionTab): void {
    this.tab.set(tab);
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      // Remembering the tab is a convenience only.
    }
  }

  selectSideTab(tab: SideTab): void {
    this.sideTab.set(tab);
    try {
      localStorage.setItem(SIDE_TAB_KEY, tab);
    } catch {
      // Remembering the tab is a convenience only.
    }
  }

  setFeaturesMinimized(minimized: boolean): void {
    this.featuresMinimized.set(minimized);
    try {
      localStorage.setItem(FEATURES_MINIMIZED_KEY, String(minimized));
    } catch {
      // Remembering the layout is a convenience only.
    }
  }

  /**
   * The full feature list, over the workspace rather than in place of it: the live stream keeps
   * running underneath, so settings changed there still apply live. In the URL, so a reload or
   * Back works as expected.
   */
  openMaximized(): void {
    this.openedHere = true;
    this.router.navigate([], { queryParams: { features: 'max' }, queryParamsHandling: 'merge' });
  }

  closeMaximized(): void {
    if (this.openedHere) {
      this.openedHere = false;
      this.location.back();
      return;
    }
    this.router.navigate([], { queryParams: { features: null }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  openDevice(value: string): void {
    this.router.navigate(['/device', value]);
  }
}

function loadTab(): AcquisitionTab {
  try {
    const tab = localStorage.getItem(TAB_KEY) as AcquisitionTab | null;
    return tab && TABS.includes(tab) ? tab : 'live';
  } catch {
    return 'live';
  }
}

function loadSideTab(): SideTab {
  try {
    const tab = localStorage.getItem(SIDE_TAB_KEY) as SideTab | null;
    return tab && SIDE_TABS.includes(tab) ? tab : 'quick';
  } catch {
    return 'quick';
  }
}

function loadFeaturesMinimized(): boolean {
  try {
    return localStorage.getItem(FEATURES_MINIMIZED_KEY) === 'true';
  } catch {
    return false;
  }
}

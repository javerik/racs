import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import {
  clientName,
  type DeviceConnections,
  type DeviceDiscoverInfo,
  DeviceRegistryService,
  DeviceSelectionService,
  errorMessage,
  SessionService,
} from 'ng-racs-core';
import { LayoutService } from '../services/layout.service';
import { ConnectModeComponent } from '../shared/connect-mode.component';
import { IconComponent } from '../shared/icon.component';

@Component({
  selector: 'racs-device-discovery',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, ConnectModeComponent, IconComponent],
  templateUrl: './discovery.component.html',
  styleUrl: './discovery.component.scss',
})
export class DeviceDiscoveryComponent implements OnInit {
  readonly registry = inject(DeviceRegistryService);
  private readonly router = inject(Router);
  readonly selection = inject(DeviceSelectionService);
  readonly layout = inject(LayoutService);
  private readonly session = inject(SessionService);

  readonly error = signal<string | null>(null);
  readonly ipHint = signal<Record<number, string>>({});
  /** Mobile cards whose optional connect-via-IP field is shown. */
  readonly viaIpOpen = signal<ReadonlySet<number>>(new Set());

  /** `ro-shared · held by line-script`, `shared`; `null` while unknown. */
  accessLine(id: number): string | null {
    const access = this.registry.access(id);
    if (!access) {
      return null;
    }
    return access.owner ? `${access.mode} · held by ${clientName(access.owner, this.session.clientId())}` : access.mode;
  }

  ngOnInit(): void {
    this.refresh();
  }

  setIpHint(deviceId: number, value: string): void {
    this.ipHint.update((m) => ({ ...m, [deviceId]: value }));
  }

  openViaIp(deviceId: number): void {
    this.viaIpOpen.update((open) => new Set(open).add(deviceId));
  }

  ipFor(deviceId: number): string {
    return this.ipHint()[deviceId] ?? '';
  }

  refresh(): void {
    this.error.set(null);
    this.registry.discover().subscribe({
      next: (d) => this.syncActiveAfterRefresh(d),
      error: (e) => this.error.set(errorMessage(e)),
    });
  }

  private syncActiveAfterRefresh(d: DeviceConnections): void {
    const active = this.selection.selectedDeviceId();
    if (d.connected.length === 1 && active === null) {
      this.selection.setSelectedDeviceId(d.connected[0].id);
      return;
    }
    if (active === null) {
      return;
    }
    const still = d.connected.some((c) => c.id === active);
    if (still) {
      return;
    }
    if (d.connected.length > 0) {
      this.selection.setSelectedDeviceId(null);
    }
  }

  connect(dev: DeviceDiscoverInfo): void {
    this.error.set(null);
    const ip = this.ipFor(dev.id).trim() || undefined;
    this.registry.connect(dev, ip).subscribe({
      // Straight to the device: connecting is almost always done in order to use it.
      next: () => this.router.navigate(['/device', dev.id]),
      error: (e) => this.error.set(errorMessage(e)),
    });
  }

  disconnect(dev: DeviceDiscoverInfo): void {
    this.error.set(null);
    this.registry.disconnect(dev).subscribe({
      next: () => {
        if (this.selection.selectedDeviceId() === dev.id) {
          this.selection.setSelectedDeviceId(null);
        }
      },
      error: (e) => this.error.set(errorMessage(e)),
    });
  }

  selectActive(dev: DeviceDiscoverInfo): void {
    this.router.navigate(['/device', dev.id]);
  }

  isActive(dev: DeviceDiscoverInfo): boolean {
    return this.selection.selectedDeviceId() === dev.id;
  }
}

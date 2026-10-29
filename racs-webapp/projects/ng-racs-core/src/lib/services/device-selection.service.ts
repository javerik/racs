import { Injectable, signal } from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class DeviceSelectionService {
  private readonly _selectedDeviceId = signal<number | null>(null);

  /** Selected device API id for Configuration and Snapshot. */
  readonly selectedDeviceId = this._selectedDeviceId.asReadonly();

  setSelectedDeviceId(id: number | null): void {
    this._selectedDeviceId.set(id);
  }
}

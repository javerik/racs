import { Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { EMPTY, Observable, Subject, merge, timer } from 'rxjs';
import { catchError, debounceTime, distinctUntilChanged, filter, finalize, switchMap, tap } from 'rxjs/operators';
import { RacsService } from './racs.service';
import { ServerEventsService, type ClosedDevice } from './server-events.service';
import { SessionService } from './session.service';
import type {
  AccessMode,
  ConnectedDevice,
  DeviceAccess,
  DeviceConnections,
  DeviceDiscoverInfo,
  DeviceState,
} from '../models/racs.models';

/** How often the connected list is re-read while the events socket is down. Cheap: no discovery. */
const POLL_MS = 3000;
/** The slower fallback poll while events keep the list current. */
const POLL_WITH_EVENTS_MS = 15_000;
/** Events often come in bursts (a connect, then its lease): one re-read for them. */
const EVENT_REFRESH_MS = 100;
/** localStorage: the mode Discovery and the sidebar connect with. */
export const CONNECT_MODE_KEY = 'racs.connect.mode';
const MODES: readonly AccessMode[] = ['shared', 'ro-shared', 'exclusive'];

/**
 * The devices the server is connected to, kept current for the sidebar and the workspace, and
 * the result of the last network discovery, shared by the sidebar and the Discovery page.
 *
 * Other clients (and other tabs) connect, disconnect and lock devices too. The list is re-read
 * when the events socket reports such a change (`device_state`, `access_revoked`, `resync`) and
 * after this tab's own {@link connect}/{@link disconnect}; a poll stays as the fallback, slower
 * while the events socket is up. Discovery broadcasts on the network, so it only runs on request
 * ({@link discover}).
 *
 * Each connected device carries its `access` as this client sees it (`you`, the owner, the
 * holder); the live parts (viewers, stream, burst) come from the events.
 */
@Injectable({
  providedIn: 'root',
})
export class DeviceRegistryService {
  private readonly racs = inject(RacsService);
  private readonly events = inject(ServerEventsService);
  private readonly session = inject(SessionService);
  private readonly refresh$ = new Subject<void>();
  private readonly eventRefresh$ = new Subject<void>();

  private readonly _connected = signal<ConnectedDevice[]>([]);
  private readonly _loaded = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _discovered = signal<DeviceDiscoverInfo[] | null>(null);
  private readonly _discovering = signal(false);
  private readonly _busy = signal<ReadonlySet<number>>(new Set());

  readonly connected = this._connected.asReadonly();
  /** False until the first answer, so "nothing connected" is not shown while still asking. */
  readonly loaded = this._loaded.asReadonly();
  readonly error = this._error.asReadonly();
  readonly ids = computed(() => new Set(this._connected().map((d) => d.id)));
  /** False until the first discovery has finished. */
  readonly discovered = computed(() => this._discovered() !== null);
  /** Devices found by the last discovery that are not connected now. */
  readonly available = computed(() => {
    const connected = this.ids();
    return (this._discovered() ?? []).filter((d) => !connected.has(d.id));
  });
  readonly discovering = this._discovering.asReadonly();
  /** Devices with a connect or disconnect in flight. */
  readonly busy = this._busy.asReadonly();
  /** The mode Discovery and the sidebar connect with, kept in `racs.connect.mode`. */
  readonly connectMode = signal<AccessMode>(loadMode());

  constructor() {
    const poll = toObservable(this.events.connected).pipe(
      distinctUntilChanged(),
      switchMap((up) => timer(0, up ? POLL_WITH_EVENTS_MS : POLL_MS)),
    );
    merge(poll, this.refresh$, this.eventRefresh$.pipe(debounceTime(EVENT_REFRESH_MS)))
      .pipe(
        // A refresh supersedes a poll still in flight, so a connect shows up right away.
        switchMap(() =>
          this.racs.getConnectedDevices().pipe(
            catchError(() => {
              this._error.set('Server unreachable');
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((devices) => this.applyConnected(devices));

    this.events.events$
      .pipe(
        filter(
          (e) =>
            (e.type === 'device_state' && e.cause !== 'stream' && e.cause !== 'burst') ||
            e.type === 'access_revoked',
        ),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.eventRefresh$.next());
    this.events.resync$.pipe(takeUntilDestroyed()).subscribe(() => this.eventRefresh$.next());
  }

  refresh(): void {
    this.refresh$.next();
  }

  /** Runs a network discovery. Errors are passed on; the previous result stays. */
  discover(): Observable<DeviceConnections> {
    this._discovering.set(true);
    return this.racs.getDevices().pipe(
      tap((d) => {
        this._discovered.set([...d.available].sort((a, b) => a.id - b.id));
        // `GET /devices` lists no access: keep what is known and read it again.
        const known = new Map(this._connected().map((c) => [c.id, c.access]));
        this.applyConnected(d.connected.map((c) => ({ ...c, access: known.get(c.id) })));
        this.refresh();
      }),
      finalize(() => this._discovering.set(false)),
    );
  }

  /** Connect with {@link connectMode} unless another mode is given. */
  connect(dev: DeviceDiscoverInfo, ip?: string, mode: AccessMode = this.connectMode()): Observable<DeviceAccess> {
    this.session.markJoined(dev.id);
    return this.track(dev.id, this.racs.connectDevice(dev.id, ip, mode));
  }

  /**
   * Leave the device; it closes once nobody else uses it. It goes back to the discovered list:
   * it was reachable a moment ago, and rescanning just to show it again would broadcast on the
   * network.
   */
  disconnect(dev: DeviceDiscoverInfo): Observable<unknown> {
    this.session.markLeft(dev.id);
    return this.track(dev.id, this.racs.disconnectDevice(dev.id)).pipe(
      tap((r) => {
        if (r.closed) {
          this._discovered.update((list) =>
            list?.some((d) => d.id === dev.id) ? list : [...(list ?? []), dev].sort((a, b) => a.id - b.id),
          );
        }
      }),
    );
  }

  /** Take or change the lease of device `id`; `shared` gives it up. */
  setAccess(id: number, mode: AccessMode, force = false): Observable<DeviceAccess> {
    return this.track(id, this.racs.setAccess(id, mode, force));
  }

  /** Release this client's lease, or with `force` another's. */
  release(id: number, force = false): Observable<DeviceAccess> {
    return this.track(id, this.racs.releaseAccess(id, force));
  }

  setConnectMode(mode: AccessMode): void {
    this.connectMode.set(mode);
    try {
      localStorage.setItem(CONNECT_MODE_KEY, mode);
    } catch {
      // Not kept.
    }
  }

  /**
   * Device `id`'s access as this client sees it, with the viewer count and holder kept current
   * by the events. `null` while unknown.
   */
  access(id: number): DeviceAccess | null {
    const base = this._connected().find((d) => d.id === id)?.access;
    if (!base) {
      return null;
    }
    const state = this.events.deviceStates().get(id);
    if (!state) {
      return base;
    }
    const holder = state.stream
      ? { kind: 'live' as const, client_id: base.holder?.kind === 'live' ? base.holder.client_id : null }
      : state.burst
        ? { kind: 'burst' as const, client_id: state.burst.client_id }
        : null;
    return { ...base, holder, viewers: state.stream?.viewers ?? 0 };
  }

  /** The running live capture of device `id`, per the events; `null` when none runs (or unknown). */
  streamState(id: number): DeviceState['stream'] {
    return this.events.deviceStates().get(id)?.stream ?? null;
  }

  /** Why device `id` was closed, if it was since this tab started. */
  closedReason(id: number): ClosedDevice | null {
    return this.events.closed().get(id) ?? null;
  }

  /** Another client holds device `id`'s lease, so this one can't write (or use) it. */
  lockedByOther(id: number): boolean {
    const access = this.access(id);
    return !!access && access.mode !== 'shared' && access.you !== 'owner';
  }

  isBusy(id: number): boolean {
    return this._busy().has(id);
  }

  private track<T>(id: number, request: Observable<T>): Observable<T> {
    this._busy.update((s) => new Set(s).add(id));
    return request.pipe(
      tap(() => this.refresh()),
      finalize(() =>
        this._busy.update((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        }),
      ),
    );
  }

  private applyConnected(devices: ConnectedDevice[]): void {
    const sorted = [...devices].sort((a, b) => a.id - b.id);
    // Keep the old array when nothing changed, so the sidebar does not re-render every poll.
    if (!sameDevices(this._connected(), sorted)) {
      this._connected.set(sorted);
    }
    this._loaded.set(true);
    this._error.set(null);
  }

  isConnected(id: number): boolean {
    return this.ids().has(id);
  }

  find(id: number): ConnectedDevice | undefined {
    return this._connected().find((d) => d.id === id);
  }
}

function sameDevices(a: ConnectedDevice[], b: ConnectedDevice[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (d, i) =>
        d.id === b[i].id &&
        d.ip === b[i].ip &&
        d.model === b[i].model &&
        JSON.stringify(d.access) === JSON.stringify(b[i].access),
    )
  );
}

function loadMode(): AccessMode {
  try {
    const mode = localStorage.getItem(CONNECT_MODE_KEY) as AccessMode | null;
    return mode && MODES.includes(mode) ? mode : 'shared';
  } catch {
    return 'shared';
  }
}

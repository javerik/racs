import { computed, DestroyRef, inject, Injectable, signal, type WritableSignal } from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { catchError, concatMap, distinctUntilChanged, EMPTY, finalize, Observable, skip, Subject, tap } from 'rxjs';
import type { DeviceAccess, FeatureState, GenICamNodeCategory, GenICamNodeInfo } from '../models/racs.models';
import { canRead, canWrite, clientName, readOnlyReason, refusalMessage, refusalOf } from '../access';
import { ServerEventsService } from './server-events.service';
import { SessionService } from './session.service';
import { dependentsOf } from '../genicam/feature-tree';
import { loadPins, savePins } from '../genicam/quick-settings';
import { DeviceSelectionService } from './device-selection.service';
import { RacsService } from './racs.service';

/** What holds the camera exclusively: a live stream takes feature requests, a burst refuses them. */
export type CameraHolder = 'live' | 'burst' | null;

/** A queued device request. `gen` ties it to the device load it was issued for. */
interface Op {
  gen: number;
  run: () => Observable<unknown>;
  /** Called instead of `run` when the device changed before the op's turn. */
  skip?: () => void;
}

/** Most names per state request; the server takes up to 256. */
export const READ_BATCH = 64;
const POLL_MS = 5000;
/** How long the hint about another client's change stays in the panel heads. */
export const REMOTE_HINT_MS = 6000;

/**
 * GenICam values and state of the selected device, shared by every view of it (the quick
 * settings and the full feature tree, compact or maximized), so they show the same values and
 * send their requests through one queue.
 *
 * The queue is serial because outside a live stream every request checks the camera out, and the
 * server refuses a second checkout as busy. Provide it on the device workspace, not in root: it
 * resets when the device changes and lives as long as the workspace.
 */
@Injectable()
export class GenicamSession {
  private readonly selection = inject(DeviceSelectionService);
  private readonly racs = inject(RacsService);

  readonly deviceId = this.selection.selectedDeviceId;
  readonly categories = signal<GenICamNodeCategory[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  /** Last state read from the device, per feature. */
  readonly states = signal<Partial<Record<string, FeatureState>>>({});
  /** Reads queued or in flight, per feature (a count). */
  readonly pendingReads = signal<ReadonlyMap<string, number>>(new Map());
  /** Writes and commands queued or in flight, per feature (a count). */
  readonly savingNodes = signal<ReadonlyMap<string, number>>(new Map());
  /** The last write/command error per feature, cleared by the next success. */
  readonly nodeErrors = signal<Partial<Record<string, string>>>({});
  readonly holder = signal<CameraHolder>(null);
  /**
   * This client's access to the device (specs/multi-user.md §3), pushed in by the workspace from
   * the registry. `null` while unknown, which counts as `shared`.
   */
  readonly access = signal<DeviceAccess | null>(null);
  /**
   * The device is in the connected list. While it isn't (closed by someone, or idle), nothing is
   * loaded or read: every device request connects the device again, which would undo the close.
   * The workspace sets it; without one (the specs) the device counts as present.
   */
  readonly present = signal(true);
  readonly role = computed(() => this.access()?.you ?? 'writer');
  readonly canWrite = computed(() => canWrite(this.role()));
  /** `read-only · held by <name>` (or `locked · …`) when this client may not write. */
  readonly readOnlyReason = computed(() => readOnlyReason(this.access()));
  /** Nothing may be written right now: a burst holds the camera, or this client may only read. */
  readonly writeBlocked = computed(() => this.holder() === 'burst' || !this.canWrite());
  /** The last change another client made (`ExposureTime · changed by line-script`), for a while. */
  readonly remoteChange = signal<string | null>(null);
  private remoteTimer: ReturnType<typeof setTimeout> | null = null;
  /** Expanded categories of the feature tree, kept here so they survive maximizing it. */
  readonly expanded = signal<ReadonlySet<string>>(new Set());
  /** Features pinned to the quick settings, for the current camera model. */
  readonly pins = signal<readonly string[]>([]);
  private pinKey: string | null = null;

  /** Every feature by name (first occurrence across categories). */
  readonly nodes = computed(() => {
    const map = new Map<string, GenICamNodeInfo>();
    for (const cat of this.categories()) {
      for (const node of cat.nodes) {
        if (!map.has(node.name)) {
          map.set(node.name, node);
        }
      }
    }
    return map;
  });

  readonly busy = computed(() => this.pendingReads().size > 0 || this.savingNodes().size > 0);

  private readonly watchers = signal<ReadonlyMap<string, readonly string[]>>(new Map());
  /** Features some view currently shows; they are what a write refreshes. */
  readonly watched = computed(() => {
    const all = new Set<string>();
    for (const names of this.watchers().values()) {
      for (const name of names) {
        all.add(name);
      }
    }
    return all;
  });

  private readonly ops = new Subject<Op>();
  private gen = 0;
  /** Known values that may be outdated; re-read once shown. */
  private readonly stale = new Set<string>();
  /** Names collected for the next state request, sent once the current task is done. */
  private batch = new Set<string>();
  private flushScheduled = false;
  /** Writes queued but not started, so a newer value can replace theirs (slider drags). */
  private readonly queuedWrites = new Map<string, { value: string }>();
  private polled: readonly string[] = [];

  constructor() {
    // A device that isn't connected is not loaded: even its metadata would connect it again.
    toObservable(computed(() => (this.present() ? this.selection.selectedDeviceId() : null)))
      .pipe(distinctUntilChanged(), takeUntilDestroyed())
      .subscribe((id) => this.loadDevice(id));

    this.ops
      .pipe(
        concatMap((op) => {
          if (op.gen === this.gen) {
            return op.run().pipe(catchError(() => EMPTY));
          }
          op.skip?.();
          return EMPTY;
        }),
        takeUntilDestroyed(),
      )
      .subscribe();

    const timer = setInterval(() => this.poll(), POLL_MS);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      if (this.remoteTimer !== null) {
        clearTimeout(this.remoteTimer);
      }
    });

    const events = inject(ServerEventsService);
    const session = inject(SessionService);
    events.events$.pipe(takeUntilDestroyed()).subscribe((e) => {
      if ((e.type !== 'feature_changed' && e.type !== 'command_executed') || e.device !== this.deviceId()) {
        return;
      }
      if (e.by && e.by.client_id === session.clientId()) {
        return; // this tab's own change, refreshed already
      }
      if (e.type === 'feature_changed') {
        this.refreshAfterWrite(e.feature);
        this.showRemoteChange(`${e.feature} · changed by ${clientName(e.by)}`);
      } else {
        this.refreshAfterCommand();
        this.showRemoteChange(`${e.command} · executed by ${clientName(e.by)}`);
      }
    });
    // Events were lost (or the socket reconnected): anything shown may be outdated.
    events.resync$.pipe(takeUntilDestroyed()).subscribe(() => this.refreshAfterCommand());
    // Reads come back when a lock that kept this client out ends.
    toObservable(computed(() => this.present() && canRead(this.role())))
      .pipe(distinctUntilChanged(), skip(1), takeUntilDestroyed())
      .subscribe((readable) => {
        if (readable) {
          this.refreshAfterCommand();
        }
      });
  }

  reload(): void {
    this.loadDevice(this.deviceId());
  }

  value(name: string): string | undefined {
    return this.states()[name]?.value ?? undefined;
  }

  /** `owner` shows `names`: read what isn't known yet, and refresh them after writes. */
  watch(owner: string, names: readonly string[]): void {
    const next = new Map(this.watchers());
    next.set(owner, names);
    this.watchers.set(next);
    this.read(names);
  }

  unwatch(owner: string): void {
    const next = new Map(this.watchers());
    if (next.delete(owner)) {
      this.watchers.set(next);
    }
  }

  /**
   * Status features re-read every few seconds, only while a live stream holds the camera: then
   * reads are answered inside the stream, while outside one they would compete for checkouts
   * with "Start live".
   */
  setPolled(names: readonly string[]): void {
    this.polled = names;
  }

  /** Load and from now on save pins under `key` (see `pinsKey`); `null` while the model is unknown. */
  setPinScope(key: string | null): void {
    if (key === this.pinKey) {
      return;
    }
    this.pinKey = key;
    this.pins.set(key ? loadPins(key) : []);
  }

  togglePin(name: string): void {
    const pins = this.pins();
    const next = pins.includes(name) ? pins.filter((p) => p !== name) : [...pins, name];
    this.pins.set(next);
    if (this.pinKey) {
      savePins(this.pinKey, next);
    }
  }

  toggleExpanded(category: string): void {
    const next = new Set(this.expanded());
    if (!next.delete(category)) {
      next.add(category);
    }
    this.expanded.set(next);
  }

  setExpanded(categories: Iterable<string>): void {
    this.expanded.set(new Set(categories));
  }

  /**
   * Queue state reads for `names`. Without `force`, features with a current state (or a read on
   * the way) are skipped. Names asked for in the same task go out as one request.
   */
  read(names: Iterable<string>, force = false): void {
    // A client locked out (`meta` on an `exclusive` device) would only be refused.
    if (this.deviceId() === null || !this.present() || !canRead(this.role())) {
      return;
    }
    const nodes = this.nodes();
    const pending = this.pendingReads();
    const added: string[] = [];
    for (const name of names) {
      if (!nodes.has(name) || this.batch.has(name)) {
        continue;
      }
      const known = this.states()[name] !== undefined && !this.stale.has(name);
      if (pending.has(name) || (!force && known)) {
        continue;
      }
      this.stale.delete(name);
      this.batch.add(name);
      added.push(name);
    }
    if (added.length === 0) {
      return;
    }
    this.adjust(this.pendingReads, added, +1);
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  private flush(): void {
    this.flushScheduled = false;
    const names = [...this.batch];
    this.batch.clear();
    const deviceId = this.deviceId();
    if (deviceId === null || names.length === 0) {
      return;
    }
    const gen = this.gen;
    for (let i = 0; i < names.length; i += READ_BATCH) {
      const chunk = names.slice(i, i + READ_BATCH);
      this.ops.next({
        gen,
        run: () =>
          this.racs.getFeatureStates(deviceId, chunk).pipe(
            tap({
              next: (states) => this.applyStates(states),
              error: (e) => this.applyReadFailure(chunk, errorMessage(e)),
            }),
            finalize(() => gen === this.gen && this.adjust(this.pendingReads, chunk, -1)),
          ),
      });
    }
  }

  private applyStates(states: FeatureState[]): void {
    this.states.update((m) => {
      const next = { ...m };
      for (const s of states) {
        next[s.name] = s;
      }
      return next;
    });
  }

  private applyReadFailure(names: string[], message: string): void {
    console.warn('getFeatureStates', names, message);
    this.states.update((m) => {
      const next = { ...m };
      for (const name of names) {
        next[name] = { ...(m[name] ?? emptyState(name, this.nodes().get(name))), value: null, error: message };
      }
      return next;
    });
  }

  /** Write `value` to `name`. A write still waiting in the queue for `name` just takes the new value. */
  write(name: string, value: string): void {
    const deviceId = this.deviceId();
    if (deviceId === null) {
      return;
    }
    const queued = this.queuedWrites.get(name);
    if (queued) {
      queued.value = value;
      return;
    }
    const entry = { value };
    this.queuedWrites.set(name, entry);
    this.adjust(this.savingNodes, [name], +1);
    const gen = this.gen;
    this.ops.next({
      gen,
      run: () => {
        // Started: a newer value from here on is a write of its own.
        this.queuedWrites.delete(name);
        return this.racs.setFeatureValue(deviceId, name, entry.value).pipe(
          tap({
            next: () => {
              this.clearError(name);
              this.refreshAfterWrite(name);
            },
            error: (e) => {
              this.nodeErrors.update((m) => ({ ...m, [name]: errorMessage(e) }));
              // Show what the device actually holds rather than the rejected input.
              this.read([name], true);
            },
          }),
          finalize(() => gen === this.gen && this.adjust(this.savingNodes, [name], -1)),
        );
      },
    });
  }

  /**
   * Run `request` in the queue as a change of `name` made other than by writing a value (the
   * server's packet-size search, say): `name` shows as saving meanwhile, a failure lands where a
   * write's would, and afterwards it is re-read as after a write. Settles with the response, or
   * rejects with the error (also when the device changes before its turn).
   */
  change<T>(name: string, request: (deviceId: number) => Observable<T>): Promise<T> {
    const deviceId = this.deviceId();
    if (deviceId === null) {
      return Promise.reject(new Error('No device selected'));
    }
    this.adjust(this.savingNodes, [name], +1);
    const gen = this.gen;
    return new Promise<T>((resolve, reject) => {
      this.ops.next({
        gen,
        skip: () => reject(new Error('The device changed')),
        run: () =>
          request(deviceId).pipe(
            tap({
              next: (response) => {
                this.clearError(name);
                this.refreshAfterWrite(name);
                resolve(response);
              },
              error: (e) => {
                this.nodeErrors.update((m) => ({ ...m, [name]: errorMessage(e) }));
                this.read([name], true);
                reject(e);
              },
            }),
            finalize(() => gen === this.gen && this.adjust(this.savingNodes, [name], -1)),
          ),
      });
    });
  }

  /** Execute command `name`. Afterwards everything shown is re-read: commands such as `UserSetLoad` change it. */
  execute(name: string): void {
    const deviceId = this.deviceId();
    if (deviceId === null) {
      return;
    }
    this.adjust(this.savingNodes, [name], +1);
    const gen = this.gen;
    this.ops.next({
      gen,
      run: () =>
        this.racs.executeCommand(deviceId, name).pipe(
          tap({
            next: () => {
              this.clearError(name);
              this.refreshAfterCommand();
            },
            error: (e) => this.nodeErrors.update((m) => ({ ...m, [name]: errorMessage(e) })),
          }),
          finalize(() => gen === this.gen && this.adjust(this.savingNodes, [name], -1)),
        ),
    });
  }

  /**
   * Re-read after a write: the feature itself (the device may have clamped or rounded it), what
   * its selector role makes depend on it, then everything shown, since GenICam features are
   * often coupled (Width → PayloadSize, an enable → a lock, …). Values not shown are marked stale
   * and re-read when shown again.
   */
  private refreshAfterWrite(name: string): void {
    const watched = this.watched();
    const dependents = dependentsOf(name, this.categories()).filter((n) => watched.has(n));
    for (const known of Object.keys(this.states())) {
      if (!watched.has(known) && known !== name) {
        this.stale.add(known);
      }
    }
    this.read([name, ...dependents, ...watched], true);
  }

  /** Re-read everything shown and mark the rest stale: a command (`UserSetLoad`) changes anything. */
  private refreshAfterCommand(): void {
    for (const known of Object.keys(this.states())) {
      this.stale.add(known);
    }
    this.read(this.watched(), true);
  }

  private showRemoteChange(text: string): void {
    this.remoteChange.set(text);
    if (this.remoteTimer !== null) {
      clearTimeout(this.remoteTimer);
    }
    this.remoteTimer = setTimeout(() => {
      this.remoteTimer = null;
      this.remoteChange.set(null);
    }, REMOTE_HINT_MS);
  }

  private poll(): void {
    if (this.holder() !== 'live' || this.busy()) {
      return;
    }
    const watched = this.watched();
    this.read(
      this.polled.filter((n) => watched.has(n)),
      true,
    );
  }

  private loadDevice(deviceId: number | null): void {
    this.gen++;
    this.stale.clear();
    this.batch.clear();
    this.queuedWrites.clear();
    this.error.set(null);
    this.categories.set([]);
    this.states.set({});
    this.pendingReads.set(new Map());
    this.savingNodes.set(new Map());
    this.nodeErrors.set({});
    this.expanded.set(new Set());
    this.remoteChange.set(null);
    if (deviceId === null) {
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    const gen = this.gen;
    this.racs.getGcCategories(deviceId).subscribe({
      next: (cats) => {
        if (gen === this.gen) {
          this.categories.set(cats);
          this.loading.set(false);
          // Views may have asked before the metadata arrived; their names were unknown then.
          this.read(this.watched());
        }
      },
      error: (e) => {
        if (gen === this.gen) {
          this.loading.set(false);
          this.error.set(errorMessage(e));
        }
      },
    });
  }

  private clearError(name: string): void {
    this.nodeErrors.update(({ [name]: _, ...rest }) => rest);
  }

  private adjust(target: WritableSignal<ReadonlyMap<string, number>>, names: string[], delta: number): void {
    const next = new Map(target());
    for (const name of names) {
      const count = (next.get(name) ?? 0) + delta;
      if (count > 0) {
        next.set(name, count);
      } else {
        next.delete(name);
      }
    }
    target.set(next);
  }
}

function emptyState(name: string, node: GenICamNodeInfo | undefined): FeatureState {
  return {
    name,
    node_type: node?.node_type ?? null,
    value: null,
    available: true,
    locked: false,
    min: null,
    max: null,
    inc: null,
    unit: null,
    representation: null,
    available_entries: null,
    error: null,
  };
}

/** The server's error text when it sent one, else a generic message. */
export function errorMessage(e: unknown): string {
  const refusal = refusalOf(e);
  if (refusal) {
    return refusalMessage(refusal);
  }
  if (e && typeof e === 'object' && 'error' in e) {
    const err = (e as { error?: unknown }).error;
    if (typeof err === 'string' && err.trim()) {
      return err;
    }
  }
  if (e && typeof e === 'object' && 'message' in e) {
    return String((e as { message: string }).message);
  }
  return 'Request failed';
}

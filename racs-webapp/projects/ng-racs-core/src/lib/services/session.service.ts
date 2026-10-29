import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { SessionCreated } from '../models/racs.models';
import { RACS_CONFIG } from '../config';

/** sessionStorage: the tab's session, so a reload keeps it (and its leases). */
export const SESSION_KEY = 'racs.session';
/** localStorage: the name the user gave this browser's clients. */
export const NAME_KEY = 'racs.client.name';
/** Tabs ask each other on this channel whether a stored session is already in use. */
export const SESSION_CHANNEL = 'racs-session';
/** How long a starting tab waits for another tab to say it has the stored session. */
export const CLAIM_WAIT_MS = 150;

type Stored = Pick<SessionCreated, 'session_id' | 'client_id' | 'timeout_s' | 'heartbeat_interval_s'>;

type ChannelMessage = { type: 'claim' | 'taken'; session_id: string };

/**
 * This tab's client session (specs/multi-user.md §1): who it is to the server and to the other
 * clients.
 *
 * - Created at start-up and kept in `sessionStorage`, so a reload within the timeout keeps it.
 * - A duplicated tab copies `sessionStorage`: before reusing a stored session the tab asks the
 *   others on a `BroadcastChannel`, and when one answers that it has it, this tab starts its own.
 * - Nothing is sent on `pagehide` (it also fires on reload, and `sendBeacon` can't DELETE): the
 *   server's timeout ends a closed tab's session.
 * - On `401` (the session expired, say after the laptop slept) {@link renew} starts a new one and
 *   joins this tab's devices again. The leases are gone with the old session.
 *
 * The session routes are sent with `HttpClient` directly; the interceptor leaves them alone.
 */
@Injectable({
  providedIn: 'root',
})
export class SessionService implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly api = inject(RACS_CONFIG).apiBase;
  private readonly sessionsUrl = `${this.api}/sessions`;

  /** The secret session id; `null` while there is none (requests then go out anonymous). */
  readonly id = signal<string | null>(null);
  /** How other clients see this one. */
  readonly clientId = signal<string | null>(null);
  readonly name = signal(loadName() ?? defaultName());
  readonly heartbeatIntervalS = signal(10);

  /** Devices this tab connected to or works with, joined again after a renew. */
  private readonly joined = new Set<number>();
  private pending: Promise<string | null> | null = null;
  private channel: BroadcastChannel | null = null;

  /** Start the session in the background; requests wait for it through {@link ensure}. */
  start(): void {
    void this.ensure();
  }

  /** The session id, creating (or adopting the stored) session first if there is none. */
  ensure(): Promise<string | null> {
    const id = this.id();
    if (id) {
      return Promise.resolve(id);
    }
    this.pending ??= this.establish().finally(() => (this.pending = null));
    return this.pending;
  }

  /**
   * The server no longer knows session `stale`: start a new one, once for every request that
   * found out, and join this tab's devices again.
   */
  renew(stale: string | null): Promise<string | null> {
    const current = this.id();
    if (current && current !== stale) {
      return Promise.resolve(current);
    }
    if (this.pending) {
      return this.pending;
    }
    this.forget();
    this.pending = this.create()
      .then(async (id) => {
        if (id) {
          await this.rejoin(id);
        }
        return id;
      })
      .finally(() => (this.pending = null));
    return this.pending;
  }

  /** Keep the session alive without the events socket. A `401` renews it. */
  async heartbeat(): Promise<void> {
    const id = this.id();
    if (!id) {
      return;
    }
    try {
      await firstValueFrom(this.http.post(`${this.sessionsUrl}/${id}/heartbeat`, null));
    } catch (e) {
      if ((e as { status?: number }).status === 401) {
        await this.renew(id);
      }
    }
  }

  /** Change the name other clients see. An empty name goes back to the default. */
  async rename(name: string): Promise<void> {
    const trimmed = name.trim();
    const next = trimmed || defaultName();
    saveName(trimmed && trimmed !== defaultName() ? trimmed : null);
    if (next === this.name()) {
      return;
    }
    this.name.set(next);
    const id = this.id();
    if (id) {
      try {
        await firstValueFrom(this.http.patch(`${this.sessionsUrl}/${id}`, { name: next }));
      } catch (e) {
        if ((e as { status?: number }).status === 401) {
          await this.renew(id); // the new session carries the new name
        }
      }
    }
  }

  markJoined(device: number): void {
    this.joined.add(device);
  }

  markLeft(device: number): void {
    this.joined.delete(device);
  }

  ngOnDestroy(): void {
    this.channel?.close();
    this.channel = null;
  }

  private async establish(): Promise<string | null> {
    const stored = loadStored();
    if (stored && !(await claimedElsewhere(stored.session_id))) {
      this.adopt(stored);
      return stored.session_id;
    }
    return this.create();
  }

  private async create(): Promise<string | null> {
    try {
      const created = await firstValueFrom(this.http.post<SessionCreated>(this.sessionsUrl, { name: this.name() }));
      this.adopt(created);
      return created.session_id;
    } catch {
      return null;
    }
  }

  private adopt(s: Stored): void {
    this.id.set(s.session_id);
    this.clientId.set(s.client_id);
    this.heartbeatIntervalS.set(Math.max(1, s.heartbeat_interval_s));
    saveStored(s);
    this.listen();
  }

  private forget(): void {
    this.id.set(null);
    this.clientId.set(null);
    saveStored(null);
  }

  /** `PUT …/connect` without a mode: rejoin in whatever mode the device is in now. */
  private async rejoin(id: string): Promise<void> {
    await Promise.all(
      [...this.joined].map((device) =>
        firstValueFrom(
          this.http.put(`${this.api}/devices/${device}/connect`, null, { headers: { 'X-Racs-Session': id } }),
        ).catch(() => undefined),
      ),
    );
  }

  /** Answer other tabs that ask whether this tab's session is taken. */
  private listen(): void {
    if (this.channel || typeof BroadcastChannel === 'undefined') {
      return;
    }
    this.channel = new BroadcastChannel(SESSION_CHANNEL);
    this.channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
      const id = this.id();
      if (event.data?.type === 'claim' && id && event.data.session_id === id) {
        this.channel?.postMessage({ type: 'taken', session_id: id } satisfies ChannelMessage);
      }
    };
  }
}

/** Whether another tab answers that it has session `id` (this tab is a duplicate of it). */
function claimedElsewhere(id: string): Promise<boolean> {
  if (typeof BroadcastChannel === 'undefined') {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const channel = new BroadcastChannel(SESSION_CHANNEL);
    const done = (taken: boolean) => {
      clearTimeout(timer);
      channel.close();
      resolve(taken);
    };
    const timer = setTimeout(() => done(false), CLAIM_WAIT_MS);
    channel.onmessage = (event: MessageEvent<ChannelMessage>) => {
      if (event.data?.type === 'taken' && event.data.session_id === id) {
        done(true);
      }
    };
    channel.postMessage({ type: 'claim', session_id: id } satisfies ChannelMessage);
  });
}

/** The browser's name for the default client name, `webapp · Firefox`. */
export function browserName(ua: string, brave = false): string {
  if (brave) {
    return 'Brave';
  }
  if (/Firefox\//.test(ua)) {
    return 'Firefox';
  }
  if (/Edg\//.test(ua)) {
    return 'Edge';
  }
  if (/OPR\//.test(ua)) {
    return 'Opera';
  }
  if (/Chrome\//.test(ua)) {
    return 'Chrome';
  }
  if (/Safari\//.test(ua)) {
    return 'Safari';
  }
  return 'browser';
}

export function defaultName(): string {
  const nav = typeof navigator === 'undefined' ? null : navigator;
  return `webapp · ${browserName(nav?.userAgent ?? '', !!(nav as { brave?: unknown } | null)?.brave)}`;
}

function loadName(): string | null {
  try {
    return localStorage.getItem(NAME_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

function saveName(name: string | null): void {
  try {
    if (name) {
      localStorage.setItem(NAME_KEY, name);
    } else {
      localStorage.removeItem(NAME_KEY);
    }
  } catch {
    // Not kept; the default is used next time.
  }
}

function loadStored(): Stored | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    const s = raw ? (JSON.parse(raw) as Partial<Stored>) : null;
    return s && typeof s.session_id === 'string' && typeof s.client_id === 'string'
      ? { session_id: s.session_id, client_id: s.client_id, timeout_s: s.timeout_s ?? 30, heartbeat_interval_s: s.heartbeat_interval_s ?? 10 }
      : null;
  } catch {
    return null;
  }
}

function saveStored(s: Stored | null): void {
  try {
    if (s) {
      const { session_id, client_id, timeout_s, heartbeat_interval_s } = s;
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ session_id, client_id, timeout_s, heartbeat_interval_s }));
    } else {
      sessionStorage.removeItem(SESSION_KEY);
    }
  } catch {
    // Without storage a reload starts a new session.
  }
}

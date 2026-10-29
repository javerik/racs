import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import { Subject } from 'rxjs';
import type { ClientRef, CloseReason, DeviceState, ServerEvent } from '../models/racs.models';
import { wsUrl } from '../ws-url';
import { RACS_CONFIG } from '../config';
import { SessionService } from './session.service';

/** First reconnect delay; doubles per failed attempt up to {@link RETRY_MAX_MS}. */
export const RETRY_MIN_MS = 500;
export const RETRY_MAX_MS = 10_000;
/** The close code of a socket whose session ended. */
const SESSION_ENDED = 4001;

export interface ClosedDevice {
  reason: CloseReason | null;
  by: ClientRef | null;
}

/**
 * The events socket (`GET /events`, specs/multi-user.md §4): what the other clients change, and
 * this tab's heartbeat. The server pings it and the browser answers by itself, also in a
 * background tab whose timers are throttled.
 *
 * - It reconnects with backoff. While it is down, `POST …/heartbeat` keeps the session alive.
 * - A `4001` close means the session ended: it is renewed, and the socket follows the new one.
 * - `hello` (after every connect) and `resync` (events were lost) fire {@link resync$}: the
 *   other services read their state again.
 * - It keeps each device's last state and why a device was closed.
 */
@Injectable({
  providedIn: 'root',
})
export class ServerEventsService {
  private readonly session = inject(SessionService);
  private readonly api = inject(RACS_CONFIG).apiBase;

  readonly events$ = new Subject<ServerEvent>();
  readonly resync$ = new Subject<void>();
  /** True from `hello` until the socket closes. */
  readonly connected = signal(false);
  /** The connected devices' state, from `hello` and `device_state`. */
  readonly deviceStates = signal<ReadonlyMap<number, DeviceState>>(new Map());
  /** Devices closed since this tab started, and why; cleared when one connects again. */
  readonly closed = signal<ReadonlyMap<number, ClosedDevice>>(new Map());

  private socket: WebSocket | null = null;
  private sessionId: string | null = null;
  private retryMs = RETRY_MIN_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    effect(() => {
      const id = this.session.id();
      untracked(() => this.open(id));
    });
    inject(DestroyRef).onDestroy(() => this.open(null));
  }

  private open(id: string | null): void {
    this.sessionId = id;
    this.closeSocket();
    this.clearRetry();
    this.retryMs = RETRY_MIN_MS;
    if (!id) {
      this.stopHeartbeat();
      return;
    }
    this.connect();
  }

  private connect(): void {
    const id = this.sessionId;
    if (!id) {
      return;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl(this.api, '/events', new URLSearchParams({ session: id })));
    } catch {
      this.down(null);
      return;
    }
    this.socket = socket;
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        return;
      }
      try {
        this.handle(JSON.parse(event.data) as ServerEvent);
      } catch (e) {
        console.warn('events: bad message', e);
      }
    };
    socket.onclose = (event) => {
      if (this.socket === socket) {
        this.socket = null;
        this.down(event.code);
      }
    };
  }

  private down(code: number | null): void {
    this.connected.set(false);
    this.startHeartbeat();
    const id = this.sessionId;
    if (code === SESSION_ENDED) {
      // The renewed session's id reopens the socket.
      void this.session.renew(id);
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.retryMs);
    this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS);
  }

  private handle(event: ServerEvent): void {
    switch (event.type) {
      case 'hello':
        this.connected.set(true);
        this.retryMs = RETRY_MIN_MS;
        this.stopHeartbeat();
        this.deviceStates.set(new Map(event.devices.map((d) => [d.device, d])));
        this.closed.update((m) => {
          const next = new Map(m);
          event.devices.forEach((d) => next.delete(d.device));
          return next;
        });
        break;
      case 'device_state': {
        const { device, connected, access, stream, burst } = event;
        this.deviceStates.update((m) => {
          const next = new Map(m);
          if (connected) {
            next.set(device, { device, connected, access, stream, burst });
          } else {
            next.delete(device);
          }
          return next;
        });
        if (event.cause === 'disconnected' || event.cause === 'connected') {
          this.closed.update((m) => {
            const next = new Map(m);
            if (connected) {
              next.delete(device);
            } else {
              next.set(device, { reason: event.reason, by: event.by });
            }
            return next;
          });
        }
        break;
      }
    }
    this.events$.next(event);
    if (event.type === 'hello' || event.type === 'resync') {
      this.resync$.next();
    }
  }

  /** Heartbeats right away and then every interval, until the socket says hello again. */
  private startHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      return;
    }
    void this.session.heartbeat();
    this.heartbeatTimer = setInterval(() => void this.session.heartbeat(), this.session.heartbeatIntervalS() * 1000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.connected.set(false);
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
  }
}

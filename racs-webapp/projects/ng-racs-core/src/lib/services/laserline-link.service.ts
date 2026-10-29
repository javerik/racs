import { Injectable, OnDestroy, computed, signal } from '@angular/core';
import {
  LASERLINE_CHANNEL,
  LASERLINE_PROTOCOL,
  type FromLaserline,
  type MetricMapping,
  type Pattern,
  type RemoteStatus,
  type ToLaserline,
  type ViewPoint,
} from '../laserline/protocol';

/** How long `hello` waits for a laserline window to answer. */
const HELLO_MS = 600;
/** How long a freshly opened laserline window may take to load and answer. */
const OPEN_MS = 15_000;
/** How long a pattern may take to reach the screen. */
const SHOWN_MS = 3_000;
/** How often a running session tells laserline it is still there. */
const KEEP_ALIVE_MS = 4_000;

type Listener = (msg: FromLaserline) => void;
/** A message to a laserline window, before the version and the address are added. */
type Outgoing = { [K in ToLaserline['type']]: Omit<Extract<ToLaserline, { type: K }>, 'v' | 'to'> }[ToLaserline['type']];

/**
 * The connection to the laserline tool's window over its same-origin `BroadcastChannel` (see
 * `core/laserline/protocol.ts`). Talks to one window: the first that answers, kept until it stops
 * answering.
 */
@Injectable({ providedIn: 'root' })
export class LaserlineLinkService implements OnDestroy {
  /** The laserline window spoken to, by its id. */
  readonly host = signal<string | null>(null);
  /** That window's latest status (its view size, the line's envelope, the camera field). */
  readonly status = signal<RemoteStatus | null>(null);
  /**
   * That window's metric mapping: `undefined` without a window or from a laserline that can't
   * publish it, `null` without a scan (or with it disabled).
   */
  readonly metric = computed<MetricMapping | null | undefined>(() => this.status()?.metric);

  private channel?: BroadcastChannel;
  private readonly listeners = new Set<Listener>();
  /** The last status of every window that answered. */
  private readonly statuses = new Map<string, RemoteStatus>();

  /** The channel is missing in old browsers and some test environments. */
  get supported(): boolean {
    return typeof BroadcastChannel !== 'undefined';
  }

  ngOnDestroy(): void {
    this.channel?.close();
  }

  /** Asks the laserline windows to report; resolves with the one spoken to, or null if none answered. */
  async hello(timeoutMs = HELLO_MS): Promise<string | null> {
    const current = this.host();
    const answered = new Set<string>();
    const first = this.waitFor((m) => {
      if (m.type !== 'status') return undefined;
      answered.add(m.host);
      // Keep the window already spoken to if it answers; otherwise the first one.
      return m.host === current || !current ? m.host : undefined;
    }, timeoutMs).catch(() => null);
    this.send({ type: 'hello' }, '');
    const host = (await first) ?? ([...answered][0] || null);
    this.host.set(host);
    this.status.set(host ? (this.statuses.get(host) ?? null) : null);
    return host;
  }

  /**
   * Makes sure a laserline window answers, calling `open` (which opens one) if none does. Call it
   * from a user action: browsers only allow new windows then. Rejects if none answers in time.
   */
  async connect(open: () => void, timeoutMs = OPEN_MS): Promise<string> {
    if (!this.supported) {
      throw new Error('this browser cannot talk to other windows (no BroadcastChannel)');
    }
    const host = await this.hello();
    if (host) return host;
    open();
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const h = await this.hello(500);
      if (h) return h;
    }
    throw new Error('the laserline window did not answer; open it from Tools and keep it open');
  }

  /**
   * Waits until the window spoken to has drawn its view (a window just opened answers before its
   * first frame); resolves with the view size, or null on timeout.
   */
  async drawnView(timeoutMs = 5_000): Promise<ViewPoint | null> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const view = this.status()?.viewPx;
      if (view && view[0] > 0 && view[1] > 0) return view;
      if (performance.now() >= deadline) return null;
      await this.hello(300);
    }
  }

  /** Starts a calibration session: laserline keeps the user's line aside and goes blank. */
  async begin(session: string): Promise<void> {
    const done = this.waitFor((m) => {
      if (m.type === 'status' && m.status.session === session) return true;
      if (m.type === 'error' && m.session === session) return new Error(`laserline: ${m.message}`);
      return undefined;
    }, SHOWN_MS);
    this.send({ type: 'begin', session });
    await done;
  }

  /**
   * Shows `pattern`; resolves once it has been on screen for a frame, with the time (as
   * `performance.now()`) the answer arrived and the view size it was drawn at.
   */
  async show(session: string, id: number, pattern: Pattern): Promise<{ at: number; viewPx: ViewPoint }> {
    const done = this.waitFor((m) => {
      if (m.type === 'shown' && m.session === session && m.id === id) return { at: performance.now(), viewPx: m.viewPx };
      if (m.type === 'error' && m.id === id) return new Error(`laserline: ${m.message}`);
      return undefined;
    }, SHOWN_MS).catch((e: Error) => {
      throw /timed out/.test(e.message)
        ? new Error('the laserline view does not draw: keep its window visible (not minimised or covered)')
        : e;
    });
    this.send({ type: 'show', session, id, pattern });
    return done;
  }

  /** Tells laserline the session is still running (it ends quiet ones). */
  touch(session: string): void {
    this.send({ type: 'begin', session });
  }

  /** Ends the session: the user's line and playback come back. */
  end(session: string): void {
    this.send({ type: 'end', session });
  }

  /**
   * Runs `fn` in a session named `<prefix>-<time>`, kept alive while it waits for frames
   * (laserline ends quiet ones), and ended however `fn` ends.
   */
  async runSession<T>(prefix: string, fn: (session: string) => Promise<T>): Promise<T> {
    const session = `${prefix}-${Date.now().toString(36)}`;
    await this.begin(session);
    const keepAlive = setInterval(() => this.touch(session), KEEP_ALIVE_MS);
    try {
      return await fn(session);
    } finally {
      clearInterval(keepAlive);
      this.end(session);
    }
  }

  /** Tells laserline which part of its view the camera sees (`null` removes it). */
  setField(polygon: ViewPoint[] | null, label?: string): void {
    this.send({ type: 'camera-field', polygon, label });
  }

  /** Asks laserline to move and shrink the line into the camera field; resolves with whether it fits. */
  async fitToField(margin: number): Promise<boolean> {
    const id = Math.floor(Math.random() * 1e9);
    const done = this.waitFor((m) => {
      if (m.type === 'fitted' && m.id === id) return m.fits;
      if (m.type === 'error' && m.id === id) return new Error(`laserline: ${m.message}`);
      return undefined;
    }, SHOWN_MS);
    this.send({ type: 'fit-to-field', id, margin });
    return done;
  }

  /**
   * Has laserline keep the line inside `polygon` (`null` releases it); resolves with the names of
   * the parameters it clamped. A laserline that can't keep one doesn't answer: that rejects.
   */
  async constrain(polygon: ViewPoint[] | null, label?: string): Promise<string[]> {
    const id = Math.floor(Math.random() * 1e9);
    const done = this.waitFor((m) => {
      if (m.type === 'constrained' && m.id === id) return m.clamped;
      if (m.type === 'error' && m.id === id) return new Error(`laserline: ${m.message}`);
      return undefined;
    }, SHOWN_MS).catch((e: Error) => {
      throw /timed out/.test(e.message) ? new Error('this laserline version cannot keep the line in an area: update it') : e;
    });
    this.send({ type: 'constrain', id, polygon, label });
    return done;
  }

  /**
   * Sets the user's line tilt (degrees on top of its orientation); resolves with the tilt laserline
   * kept. A laserline that can't set it doesn't answer: that rejects.
   */
  async setTilt(tiltDeg: number): Promise<number> {
    const id = Math.floor(Math.random() * 1e9);
    const done = this.waitFor((m) => {
      if (m.type === 'tilted' && m.id === id) return m.tilt_deg;
      if (m.type === 'error' && m.id === id) return new Error(`laserline: ${m.message}`);
      return undefined;
    }, SHOWN_MS).catch((e: Error) => {
      throw /timed out/.test(e.message) ? new Error('this laserline version cannot tilt the line: update it') : e;
    });
    this.send({ type: 'tilt', id, tilt_deg: tiltDeg });
    return done;
  }

  private send(msg: Outgoing, to = this.host() ?? ''): void {
    this.open().postMessage({ v: LASERLINE_PROTOCOL, to, ...msg } as ToLaserline);
  }

  private open(): BroadcastChannel {
    if (!this.channel) {
      this.channel = new BroadcastChannel(LASERLINE_CHANNEL);
      this.channel.onmessage = (e: MessageEvent) => this.receive(e.data as FromLaserline);
    }
    return this.channel;
  }

  private receive(msg: FromLaserline): void {
    if (!msg || msg.v !== LASERLINE_PROTOCOL) return;
    if (msg.type === 'status') {
      this.statuses.set(msg.host, msg.status);
      if (msg.host === this.host()) this.status.set(msg.status);
    }
    for (const l of [...this.listeners]) l(msg);
  }

  /**
   * Resolves with the first non-undefined value `pick` returns for a message from the window
   * spoken to (any window for statuses), rejects with an `Error` it returns, or on timeout.
   */
  private waitFor<T>(pick: (m: FromLaserline) => T | Error | undefined, timeoutMs: number): Promise<T> {
    this.open();
    return new Promise<T>((resolve, reject) => {
      const listener: Listener = (m) => {
        if (m.type !== 'status' && this.host() && m.host !== this.host()) return;
        const v = pick(m);
        if (v === undefined) return;
        finish();
        if (v instanceof Error) reject(v);
        else resolve(v);
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error('laserline timed out'));
      }, timeoutMs);
      const finish = () => {
        clearTimeout(timer);
        this.listeners.delete(listener);
      };
      this.listeners.add(listener);
    });
  }
}

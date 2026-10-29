/**
 * Draws only the newest of the frames that arrive while the previous one is still being drawn,
 * at most once per animation frame. A live stream can deliver faster than a page decodes,
 * analyses and paints a full-size frame, and the WebSocket API has no backpressure: drawing every
 * frame in turn would build a backlog, so the picture lags further behind the camera the longer
 * it runs. Superseded frames are skipped instead. In a background tab nothing is drawn at all
 * (no animation frames), and only the newest frame waits.
 */
export class LatestFrame<T> {
  private pending: T | null = null;
  private scheduled = false;
  private busy = false;

  /**
   * `draw` may return a promise (an asynchronous JPEG decode); the next frame waits for it.
   * `schedule` is `requestAnimationFrame` outside tests.
   */
  constructor(
    private readonly draw: (frame: T) => void | Promise<unknown>,
    private readonly schedule: (callback: () => void) => unknown = (cb) => requestAnimationFrame(cb),
  ) {}

  /** A frame arrived; it replaces any that is still waiting. */
  push(frame: T): void {
    this.pending = frame;
    this.kick();
  }

  /** Forget the waiting frame (the stream stopped). */
  clear(): void {
    this.pending = null;
  }

  private kick(): void {
    if (this.scheduled || this.busy || this.pending === null) {
      return;
    }
    this.scheduled = true;
    this.schedule(() => this.run());
  }

  private run(): void {
    this.scheduled = false;
    const frame = this.pending;
    this.pending = null;
    if (frame === null) {
      return;
    }
    this.busy = true;
    let result: void | Promise<unknown>;
    try {
      result = this.draw(frame);
    } catch (e) {
      this.done();
      throw e;
    }
    if (result instanceof Promise) {
      result.finally(() => this.done());
    } else {
      this.done();
    }
  }

  private done(): void {
    this.busy = false;
    this.kick();
  }
}

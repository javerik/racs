import { HttpErrorResponse } from '@angular/common/http';
import { Subscription, timer } from 'rxjs';
import { exhaustMap } from 'rxjs/operators';
import type { BurstJobInfo, JobStatus } from '../models/racs.models';
import type { RacsService } from '../services/racs.service';

export interface BurstFetchHandlers {
  /** Every status polled. */
  info?(info: BurstJobInfo): void;
  /** A captured image arrived (any order). */
  image(index: number, bytes: Uint8Array, info: BurstJobInfo): void;
  /** An image the job could not capture, or that could not be downloaded. */
  failed?(index: number, reason: string): void;
  /** The job is over and every image it captured has arrived; called once. */
  finished(info: BurstJobInfo): void;
  /** Polling or listing failed; `gone` when the job no longer exists (404). Fetching stops. */
  error(message: string, gone: boolean): void;
}

export type BurstApi = Pick<RacsService, 'getBurst' | 'listBurstImages' | 'getBurstImage'>;

const TERMINAL: readonly JobStatus[] = ['completed', 'failed', 'cancelled'];

/**
 * Follows a burst job and downloads its images as they are captured: polls the status, lists the
 * images when more were attempted than are known, and fetches a few at a time. The same loop as
 * the burst player's, for a caller that only wants the images.
 */
export class BurstFetch {
  private poll: Subscription | null = null;
  private readonly subs = new Subscription();
  /** Indices listed: queued, fetched or failed. */
  private readonly known = new Set<number>();
  private readonly queue: number[] = [];
  private inFlight = 0;
  private listing = false;
  private info: BurstJobInfo | null = null;
  private over = false;

  constructor(
    private readonly api: BurstApi,
    private readonly deviceId: number,
    private readonly jobId: string,
    private readonly handlers: BurstFetchHandlers,
    private readonly opts: { pollMs?: number; maxInFlight?: number } = {},
  ) {}

  start(): void {
    this.poll = timer(0, this.opts.pollMs ?? 300)
      .pipe(exhaustMap(() => this.api.getBurst(this.deviceId, this.jobId)))
      .subscribe({
        next: (info) => this.onInfo(info),
        error: (e) => this.fail(e),
      });
  }

  /** Stop polling and drop the downloads in flight. */
  stop(): void {
    this.over = true;
    this.poll?.unsubscribe();
    this.poll = null;
    this.subs.unsubscribe();
  }

  private onInfo(info: BurstJobInfo): void {
    if (this.over) {
      return;
    }
    this.info = info;
    this.handlers.info?.(info);
    if (info.captured_count + info.failed_count > this.known.size) {
      this.list();
    }
    this.checkFinished();
  }

  private list(): void {
    if (this.listing) {
      return;
    }
    this.listing = true;
    this.subs.add(
      this.api.listBurstImages(this.deviceId, this.jobId).subscribe({
        next: (entries) => {
          this.listing = false;
          for (const entry of entries) {
            if (this.known.has(entry.index)) {
              continue;
            }
            this.known.add(entry.index);
            if (entry.status === 'failed') {
              this.handlers.failed?.(entry.index, entry.error);
            } else {
              this.queue.push(entry.index);
            }
          }
          this.pump();
          this.checkFinished();
        },
        error: (e) => {
          this.listing = false;
          this.fail(e);
        },
      }),
    );
  }

  private pump(): void {
    const max = this.opts.maxInFlight ?? 4;
    while (!this.over && this.inFlight < max && this.queue.length > 0) {
      const index = this.queue.shift()!;
      this.inFlight++;
      this.subs.add(
        this.api.getBurstImage(this.deviceId, this.jobId, index).subscribe({
          next: (buffer) => {
            this.inFlight--;
            if (!this.over) {
              this.handlers.image(index, new Uint8Array(buffer), this.info!);
            }
            this.pump();
            this.checkFinished();
          },
          error: () => {
            this.inFlight--;
            if (!this.over) {
              this.handlers.failed?.(index, 'download failed');
            }
            this.pump();
            this.checkFinished();
          },
        }),
      );
    }
  }

  private checkFinished(): void {
    const info = this.info;
    if (
      this.over ||
      !info ||
      !TERMINAL.includes(info.status) ||
      this.listing ||
      this.inFlight > 0 ||
      this.queue.length > 0 ||
      this.known.size < info.captured_count + info.failed_count
    ) {
      return;
    }
    this.stop();
    this.handlers.finished(info);
  }

  private fail(e: unknown): void {
    if (this.over) {
      return;
    }
    this.stop();
    const gone = e instanceof HttpErrorResponse && e.status === 404;
    this.handlers.error(gone ? 'The burst is gone from the server (expired or deleted).' : errMsg(e), gone);
  }
}

export function errMsg(e: unknown): string {
  if (e instanceof HttpErrorResponse) {
    if (typeof e.error === 'string' && e.error) {
      return e.error;
    }
    return e.status ? `Request failed (${e.status})` : 'Server unreachable';
  }
  return e instanceof Error ? e.message : 'Request failed';
}

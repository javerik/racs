import { Component, computed, inject, input, signal } from '@angular/core';
import { errorMessage, GenicamSession, PACKET_SIZE_FEATURE, type PacketSizeInfo, RacsService } from 'ng-racs-core';

/**
 * Under the packet size in Quick settings: the link the camera is reached over, and Auto, which
 * has the server find the largest packet size that arrives (GigE Vision test packets). During a
 * live stream the server pauses acquisition for it and the stream carries on with the new size.
 */
@Component({
  selector: 'racs-packet-size-tools',
  standalone: true,
  template: `
    <div class="flex items-center gap-3 px-4 pb-1 pt-0.5 mobile:pb-2">
      <span class="min-w-0 flex-1 font-mono text-2xs" [class.text-faint]="!exceeds()" [class.text-warn]="exceeds()"
        [title]="linkTitle()">{{ linkHint() }}</span>
      <button type="button" class="btn shrink-0" [disabled]="disabled() || running()" [attr.aria-busy]="running()"
        title="Find the largest packet size that reaches the server, with test packets" (click)="auto()">
        @if (running()) {
        <span class="dot animate-pulse bg-warn"></span>
        }
        Auto
      </button>
    </div>
    @if (outcome(); as o) {
    <p class="m-0 px-4 pb-1 font-mono text-2xs text-faint">{{ o }}</p>
    }
  `,
})
export class PacketSizeToolsComponent {
  private readonly session = inject(GenicamSession);
  private readonly racs = inject(RacsService);

  /** Bounds and link from the server; `null` until they arrive. */
  readonly info = input<PacketSizeInfo | null>(null);
  readonly disabled = input(false);

  readonly running = signal(false);
  /** What the last Auto found, as a hint line. */
  readonly outcome = signal<string | null>(null);

  private readonly current = computed(() => Number(this.session.states()[PACKET_SIZE_FEATURE]?.value ?? NaN));

  /** The camera's packet size can't arrive over this link. */
  readonly exceeds = computed(() => {
    const mtu = this.info()?.link_mtu;
    return mtu != null && this.current() > mtu;
  });

  readonly linkHint = computed(() => {
    const info = this.info();
    if (!info) {
      return 'link …';
    }
    const where = info.interface ? ` · ${info.interface}` : '';
    if (info.link_mtu == null) {
      return `link mtu unknown${where}`;
    }
    return this.exceeds()
      ? `exceeds link mtu ${info.link_mtu}${where}`
      : `link mtu ${info.link_mtu}${where}`;
  });

  readonly linkTitle = computed(() => {
    const info = this.info();
    if (!info) {
      return '';
    }
    return `Packets up to the link MTU arrive. Allowed: ${info.min}–${info.max} in steps of ${info.inc}` +
      (info.local_ip ? `. Reached from ${info.local_ip}` : '');
  });

  async auto(): Promise<void> {
    this.running.set(true);
    this.outcome.set(null);
    try {
      const result = await this.session.change(PACKET_SIZE_FEATURE, (id) => this.racs.autoPacketSize(id));
      this.outcome.set(
        result.test_packets
          ? `auto · ${result.packet_size}${result.packet_size === result.previous ? ' (unchanged)' : ` (was ${result.previous})`}`
          : 'auto · the camera sent no test packet; size unchanged',
      );
    } catch (e) {
      // The session shows the failure under the control; nothing to add here.
      console.warn('autoPacketSize', errorMessage(e));
    } finally {
      this.running.set(false);
    }
  }
}

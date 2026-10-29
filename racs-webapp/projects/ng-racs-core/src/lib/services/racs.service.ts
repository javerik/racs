import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';
import type {
  AccessMode,
  AutoPacketSize,
  BurstJobCreated,
  BurstJobInfo,
  ConnectedDevice,
  DeviceAccess,
  DeviceConnections,
  DisconnectResult,
  FeatureState,
  GenICamNodeCategory,
  ImageEntryInfo,
  LiveFormat,
  LiveFrame,
  PacketSizeInfo,
  PixelDepth,
  StartBurstJobRequest,
  StreamErrorInfo,
  StreamInfo,
} from '../models/racs.models';
import { liveCloseMessage } from '../access';
import { wsUrl } from '../ws-url';
import { SessionService } from './session.service';
import { RACS_CONFIG } from '../config';

/** Bytes of metadata in front of every binary live-stream message. */
const FRAME_HEADER_LEN = 8;

export interface LiveStreamOptions {
  format?: LiveFormat;
  pixelDepth?: PixelDepth;
  quality?: number;
  fps?: number;
}

/** What the live stream emits: the opening info message, then a frame per binary message. */
export type LiveStreamEvent =
  | { kind: 'info'; info: StreamInfo }
  | { kind: 'frame'; frame: LiveFrame };

/**
 * A live stream that ended other than normally. `code` is the close code (`1006` when the server
 * refused the socket before it opened), `reason` the server's text; the message is for people.
 */
export class LiveStreamClosed extends Error {
  constructor(
    readonly code: number,
    readonly reason: string,
    message = liveCloseMessage(code, reason),
  ) {
    super(message);
    this.name = 'LiveStreamClosed';
  }
}

@Injectable({
  providedIn: 'root',
})
export class RacsService {
  private readonly http = inject(HttpClient);
  private readonly session = inject(SessionService);
  private readonly api = inject(RACS_CONFIG).apiBase;

  getDevices(): Observable<DeviceConnections> {
    return this.http.get<DeviceConnections>(`${this.api}/devices`);
  }

  /** The connected devices only. Unlike {@link getDevices} this runs no discovery, so it is cheap to poll. */
  getConnectedDevices(): Observable<ConnectedDevice[]> {
    return this.http.get<ConnectedDevice[]>(`${this.api}/devices/connected`);
  }

  /**
   * Connect (or join) device `id`. `ro-shared` and `exclusive` take its lease in the same step;
   * `shared` sends no mode, so it joins in whatever mode the device is in rather than failing on
   * a device another client owns.
   */
  connectDevice(id: number, ip?: string, mode: AccessMode = 'shared'): Observable<DeviceAccess> {
    let params = new HttpParams();
    if (ip?.trim()) {
      params = params.set('ip', ip.trim());
    }
    if (mode !== 'shared') {
      params = params.set('mode', mode);
    }
    const url = `${this.api}/devices/${id}/connect`;
    return this.http.put<DeviceAccess>(url, null, { params });
  }

  /** Leave device `id` (it closes once nobody uses it); `force` closes it for everyone. */
  disconnectDevice(id: number, force = false): Observable<DisconnectResult> {
    const params = force ? new HttpParams().set('force', 'true') : undefined;
    return this.http.put<DisconnectResult>(`${this.api}/devices/${id}/disconnect`, null, { params });
  }

  getAccess(id: number): Observable<DeviceAccess> {
    return this.http.get<DeviceAccess>(`${this.api}/devices/${id}/access`);
  }

  /** Take or change device `id`'s lease (`shared` gives it up). `force` breaks another's. */
  setAccess(id: number, mode: AccessMode, force = false): Observable<DeviceAccess> {
    return this.http.put<DeviceAccess>(`${this.api}/devices/${id}/access`, { mode, force });
  }

  /** Release this client's lease, or with `force` anyone's. */
  releaseAccess(id: number, force = false): Observable<DeviceAccess> {
    const params = force ? new HttpParams().set('force', 'true') : undefined;
    return this.http.delete<DeviceAccess>(`${this.api}/devices/${id}/access`, { params });
  }

  getGcCategories(deviceId: number): Observable<GenICamNodeCategory[]> {
    return this.http.get<GenICamNodeCategory[]>(
      `${this.api}/devices/${deviceId}/gc/categories`,
    );
  }

  getFeatureValue(deviceId: number, featureName: string): Observable<string> {
    const name = encodeURIComponent(featureName);
    return this.http.get(`${this.api}/devices/${deviceId}/gc/feature/${name}`, {
      responseType: 'text',
    });
  }

  setFeatureValue(
    deviceId: number,
    featureName: string,
    value: string,
  ): Observable<void> {
    const name = encodeURIComponent(featureName);
    const params = new HttpParams().set('value', value);
    return this.http.put<void>(
      `${this.api}/devices/${deviceId}/gc/feature/${name}`,
      null,
      { params },
    );
  }

  /**
   * Live state (value, availability, lock, bounds) of up to 256 features in one request. Also
   * answered while a live stream holds the camera.
   */
  getFeatureStates(deviceId: number, names: string[]): Observable<FeatureState[]> {
    return this.http.post<FeatureState[]>(
      `${this.api}/devices/${deviceId}/gc/features/state`,
      { names },
    );
  }

  /** Executes a GenICam command (`TriggerSoftware`, `UserSetLoad`, …) once. */
  executeCommand(deviceId: number, commandName: string): Observable<void> {
    const name = encodeURIComponent(commandName);
    return this.http.post<void>(`${this.api}/devices/${deviceId}/gc/command/${name}`, null);
  }

  grabJpegFrame(deviceId: number): Observable<Blob> {
    return this.http.get(
      `${this.api}/devices/${deviceId}/stream/frame/jpeg`,
      { responseType: 'blob' },
    );
  }

  getStreamError(deviceId: number): Observable<StreamErrorInfo> {
    return this.http.get<StreamErrorInfo>(
      `${this.api}/devices/${deviceId}/stream/error`,
    );
  }

  /** The stream packet size, its bounds and the link MTU. Also answered during a live stream. */
  getPacketSize(deviceId: number): Observable<PacketSizeInfo> {
    return this.http.get<PacketSizeInfo>(`${this.api}/devices/${deviceId}/stream/packet-size`);
  }

  /**
   * Find and set the largest packet size that reaches the server, with test packets. During a
   * live stream acquisition pauses for it and the stream carries on with the new size.
   */
  autoPacketSize(deviceId: number): Observable<AutoPacketSize> {
    return this.http.post<AutoPacketSize>(`${this.api}/devices/${deviceId}/stream/packet-size/auto`, null);
  }

  startBurst(deviceId: number, request: StartBurstJobRequest): Observable<BurstJobCreated> {
    return this.http.post<BurstJobCreated>(`${this.api}/devices/${deviceId}/grab/jobs`, request);
  }

  getBurst(deviceId: number, jobId: string): Observable<BurstJobInfo> {
    return this.http.get<BurstJobInfo>(`${this.api}/devices/${deviceId}/grab/jobs/${jobId}`);
  }

  listBurstImages(deviceId: number, jobId: string): Observable<ImageEntryInfo[]> {
    return this.http.get<ImageEntryInfo[]>(
      `${this.api}/devices/${deviceId}/grab/jobs/${jobId}/images`,
    );
  }

  /** One burst frame, as served: JPEG bytes or raw pixels per the job's geometry. */
  getBurstImage(deviceId: number, jobId: string, index: number): Observable<ArrayBuffer> {
    return this.http.get(
      `${this.api}/devices/${deviceId}/grab/jobs/${jobId}/images/${index}`,
      { responseType: 'arraybuffer' },
    );
  }

  /** Cancels a running job or discards a finished one, along with its images. */
  deleteBurst(deviceId: number, jobId: string): Observable<void> {
    return this.http.delete<void>(`${this.api}/devices/${deviceId}/grab/jobs/${jobId}`);
  }

  /**
   * Opens the live-stream WebSocket. The socket is closed on unsubscribe, which is what tells the
   * server to stop acquiring and release the camera — so always unsubscribe.
   */
  liveStream(
    deviceId: number,
    options: LiveStreamOptions = {},
  ): Observable<LiveStreamEvent> {
    return new Observable<LiveStreamEvent>((subscriber) => {
      const params = new URLSearchParams({ format: options.format ?? 'jpeg' });
      if (options.pixelDepth !== undefined) {
        params.set('pixel_depth', options.pixelDepth);
      }
      if (options.quality !== undefined) {
        params.set('quality', String(options.quality));
      }
      if (options.fps !== undefined) {
        params.set('fps', String(options.fps));
      }
      const session = this.session.id();
      if (session) {
        params.set('session', session);
      }
      const socket = new WebSocket(wsUrl(this.api, `/devices/${deviceId}/stream/live`, params));
      socket.binaryType = 'arraybuffer';

      socket.onmessage = (event) => {
        if (typeof event.data === 'string') {
          subscriber.next({ kind: 'info', info: JSON.parse(event.data) });
          return;
        }
        const buffer = event.data as ArrayBuffer;
        if (buffer.byteLength <= FRAME_HEADER_LEN) {
          return;
        }
        const header = new DataView(buffer, 0, FRAME_HEADER_LEN);
        subscriber.next({
          kind: 'frame',
          frame: {
            frameNumber: header.getUint32(0, true),
            dropped: header.getUint32(4, true),
            payload: new Uint8Array(buffer, FRAME_HEADER_LEN),
          },
        });
      };

      let opened = false;
      socket.onopen = () => (opened = true);
      // A failure is followed by a close, which carries what there is to know.
      socket.onerror = () => undefined;
      socket.onclose = (event) => {
        if (event.code === 1000) {
          subscriber.complete();
        } else if (!opened) {
          // Refused before the upgrade (busy, read-only, locked): the browser only sees a failed
          // connection, and the server keeps the reason for `GET …/stream/error`.
          this.getStreamError(deviceId).subscribe({
            next: (e) =>
              subscriber.error(new LiveStreamClosed(event.code, e.last_error ?? '', e.last_error || 'Live stream failed')),
            error: () => subscriber.error(new LiveStreamClosed(event.code, '', 'Live stream failed')),
          });
        } else {
          subscriber.error(new LiveStreamClosed(event.code, event.reason));
        }
      };

      return () => {
        socket.onopen = null;
        socket.onclose = null;
        socket.onerror = null;
        if (
          socket.readyState === WebSocket.OPEN ||
          socket.readyState === WebSocket.CONNECTING
        ) {
          socket.close();
        }
      };
    });
  }
}

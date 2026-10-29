//! Last-error bookkeeping for live streams.
//!
//! A WebSocket that dies takes its close reason with it — by the time a client reconnects there is
//! nothing left to inspect. This store keeps the last failure per device so
//! `GET /devices/{id}/stream/error` can answer after the fact.

use std::collections::HashMap;

use serde::Serialize;
use tokio::sync::Mutex;
use utoipa::ToSchema;

/// What `GET /devices/{id}/stream/error` returns. All-null for a device that never streamed.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct StreamErrorInfo {
    /// The last error from any live stream on this device, or `null` if there has not been one.
    pub last_error: Option<String>,
    /// When `last_error` was recorded, RFC 3339.
    pub timestamp: Option<String>,
    /// Whether a live stream is currently attached to this device.
    pub active_stream: bool,
    /// How many live-stream sockets are open on this device: the viewers of its capture.
    pub viewers: u32,
}

#[derive(Default)]
struct Entry {
    last_error: Option<String>,
    timestamp: Option<String>,
    /// Open live-stream sockets on the device: the capture's viewers. A count rather than a flag,
    /// so one viewer leaving (or one refused, the camera being busy) doesn't mark a capture that
    /// others still watch inactive.
    viewers: u32,
}

/// Per-device stream state, shared by the WebSocket handler and the error endpoint.
///
/// Uses the same async `Mutex` as `CameraStore` so it can be awaited from handlers without
/// blocking a worker.
#[derive(Default)]
pub struct StreamErrorStore {
    entries: Mutex<HashMap<u32, Entry>>,
}

impl StreamErrorStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// A live-stream socket on `id` opened. Pair every call with one [`StreamErrorStore::mark_inactive`].
    pub async fn mark_active(&self, id: u32) {
        self.entries.lock().await.entry(id).or_default().viewers += 1;
    }

    /// A live-stream socket on `id` closed.
    pub async fn mark_inactive(&self, id: u32) {
        let mut entries = self.entries.lock().await;
        let entry = entries.entry(id).or_default();
        entry.viewers = entry.viewers.saturating_sub(1);
    }

    /// Record a failure. The previous error is replaced — only the most recent one is reported.
    pub async fn record(&self, id: u32, error: impl Into<String>) {
        let entry = &mut *self.entries.lock().await;
        let entry = entry.entry(id).or_default();
        entry.last_error = Some(error.into());
        entry.timestamp = Some(chrono::Utc::now().to_rfc3339());
    }

    pub async fn info(&self, id: u32) -> StreamErrorInfo {
        let entries = self.entries.lock().await;
        match entries.get(&id) {
            Some(e) => StreamErrorInfo {
                last_error: e.last_error.clone(),
                timestamp: e.timestamp.clone(),
                active_stream: e.viewers > 0,
                viewers: e.viewers,
            },
            None => StreamErrorInfo {
                last_error: None,
                timestamp: None,
                active_stream: false,
                viewers: 0,
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_unknown_device_reports_no_error_and_no_stream() {
        let store = StreamErrorStore::new();
        let info = store.info(42).await;
        assert!(info.last_error.is_none());
        assert!(info.timestamp.is_none());
        assert!(!info.active_stream);
    }

    #[tokio::test]
    async fn the_error_outlives_the_stream_that_produced_it() {
        let store = StreamErrorStore::new();
        store.mark_active(0).await;
        store.record(0, "Camera disconnected").await;
        store.mark_inactive(0).await;

        // The point of the store: the socket is gone but the reason is still retrievable.
        let info = store.info(0).await;
        assert_eq!(info.last_error.as_deref(), Some("Camera disconnected"));
        assert!(info.timestamp.is_some());
        assert!(!info.active_stream);
    }

    #[tokio::test]
    async fn a_leaving_viewer_leaves_the_running_stream_active() {
        let store = StreamErrorStore::new();
        store.mark_active(0).await;
        // A second viewer joins and leaves.
        store.mark_active(0).await;
        assert_eq!(store.info(0).await.viewers, 2);
        store.mark_inactive(0).await;
        assert!(store.info(0).await.active_stream, "the first viewer still watches");
        assert_eq!(store.info(0).await.viewers, 1);

        store.mark_inactive(0).await;
        assert!(!store.info(0).await.active_stream);
        // An unbalanced close must not wrap around and report a stream that isn't there.
        store.mark_inactive(0).await;
        assert!(!store.info(0).await.active_stream);
        store.mark_active(0).await;
        assert!(store.info(0).await.active_stream);
    }
}

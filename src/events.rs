//! What happens on the server, as events for `GET /events`.
//!
//! One [`EventBus`] per server: a `tokio::sync::broadcast` channel whose events carry a global
//! `seq`. A subscriber that falls more than the bus capacity behind loses events; its socket then
//! sends `resync`, and the client reads the state again. State events carry the complete
//! [`DeviceState`], not deltas, so a client never has to replay anything.

use std::sync::{Arc, Mutex, MutexGuard};

use chrono::SecondsFormat;
use serde::Serialize;
use tokio::sync::broadcast;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::models::access::Mode;
use crate::models::device_models::CloseReason;
use crate::models::session::{ClientRef, EndReason};

/// One message on the events socket: `{"seq":118,"time":"…","type":"feature_changed",…}`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct Event {
    /// Global and increasing. Clients use it only to notice gaps.
    pub seq: u64,
    /// RFC 3339 with milliseconds, UTC.
    pub time: String,
    #[serde(flatten)]
    pub kind: EventKind,
}

impl Event {
    pub fn new(seq: u64, kind: EventKind) -> Self {
        Self { seq, time: chrono::Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true), kind }
    }
}

/// The event types, tagged by `type`.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventKind {
    /// The first message on a socket: who you are and every connected device. Its `seq` is the
    /// last one the snapshot includes.
    Hello { session: HelloSession, devices: Vec<DeviceState> },
    /// A device's complete state, after it changed.
    DeviceState {
        #[serde(flatten)]
        state: DeviceState,
        cause: StateCause,
        /// Why a device was closed; `null` for every other cause.
        reason: Option<CloseReason>,
        /// Who made the change; `null` for anonymous clients and the server itself.
        by: Option<ClientRef>,
    },
    /// A feature was written. It carries no value, since a write changes dependent features too:
    /// read again what you display.
    FeatureChanged { device: u32, feature: String, by: Option<ClientRef> },
    /// A command feature was executed.
    CommandExecuted { device: u32, command: String, by: Option<ClientRef> },
    /// A client lost its lease, its membership or its live capture or burst to another session's
    /// forced lease.
    AccessRevoked { device: u32, client_id: String, by: Option<ClientRef> },
    /// A session ended.
    SessionEnded { client_id: String, reason: EndReason },
    /// This socket fell behind and lost events: read the state again.
    Resync,
}

/// `hello.session`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct HelloSession {
    pub client_id: String,
    pub timeout_s: u64,
}

/// Everything about a device another client may want to show.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
pub struct DeviceState {
    pub device: u32,
    pub connected: bool,
    pub access: AccessState,
    /// The running live capture, or `null`.
    pub stream: Option<StreamState>,
    /// The running burst job, or `null`.
    pub burst: Option<BurstState>,
}

/// Who may use the device and who does.
#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
pub struct AccessState {
    pub mode: Mode,
    /// The session holding the device's lease; `null` on a `shared` device.
    pub owner: Option<ClientRef>,
    /// The sessions that connected to or used the device, in the order they joined.
    pub members: Vec<ClientRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
pub struct StreamState {
    pub viewers: u32,
    pub pixel_format: String,
    pub bit_depth: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize, ToSchema)]
pub struct BurstState {
    pub job_id: Uuid,
    /// The session that started it; `null` for an anonymous one.
    pub client_id: Option<String>,
}

/// What a `device_state` event reports a change of.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum StateCause {
    Connected,
    Disconnected,
    /// Membership or the lease changed.
    Access,
    Stream,
    Burst,
}

/// The server's event channel.
pub struct EventBus {
    tx: broadcast::Sender<Arc<Event>>,
    /// The last `seq` handed out. Held while sending, so events enter the channel in `seq` order.
    seq: Mutex<u64>,
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (tx, _) = broadcast::channel(capacity.max(1));
        Self { tx, seq: Mutex::new(0) }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Event>> {
        self.tx.subscribe()
    }

    /// Number and send `kind`. Synchronous and never blocks, so it can be called from a capture
    /// loop or under a store's lock. Returns the event's `seq`.
    pub fn emit(&self, kind: EventKind) -> u64 {
        let mut seq = self.lock();
        *seq += 1;
        // No subscribers is not an error: nobody is listening.
        let _ = self.tx.send(Arc::new(Event::new(*seq, kind)));
        *seq
    }

    /// The `seq` of the last event sent.
    pub fn seq(&self) -> u64 {
        *self.lock()
    }

    fn lock(&self) -> MutexGuard<'_, u64> {
        self.seq.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn events_arrive_numbered_in_order() {
        let bus = EventBus::new(8);
        let mut rx = bus.subscribe();
        bus.emit(EventKind::Resync);
        bus.emit(EventKind::CommandExecuted { device: 0, command: "TriggerSoftware".into(), by: None });
        assert_eq!(rx.recv().await.unwrap().seq, 1);
        assert_eq!(rx.recv().await.unwrap().seq, 2);
        assert_eq!(bus.seq(), 2);
    }

    #[test]
    fn an_event_serialises_flat_with_its_type() {
        let state = DeviceState {
            device: 0,
            connected: true,
            access: AccessState { mode: Mode::Shared, owner: None, members: vec![] },
            stream: None,
            burst: None,
        };
        let event = Event::new(
            7,
            EventKind::DeviceState {
                state,
                cause: StateCause::Disconnected,
                reason: Some(CloseReason::Idle),
                by: Some(ClientRef { client_id: "3f2a9c1e".into(), name: None }),
            },
        );
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(json["seq"], 7);
        assert_eq!(json["type"], "device_state");
        assert_eq!(json["device"], 0);
        assert_eq!(json["access"]["mode"], "shared");
        assert_eq!(json["cause"], "disconnected");
        assert_eq!(json["reason"], "idle");
        assert_eq!(json["by"]["client_id"], "3f2a9c1e");
        assert!(json["time"].as_str().unwrap().ends_with('Z'));

        let json = serde_json::to_value(Event::new(8, EventKind::Resync)).unwrap();
        assert_eq!(json, serde_json::json!({"seq": 8, "time": json["time"], "type": "resync"}));
    }
}

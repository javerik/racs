use std::sync::Arc;
use crate::controller::device_ctrl::DeviceCtrl;
use crate::controller::grab_ctrl::GrabCtrl;
use crate::controller::stream_ctrl::StreamCtrl;
use crate::events::EventBus;
use crate::models::stream_errors::StreamErrorStore;
use crate::server_config::RuntimeConfig;
use crate::stores::camera_store::CameraStore;
use crate::stores::client_store::ClientStore;
use crate::stores::job_store::JobStore;

pub type ArcBoxedDeviceCtrl = Arc<Box<DeviceCtrl>>;
pub type ArcBoxedCameraStore = Arc<Box<CameraStore>>;

pub type ArcBoxedStreamCtrl = Arc<Box<StreamCtrl>>;
pub type ArcBoxedGrabCtrl = Arc<Box<GrabCtrl>>;

#[derive(Clone)]
pub struct AppContext {
    pub dev_ctrl: ArcBoxedDeviceCtrl,
    pub stream_ctrl: ArcBoxedStreamCtrl,
    /// Starts and runs burst grab jobs. Shares `job_store` with the endpoints that read them.
    pub grab_ctrl: ArcBoxedGrabCtrl,
    /// Burst job records and their captured images, read directly by the job endpoints — the
    /// controller is only needed to *start* a job.
    pub job_store: Arc<JobStore>,
    /// Why the last live stream on a device ended. Outlives the WebSocket that produced it, so
    /// `GET /devices/{id}/stream/error` can still answer.
    pub stream_errors: Arc<StreamErrorStore>,
    /// Sessions, device memberships and holders.
    pub clients: Arc<ClientStore>,
    /// What `GET /events` sends.
    pub events: Arc<EventBus>,
    /// The timeouts and intervals of sessions, the idle sweep and the sockets' pings.
    pub runtime: RuntimeConfig,
}

impl AppContext {
    /// The server's state with nothing connected. The only way an `AppContext` is built — by
    /// `main`, the fake server and the tests alike — so they all wire the stores up the same way.
    pub async fn new(runtime: RuntimeConfig) -> Self {
        let cam_store: ArcBoxedCameraStore = Arc::new(Box::new(CameraStore::new()));
        let job_store = Arc::new(JobStore::new());
        let events = Arc::new(EventBus::new(runtime.event_capacity));
        let clients = Arc::new(ClientStore::new(events.clone(), &runtime));
        let stream_errors = Arc::new(StreamErrorStore::new());
        let dev_ctrl = DeviceCtrl::new(cam_store.clone(), job_store.clone(), clients.clone(), events.clone())
            .await
            .unwrap_or_else(|e| panic!("Failed to create devicectl => {e}"));
        Self {
            dev_ctrl: Arc::new(Box::new(dev_ctrl)),
            stream_ctrl: Arc::new(Box::new(StreamCtrl::new(cam_store.clone(), clients.clone(), stream_errors.clone()))),
            grab_ctrl: Arc::new(Box::new(GrabCtrl::new(cam_store, job_store.clone(), clients.clone()))),
            job_store,
            stream_errors,
            clients,
            events,
            runtime,
        }
    }
}

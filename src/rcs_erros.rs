use crate::controller::device_ctrl::DeviceCtrlError;
use crate::controller::stream_ctrl::StreamCtrlError;
use crate::models::access::AccessError;
use crate::stores::camera_store::StoreError;
use crate::thread_stream::ThreadStreamError;
use std::fmt::{Display, Formatter};

#[derive(Debug)]
pub enum RcsError {
    TsError(ThreadStreamError),
    StoreError(StoreError),
    DevCtrlError(DeviceCtrlError),
    StreamCtrlError(StreamCtrlError),
    GenICamError(String),
    AravisError(aravis_port::Error),
    /// A blocking camera task failed to run to completion (panicked or was cancelled).
    Blocking(String),
    ValueError(Option<String>),
    /// Refused by the device's access mode. Rendered as its JSON refusal, not as a `500`.
    Access(AccessError),
}

impl From<ThreadStreamError> for RcsError {
    fn from(value: ThreadStreamError) -> Self {
        RcsError::TsError(value)
    }
}

impl From<AccessError> for RcsError {
    fn from(value: AccessError) -> Self {
        RcsError::Access(value)
    }
}

impl From<StoreError> for RcsError {
    fn from(value: StoreError) -> Self {
        RcsError::StoreError(value)
    }
}

impl From<StreamCtrlError> for RcsError {
    fn from(value: StreamCtrlError) -> Self {
        RcsError::StreamCtrlError(value)
    }
}

impl From<DeviceCtrlError> for RcsError {
    fn from(value: DeviceCtrlError) -> Self {
        RcsError::DevCtrlError(value)
    }
}

impl From<aravis_port::Error> for RcsError {
    fn from(value: aravis_port::Error) -> Self {
        RcsError::AravisError(value)
    }
}

impl Display for RcsError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            RcsError::TsError(e) => write!(f, "Thread stream error: {}", e),
            RcsError::StoreError(e) => write!(f, "Store error: {}", e),
            RcsError::DevCtrlError(e) => write!(f, "Device control error: {}", e),
            RcsError::StreamCtrlError(e) => write!(f, "Stream control error: {}", e),
            RcsError::GenICamError(e) => write!(f, "GenICam error: {}", e),
            RcsError::AravisError(e) => write!(f, "Aravis lib error: {:?}", e),
            RcsError::Blocking(e) => write!(f, "Camera task error: {e}"),
            RcsError::Access(e) => write!(f, "Access refused: {e}"),
            RcsError::ValueError(msg) => {
                if let Some(m) = msg {
                    write!(f, "Value error: {m}")
                } else {
                    write!(f, "Value error")
                }
            }
        }
    }
}

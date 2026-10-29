use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::models::access::DeviceAccess;

#[derive(Clone, Deserialize, Serialize, ToSchema)]
pub struct DeviceDiscoverInfo {
    pub id: u32,
    pub dev_id: String,
    pub serial_number: String,
    pub vendor: String,
    pub model: String,
    pub manufacturer_info: String,
    pub ip: String,
    pub mac: String,
}

/// An entry of `GET /devices/connected`: the device and its access state.
#[derive(Clone, Deserialize, Serialize, ToSchema)]
pub struct ConnectedDevice {
    #[serde(flatten)]
    pub info: DeviceDiscoverInfo,
    /// Who may use the device and who does, as the asking client sees it.
    pub access: DeviceAccess,
}

#[derive(Clone, Deserialize, Serialize, ToSchema)]
pub struct DeviceConnections {
    pub available: Vec<DeviceDiscoverInfo>,
    pub connected: Vec<DeviceDiscoverInfo>
}

impl DeviceConnections {


    /// Creates new instance of DeviceConnections
    ///
    /// This function will make sure there are no duplicates by removing connected from available
    pub fn new(available: Vec<DeviceDiscoverInfo>, connected: Vec<DeviceDiscoverInfo>) -> Self {
        let connected_ids: Vec<u32> = connected.iter().map(move |x| x.id).collect();
        let available: Vec<DeviceDiscoverInfo> = available.iter()
            .filter(move |x| !connected_ids.contains(&x.id))
            .cloned().collect();
        Self {
            connected,
            available
        }
    }

    pub fn get_available_by_mac(&self, mac: &str) -> Option<&DeviceDiscoverInfo> {
        self.available.iter().find(|x| x.mac == mac)
    }

}

/// Why a device was closed. Carried by the slot's stop signal, so a capture loop that ends because
/// of it can tell its client why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum CloseReason {
    /// `PUT /devices/{id}/disconnect`.
    Request,
    /// No client has used the device for the idle timeout.
    Idle,
    /// A session forced the device closed.
    Forced,
    /// The server closed it after a failure.
    Error,
}

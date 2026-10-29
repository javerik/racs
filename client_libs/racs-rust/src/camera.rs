use uuid::Uuid;

use crate::burst::BurstJob;
use crate::client::RacsClient;
use crate::error::{Error, Result};
use crate::frame::Frame;
use crate::live::LiveStream;
use crate::models::{
    AutoPacketSize, BurstRequest, DeviceAccess, DeviceDiscoverInfo, DisconnectResult, FeatureState,
    GenICamNodeCategory, GenICamNodeInfo, LiveOptions, Mode, PacketSizeInfo, StreamErrorInfo,
};
use crate::value::{FromFeatureValue, IntoFeatureValue};

/// One device on a RACS server. Every call goes to the server; the handle only holds the id.
///
/// Get one from [`RacsClient::camera`], [`RacsClient::connect`] or [`RacsClient::cameras`]:
///
/// ```no_run
/// # async fn demo() -> racs_client::Result<()> {
/// let client = racs_client::RacsClient::new("http://localhost:8742")?;
/// let cam = client.connect(0, None).await?;
/// cam.set("ExposureTime", 5000.0).await?;
/// let width: u32 = cam.get("Width").await?;
/// # Ok(()) }
/// ```
#[derive(Debug, Clone)]
pub struct Camera {
    client: RacsClient,
    id: u32,
}

impl Camera {
    pub(crate) fn new(client: RacsClient, id: u32) -> Self {
        Self { client, id }
    }

    pub fn id(&self) -> u32 {
        self.id
    }

    pub fn client(&self) -> &RacsClient {
        &self.client
    }

    // --- CONNECTION ---

    /// The device's identity as the server reports it. [`Error::Protocol`] if it is not connected.
    pub async fn info(&self) -> Result<DeviceDiscoverInfo> {
        self.client
            .get_connected_devices()
            .await?
            .into_iter()
            .find(|d| d.id == self.id)
            .ok_or_else(|| Error::Protocol(format!("device {} is not connected", self.id)))
    }

    pub async fn is_connected(&self) -> Result<bool> {
        Ok(self.client.get_connected_devices().await?.iter().any(|d| d.id == self.id))
    }

    /// Connects the device, by discovery or at `ip`, and joins it in its current mode. Only joins
    /// if it is connected already.
    pub async fn connect(&self, ip: Option<&str>) -> Result<DeviceAccess> {
        self.client.connect_device(self.id, ip, None).await
    }

    /// Connects the device and takes its lease in `mode`, in one step: `ro-shared` (only this
    /// client writes), `exclusive` (only this client uses it) or `shared`.
    /// [`Error::DeviceLocked`] if another session owns it, [`Error::DeviceInUse`] for `exclusive`
    /// while other clients use it; [`take`](Self::take) with `force` overrides both.
    pub async fn connect_as(&self, mode: Mode, ip: Option<&str>) -> Result<DeviceAccess> {
        self.client.connect_device(self.id, ip, Some(mode)).await
    }

    /// Leaves the device. It closes once no other client uses it; the answer says whether it did.
    pub async fn disconnect(&self) -> Result<DisconnectResult> {
        self.client.disconnect_device(self.id, false).await
    }

    /// Closes the device for every client. Needs write permission.
    pub async fn force_disconnect(&self) -> Result<DisconnectResult> {
        self.client.disconnect_device(self.id, true).await
    }

    // --- ACCESS ---

    /// Who may use the device and who does, and this client's role.
    pub async fn access(&self) -> Result<DeviceAccess> {
        self.client.get_device_access(self.id).await
    }

    /// Takes or changes the device's lease; `Mode::Shared` gives it up. With `force`, takes it
    /// from another session ([`Error::DeviceLocked`] without), and for `exclusive` evicts the other
    /// clients: their live streams end with [`Error::AccessRevoked`] and their bursts are cancelled
    /// ([`Error::DeviceInUse`] without).
    pub async fn take(&self, mode: Mode, force: bool) -> Result<DeviceAccess> {
        self.client.set_device_access(self.id, mode, force).await
    }

    /// Releases this client's lease, or with `force` breaks another session's. The device is
    /// `shared` again.
    pub async fn release(&self, force: bool) -> Result<DeviceAccess> {
        self.client.release_device_access(self.id, force).await
    }

    /// The device's GenICam XML.
    pub async fn xml(&self) -> Result<String> {
        self.client.get_device_xml(self.id).await
    }

    /// The GenICam categories and their features.
    pub async fn categories(&self) -> Result<Vec<GenICamNodeCategory>> {
        self.client.get_device_gc_categories(self.id).await
    }

    /// A feature's description from the categories: type, access, enum entries, ...
    pub async fn feature_info(&self, name: &str) -> Result<GenICamNodeInfo> {
        self.categories()
            .await?
            .into_iter()
            .flat_map(|c| c.nodes)
            .find(|n| n.name == name)
            .ok_or_else(|| Error::feature(name, "Feature not found"))
    }

    // --- FEATURES ---

    /// A feature's live state: value, availability, lock, bounds.
    pub async fn state(&self, name: &str) -> Result<FeatureState> {
        self.states([name])
            .await?
            .pop()
            .ok_or_else(|| Error::Protocol("empty feature state response".into()))
    }

    /// The live state of several features in one request, in the order asked.
    pub async fn states(&self, names: impl IntoIterator<Item = impl AsRef<str>>) -> Result<Vec<FeatureState>> {
        self.client.get_device_gc_feature_states(self.id, names).await
    }

    /// A feature's value as `T`: an integer type for Integer and Enum features (enums are read as
    /// their integer value), a float for Float, `bool`, `String`, or [`FeatureValue`](crate::FeatureValue)
    /// to take whatever it is. `Option<T>` gives `None` for a command or a feature that is unavailable
    /// right now. [`Error::Feature`] for an unknown feature, a failed read or a type mismatch.
    pub async fn get<T: FromFeatureValue>(&self, name: &str) -> Result<T> {
        T::from_feature_value(name, self.state(name).await?.typed_value()?)
    }

    /// Writes a feature: a number, a `bool`, or a string (an enum takes its integer value or its
    /// entry name).
    pub async fn set(&self, name: &str, value: impl IntoFeatureValue) -> Result<()> {
        self.client.set_device_gc_node_value(self.id, name, &value.into_feature_string()).await
    }

    /// Executes a command feature such as `TriggerSoftware` or `UserSetLoad`.
    pub async fn execute(&self, command: &str) -> Result<()> {
        self.client.execute_device_gc_command(self.id, command).await
    }

    // --- FRAMES ---

    /// One frame as a JPEG file (Mono8), at `quality` 1-100 or the server's default.
    pub async fn grab_jpeg(&self, quality: Option<u8>) -> Result<Vec<u8>> {
        self.client.grab_jpg_frame(self.id, quality).await
    }

    /// One raw Mono8 frame with its size.
    pub async fn grab_raw(&self) -> Result<Frame> {
        let data = self.client.grab_raw_frame(self.id).await?;
        let size = self.states(["Width", "Height"]).await?;
        let dimension = |i: usize| u32::from_feature_value(&size[i].name, size[i].typed_value()?);
        let (width, height) = (dimension(0)?, dimension(1)?);
        if data.len() != width as usize * height as usize {
            return Err(Error::Protocol(format!(
                "raw frame of {} bytes does not match {width}x{height}; was the size changed?",
                data.len()
            )));
        }
        Ok(Frame::mono8(data, width, height))
    }

    /// Why the last live stream ended, and whether one runs now.
    pub async fn stream_error(&self) -> Result<StreamErrorInfo> {
        self.client.get_stream_error(self.id).await
    }

    /// The stream packet size, the sizes it may take and the link MTU. Every grab, stream and
    /// burst uses it as it is; change it with `cam.set("GevSCPSPacketSize", 7960)` or
    /// [`auto_packet_size`](Self::auto_packet_size).
    pub async fn packet_size(&self) -> Result<PacketSizeInfo> {
        self.client.get_packet_size(self.id).await
    }

    /// Finds the largest packet size that reaches the server, with test packets, and sets it.
    pub async fn auto_packet_size(&self) -> Result<AutoPacketSize> {
        self.client.auto_packet_size(self.id).await
    }

    /// Starts a live stream:
    ///
    /// ```no_run
    /// # async fn demo(cam: racs_client::Camera) -> racs_client::Result<()> {
    /// use racs_client::{LiveOptions, PixelDepth};
    /// let mut live = cam.live(&LiveOptions::raw().pixel_depth(PixelDepth::Mono16)).await?;
    /// while let Some(frame) = live.next_frame().await? {
    ///     let pixels = frame.to_u16()?;
    /// }
    /// # Ok(()) }
    /// ```
    pub async fn live(&self, options: &LiveOptions) -> Result<LiveStream> {
        self.client.stream_live(self.id, options).await
    }

    // --- BURST JOBS ---

    /// Starts a background burst on the server.
    pub async fn burst(&self, request: &BurstRequest) -> Result<BurstJob> {
        let created = self.client.start_grab_job(self.id, request).await?;
        Ok(BurstJob::new(self.clone(), created.job_id))
    }

    /// A handle for an existing burst job of this device.
    pub fn job(&self, job_id: Uuid) -> BurstJob {
        BurstJob::new(self.clone(), job_id)
    }
}

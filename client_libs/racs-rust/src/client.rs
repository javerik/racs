use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::{Method, RequestBuilder, Response};
use serde::de::DeserializeOwned;
use url::Url;
use uuid::Uuid;

use crate::camera::Camera;
use crate::error::{Error, Result};
use crate::events::EventStream;
use crate::live::LiveStream;
use crate::models::{
    AutoPacketSize, BurstJobCreated, BurstJobInfo, BurstRequest, DeviceAccess, DeviceConnections, DeviceDiscoverInfo,
    DisconnectResult, FeatureState, GenICamNodeCategory, ImageEntry, LiveOptions, Mode, PacketSizeInfo, SessionCreated,
    SessionInfo, StreamErrorInfo,
};

const API_PATH: &str = "/api/v1/";

/// The header every request of a session carries.
pub(crate) const SESSION_HEADER: &str = "X-Racs-Session";

/// How long [`RacsClient::keep_alive`] waits before trying again after a failed heartbeat.
const HEARTBEAT_RETRY: Duration = Duration::from_secs(1);

/// The API root with a trailing slash; a bare server URL such as `http://host:8742` gets `/api/v1`.
pub(crate) fn normalize_base_url(base_url: &str) -> Result<Url> {
    let mut url = Url::parse(base_url.trim_end_matches('/'))?;
    if url.path() == "/" || url.path().is_empty() {
        url.set_path(API_PATH);
    } else {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url)
}

/// The client's session, shared by its clones.
#[derive(Debug)]
struct SessionState {
    /// No session at all: requests are anonymous, as with a 0.3 client.
    anonymous: bool,
    /// The name other clients see.
    name: Mutex<Option<String>>,
    /// The timeout asked for; the server's default when `None`.
    timeout_s: Option<u64>,
    /// The session in use, once the first request created it.
    current: Mutex<Option<SessionCreated>>,
    /// Set by [`RacsClient::close`]; ends [`RacsClient::keep_alive`].
    closed: AtomicBool,
    /// Held while a session is created, so concurrent first requests (or renewals) create one.
    opening: futures_util::lock::Mutex<()>,
}

/// HTTP client for a RACS server.
///
/// The methods here map one to one onto the REST routes and take the device id each time. For
/// day-to-day use, get a [`Camera`] from [`camera`](Self::camera), [`connect`](Self::connect) or
/// [`cameras`](Self::cameras) instead: it holds the id and adds typed feature access, live
/// streaming and burst jobs. Cloning is cheap and shares the connection pool and the session.
///
/// # Sessions
///
/// The client identifies itself to the server with a session, which it creates with its first
/// request and sends with every request after it (`X-Racs-Session`, `?session=` on WebSockets).
/// Other clients see it by its `client_id` and name. A session that sends no request for its
/// timeout (30 s by default) ends, so spawn [`keep_alive`](Self::keep_alive) to keep an idle
/// client's session (and the device leases it holds) alive. A request that finds its session
/// expired starts a new one and is sent again, once. [`close`](Self::close) ends the session.
/// [`RacsClientBuilder::anonymous`] makes a client without a session, as before 0.4: it may only
/// use `shared` devices.
#[derive(Debug, Clone)]
pub struct RacsClient {
    http: reqwest::Client,
    base: Url,
    session: Arc<SessionState>,
}

/// Configures a [`RacsClient`]: [`RacsClient::builder`].
#[derive(Debug)]
pub struct RacsClientBuilder {
    base_url: String,
    http: Option<reqwest::Client>,
    name: Option<String>,
    timeout_s: Option<u64>,
    anonymous: bool,
}

impl RacsClientBuilder {
    /// The name other clients see, e.g. `line-script`.
    pub fn name(mut self, name: impl Into<String>) -> Self {
        self.name = Some(name.into());
        self
    }

    /// Seconds the session lives without a heartbeat; the server clamps it to 5..=600. The
    /// server's `--session-timeout` (30 s) when not set.
    pub fn session_timeout_s(mut self, seconds: u64) -> Self {
        self.timeout_s = Some(seconds);
        self
    }

    /// No session: every request is anonymous. Such a client may only use `shared` devices
    /// (meta routes on the others) and can't take a lease or subscribe to events.
    pub fn anonymous(mut self) -> Self {
        self.anonymous = true;
        self
    }

    /// A configured `reqwest::Client` (timeouts, proxy, ...) instead of one with a 10 s timeout.
    pub fn http_client(mut self, http: reqwest::Client) -> Self {
        self.http = Some(http);
        self
    }

    pub fn build(self) -> Result<RacsClient> {
        let http = match self.http {
            Some(http) => http,
            None => reqwest::Client::builder().timeout(Duration::from_secs(10)).build()?,
        };
        Ok(RacsClient {
            http,
            base: normalize_base_url(&self.base_url)?,
            session: Arc::new(SessionState {
                anonymous: self.anonymous,
                name: Mutex::new(self.name),
                timeout_s: self.timeout_s,
                current: Mutex::new(None),
                closed: AtomicBool::new(false),
                opening: futures_util::lock::Mutex::new(()),
            }),
        })
    }
}

impl RacsClient {
    /// A client for the API root, e.g. `http://localhost:8742/api/v1`. A bare server URL such as
    /// `http://localhost:8742` gets `/api/v1` added. Requests time out after 10 s. It creates a
    /// session with its first request; see [`builder`](Self::builder) for a name or none.
    pub fn new(base_url: &str) -> Result<Self> {
        Self::builder(base_url).build()
    }

    /// Like [`new`](Self::new), with a configured `reqwest::Client` (timeouts, proxy, ...).
    pub fn with_http_client(base_url: &str, http: reqwest::Client) -> Result<Self> {
        Self::builder(base_url).http_client(http).build()
    }

    /// Configures a client: its session's name and timeout, no session, the HTTP client.
    ///
    /// ```no_run
    /// # fn demo() -> racs_client::Result<()> {
    /// let client = racs_client::RacsClient::builder("http://localhost:8742").name("line-script").build()?;
    /// # Ok(()) }
    /// ```
    pub fn builder(base_url: &str) -> RacsClientBuilder {
        RacsClientBuilder { base_url: base_url.to_string(), http: None, name: None, timeout_s: None, anonymous: false }
    }

    /// The API root every route is relative to, ending in a slash.
    pub fn base_url(&self) -> &Url {
        &self.base
    }

    // --- CAMERA HANDLES ---

    /// A handle for device `device_id`. Makes no request; the device need not be connected yet.
    pub fn camera(&self, device_id: u32) -> Camera {
        Camera::new(self.clone(), device_id)
    }

    /// Connects device `device_id` (by discovery, or at `ip`) and returns its handle. The client
    /// joins the device in its current mode.
    pub async fn connect(&self, device_id: u32, ip: Option<&str>) -> Result<Camera> {
        self.connect_device(device_id, ip, None).await?;
        Ok(self.camera(device_id))
    }

    /// Connects device `device_id` and takes its lease in `mode` in one step, see
    /// [`Camera::connect_as`].
    pub async fn connect_as(&self, device_id: u32, mode: Mode, ip: Option<&str>) -> Result<Camera> {
        self.connect_device(device_id, ip, Some(mode)).await?;
        Ok(self.camera(device_id))
    }

    /// Handles for every device the server is connected to.
    pub async fn cameras(&self) -> Result<Vec<Camera>> {
        Ok(self.get_connected_devices().await?.into_iter().map(|d| self.camera(d.id)).collect())
    }

    // --- DEVICES ---

    /// Runs a network discovery. `GET /devices`
    pub async fn get_devices(&self) -> Result<DeviceConnections> {
        self.json(self.request(Method::GET, &["devices"])).await
    }

    /// The devices the server is connected to, without a discovery. `GET /devices/connected`
    pub async fn get_connected_devices(&self) -> Result<Vec<DeviceDiscoverInfo>> {
        self.json(self.request(Method::GET, &["devices", "connected"])).await
    }

    /// Connects a device by discovery, or at `ip` under the chosen id. With a `mode`, also takes
    /// the device's lease in that mode (needs a session); without one the client joins in the
    /// current mode. `PUT /devices/{id}/connect`
    pub async fn connect_device(&self, device_id: u32, ip: Option<&str>, mode: Option<Mode>) -> Result<DeviceAccess> {
        let mut url = self.url(&["devices", &device_id.to_string(), "connect"]);
        if let Some(ip) = ip {
            url.query_pairs_mut().append_pair("ip", ip);
        }
        if let Some(mode) = mode {
            url.query_pairs_mut().append_pair("mode", mode.as_str());
        }
        self.json(self.http.request(Method::PUT, url)).await
    }

    /// Leaves the device; it closes once no other client uses it. With `force`, closes it for
    /// everyone (needs write permission). `PUT /devices/{id}/disconnect`
    pub async fn disconnect_device(&self, device_id: u32, force: bool) -> Result<DisconnectResult> {
        let mut url = self.url(&["devices", &device_id.to_string(), "disconnect"]);
        if force {
            url.query_pairs_mut().append_pair("force", "true");
        }
        self.json(self.http.request(Method::PUT, url)).await
    }

    /// Who may use the device and who does. `GET /devices/{id}/access`
    pub async fn get_device_access(&self, device_id: u32) -> Result<DeviceAccess> {
        self.json(self.request(Method::GET, &["devices", &device_id.to_string(), "access"])).await
    }

    /// Takes or changes the device's lease (`shared` gives it up). With `force`, takes it from
    /// another session, or evicts the other clients for `exclusive`. `PUT /devices/{id}/access`
    pub async fn set_device_access(&self, device_id: u32, mode: Mode, force: bool) -> Result<DeviceAccess> {
        let body = serde_json::json!({ "mode": mode, "force": force });
        self.json(self.request(Method::PUT, &["devices", &device_id.to_string(), "access"]).json(&body)).await
    }

    /// Releases the device's lease, or with `force` breaks another session's.
    /// `DELETE /devices/{id}/access`
    pub async fn release_device_access(&self, device_id: u32, force: bool) -> Result<DeviceAccess> {
        let mut url = self.url(&["devices", &device_id.to_string(), "access"]);
        if force {
            url.query_pairs_mut().append_pair("force", "true");
        }
        self.json(self.http.request(Method::DELETE, url)).await
    }

    /// The device's GenICam XML. `GET /devices/{id}/xml`
    pub async fn get_device_xml(&self, device_id: u32) -> Result<String> {
        self.text(self.request(Method::GET, &["devices", &device_id.to_string(), "xml"])).await
    }

    // --- GENICAM ---

    /// `GET /devices/{id}/gc/categories`
    pub async fn get_device_gc_categories(&self, device_id: u32) -> Result<Vec<GenICamNodeCategory>> {
        self.json(self.request(Method::GET, &["devices", &device_id.to_string(), "gc", "categories"])).await
    }

    /// A feature value as the server formats it. `GET /devices/{id}/gc/feature/{name}`
    pub async fn get_device_gc_node_value(&self, device_id: u32, feature_name: &str) -> Result<String> {
        self.text(self.request(Method::GET, &["devices", &device_id.to_string(), "gc", "feature", feature_name])).await
    }

    /// `PUT /devices/{id}/gc/feature/{name}?value=...`
    pub async fn set_device_gc_node_value(&self, device_id: u32, feature_name: &str, value: &str) -> Result<()> {
        let mut url = self.url(&["devices", &device_id.to_string(), "gc", "feature", feature_name]);
        url.query_pairs_mut().append_pair("value", value);
        self.send(self.http.request(Method::PUT, url)).await.map(drop)
    }

    /// The live state of 1 to 256 features in one request, in the order asked. A problem with one
    /// feature is reported in that entry's `error`. `POST /devices/{id}/gc/features/state`
    pub async fn get_device_gc_feature_states(
        &self,
        device_id: u32,
        feature_names: impl IntoIterator<Item = impl AsRef<str>>,
    ) -> Result<Vec<FeatureState>> {
        let names: Vec<String> = feature_names.into_iter().map(|n| n.as_ref().to_string()).collect();
        let request = self
            .request(Method::POST, &["devices", &device_id.to_string(), "gc", "features", "state"])
            .json(&serde_json::json!({ "names": names }));
        self.json(request).await
    }

    /// Executes a command feature such as `TriggerSoftware`. `POST /devices/{id}/gc/command/{name}`
    pub async fn execute_device_gc_command(&self, device_id: u32, command_name: &str) -> Result<()> {
        let segments = ["devices", &device_id.to_string(), "gc", "command", command_name];
        self.send(self.request(Method::POST, &segments)).await.map(drop)
    }

    // --- FRAMES AND STREAMS ---

    /// One Mono8 frame as JPEG, at `quality` 1-100 or the server's default (80).
    /// `GET /devices/{id}/stream/frame/jpeg`
    pub async fn grab_jpg_frame(&self, device_id: u32, quality: Option<u8>) -> Result<Vec<u8>> {
        let mut url = self.url(&["devices", &device_id.to_string(), "stream", "frame", "jpeg"]);
        if let Some(quality) = quality {
            url.query_pairs_mut().append_pair("quality", &quality.to_string());
        }
        self.bytes(self.http.request(Method::GET, url)).await
    }

    /// One raw Mono8 frame: width*height bytes. `GET /devices/{id}/stream/frame/raw`
    pub async fn grab_raw_frame(&self, device_id: u32) -> Result<Vec<u8>> {
        self.bytes(self.request(Method::GET, &["devices", &device_id.to_string(), "stream", "frame", "raw"])).await
    }

    /// Why the last live stream on the device ended, and whether one runs now.
    /// `GET /devices/{id}/stream/error`
    pub async fn get_stream_error(&self, device_id: u32) -> Result<StreamErrorInfo> {
        self.json(self.request(Method::GET, &["devices", &device_id.to_string(), "stream", "error"])).await
    }

    /// The stream packet size (`GevSCPSPacketSize`), its bounds and the link MTU. Set it with
    /// [`set_device_gc_node_value`](Self::set_device_gc_node_value).
    /// `GET /devices/{id}/stream/packet-size`
    pub async fn get_packet_size(&self, device_id: u32) -> Result<PacketSizeInfo> {
        self.json(self.request(Method::GET, &["devices", &device_id.to_string(), "stream", "packet-size"])).await
    }

    /// Finds the largest packet size that reaches the server, with test packets, and sets it.
    /// Works during a live stream too, which carries on with the new size.
    /// `POST /devices/{id}/stream/packet-size/auto`
    pub async fn auto_packet_size(&self, device_id: u32) -> Result<AutoPacketSize> {
        let segments = ["devices", &device_id.to_string(), "stream", "packet-size", "auto"];
        self.json(self.request(Method::POST, &segments)).await
    }

    /// Opens the live-stream WebSocket. The camera is held until the stream is closed or dropped.
    /// `GET /devices/{id}/stream/live`
    pub async fn stream_live(&self, device_id: u32, options: &LiveOptions) -> Result<LiveStream> {
        let mut url = self.url(&["devices", &device_id.to_string(), "stream", "live"]);
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("format", options.format.as_str());
            if let Some(depth) = options.pixel_depth {
                query.append_pair("pixel_depth", depth.as_str());
            }
            if let Some(quality) = options.quality {
                query.append_pair("quality", &quality.to_string());
            }
            if let Some(fps) = options.fps {
                query.append_pair("fps", &fps.to_string());
            }
        }
        to_websocket(&mut url)?;
        let session = self.session_id().await?;
        match LiveStream::connect(self, device_id, with_session(&url, session), options.receive_timeout).await {
            Err(Error::SessionExpired(_)) if session.is_some() => {
                let session = self.renew_session(session).await?;
                LiveStream::connect(self, device_id, with_session(&url, session), options.receive_timeout).await
            }
            result => result,
        }
    }

    // --- BURST JOBS ---

    /// Starts a background burst. Returns before the capture starts: a busy camera shows up as a
    /// job that fails. `POST /devices/{id}/grab/jobs`
    pub async fn start_grab_job(&self, device_id: u32, request: &BurstRequest) -> Result<BurstJobCreated> {
        self.json(self.request(Method::POST, &["devices", &device_id.to_string(), "grab", "jobs"]).json(request))
            .await
    }

    /// `GET /devices/{id}/grab/jobs/{job_id}`
    pub async fn get_grab_job(&self, device_id: u32, job_id: Uuid) -> Result<BurstJobInfo> {
        let segments = ["devices", &device_id.to_string(), "grab", "jobs", &job_id.to_string()];
        self.json(self.request(Method::GET, &segments)).await
    }

    /// The frames a burst job has attempted so far, in capture order.
    /// `GET /devices/{id}/grab/jobs/{job_id}/images`
    pub async fn list_grab_job_images(&self, device_id: u32, job_id: Uuid) -> Result<Vec<ImageEntry>> {
        let segments = ["devices", &device_id.to_string(), "grab", "jobs", &job_id.to_string(), "images"];
        self.json(self.request(Method::GET, &segments)).await
    }

    /// One captured frame in the job's format. [`Error::NotFound`] for an index not captured (yet),
    /// [`Error::ImageFailed`] for one that failed. `GET /devices/{id}/grab/jobs/{job_id}/images/{index}`
    pub async fn get_grab_job_image(&self, device_id: u32, job_id: Uuid, index: u32) -> Result<Vec<u8>> {
        let segments =
            ["devices", &device_id.to_string(), "grab", "jobs", &job_id.to_string(), "images", &index.to_string()];
        self.bytes(self.request(Method::GET, &segments)).await
    }

    /// Cancels a running burst job or discards a finished one, with its images.
    /// `DELETE /devices/{id}/grab/jobs/{job_id}`
    pub async fn delete_grab_job(&self, device_id: u32, job_id: Uuid) -> Result<()> {
        let segments = ["devices", &device_id.to_string(), "grab", "jobs", &job_id.to_string()];
        self.send(self.request(Method::DELETE, &segments)).await.map(drop)
    }

    // --- SESSIONS ---

    /// The session in use, or `None` before the first request and for an anonymous client.
    pub fn session(&self) -> Option<SessionCreated> {
        self.session.current.lock().unwrap().clone()
    }

    /// Creates the session now unless there is one; `None` for an anonymous client.
    pub async fn start_session(&self) -> Result<Option<SessionCreated>> {
        self.session_id().await?;
        Ok(self.session())
    }

    /// Renames this client's session (and the sessions it starts later). Other clients see the
    /// new name from then on.
    pub async fn rename(&self, name: Option<&str>) -> Result<()> {
        *self.session.name.lock().unwrap() = name.map(str::to_string);
        let Some(session) = self.session().map(|s| s.session_id) else {
            return Ok(());
        };
        match self.rename_session(session, name).await {
            // It expired: the next one gets the name.
            Err(Error::SessionExpired(_)) => Ok(()),
            result => result,
        }
    }

    /// Sends a heartbeat every `heartbeat_interval_s` until [`close`](Self::close), creating the
    /// session first and a new one when it expired. Spawn it for a client that may go quiet for
    /// longer than its session timeout while it holds a device:
    ///
    /// ```no_run
    /// # async fn demo() -> racs_client::Result<()> {
    /// let client = racs_client::RacsClient::new("http://localhost:8742")?;
    /// tokio::spawn(client.clone().keep_alive());
    /// # Ok(()) }
    /// ```
    ///
    /// Failed heartbeats (the server unreachable) are retried; it returns at once for an
    /// anonymous client.
    pub async fn keep_alive(self) {
        if self.session.anonymous {
            return;
        }
        let mut session = None;
        loop {
            if self.session.closed.load(Ordering::SeqCst) {
                return;
            }
            let Some(current) = session.take() else {
                match self.session_id().await {
                    Ok(id) => session = id,
                    Err(_) => tokio::time::sleep(HEARTBEAT_RETRY).await,
                }
                continue;
            };
            let interval = self.session().map_or(1, |s| s.heartbeat_interval_s.max(1));
            tokio::time::sleep(Duration::from_secs(interval)).await;
            if self.session.closed.load(Ordering::SeqCst) {
                return;
            }
            // A request or a renewal since may have replaced the session.
            let id = self.session().map(|s| s.session_id).unwrap_or(current);
            session = match self.heartbeat(id).await {
                Ok(()) => Some(id),
                Err(Error::SessionExpired(_)) => self.renew_session(Some(id)).await.ok().flatten(),
                Err(_) => Some(id),
            };
        }
    }

    /// Ends the session: its device leases are released, its live streams closed and it leaves its
    /// devices. Stops [`keep_alive`](Self::keep_alive). A later request starts a new session.
    pub async fn close(&self) -> Result<()> {
        self.session.closed.store(true, Ordering::SeqCst);
        let session = self.session.current.lock().unwrap().take();
        match session {
            Some(session) => self.end_session(session.session_id).await,
            None => Ok(()),
        }
    }

    /// A WebSocket of what happens on the server: device state changes, feature writes and
    /// commands by other clients, revoked leases, ended sessions. Needs a session; the socket is
    /// one of its heartbeats while it is read. `GET /events?session=`
    pub async fn events(&self) -> Result<EventStream> {
        let mut url = self.url(&["events"]);
        to_websocket(&mut url)?;
        let session = self.session_id().await?;
        match EventStream::connect(with_session(&url, session)).await {
            Err(Error::SessionExpired(_)) if session.is_some() => {
                let session = self.renew_session(session).await?;
                EventStream::connect(with_session(&url, session)).await
            }
            result => result,
        }
    }

    /// Creates a session. Clients do this themselves with their first request.
    /// `POST /sessions`
    pub async fn create_session(&self, name: Option<&str>, timeout_s: Option<u64>) -> Result<SessionCreated> {
        let body = serde_json::json!({ "name": name, "timeout_s": timeout_s });
        let response = self.send_plain(self.request(Method::POST, &["sessions"]).json(&body)).await?;
        Ok(serde_json::from_slice(&response.bytes().await?)?)
    }

    /// Keeps a session alive. [`Error::SessionExpired`] once it has ended.
    /// `POST /sessions/{session_id}/heartbeat`
    pub async fn heartbeat(&self, session_id: Uuid) -> Result<()> {
        let segments = ["sessions", &session_id.to_string(), "heartbeat"];
        self.send_plain(self.request(Method::POST, &segments)).await.map(drop)
    }

    /// `PATCH /sessions/{session_id}`
    pub async fn rename_session(&self, session_id: Uuid, name: Option<&str>) -> Result<()> {
        let request = self.request(Method::PATCH, &["sessions", &session_id.to_string()]);
        self.send_plain(request.json(&serde_json::json!({ "name": name }))).await.map(drop)
    }

    /// Ends a session now. Succeeds for an unknown one too. `DELETE /sessions/{session_id}`
    pub async fn end_session(&self, session_id: Uuid) -> Result<()> {
        self.send_plain(self.request(Method::DELETE, &["sessions", &session_id.to_string()])).await.map(drop)
    }

    /// The server's sessions, without their secret ids. `GET /sessions`
    pub async fn list_sessions(&self) -> Result<Vec<SessionInfo>> {
        self.json(self.request(Method::GET, &["sessions"])).await
    }

    /// The session id to send, creating the session with the first request.
    async fn session_id(&self) -> Result<Option<Uuid>> {
        if self.session.anonymous {
            return Ok(None);
        }
        if let Some(session) = self.session() {
            return Ok(Some(session.session_id));
        }
        let _opening = self.session.opening.lock().await;
        if let Some(session) = self.session() {
            return Ok(Some(session.session_id));
        }
        self.open_session().await.map(Some)
    }

    /// A new session in place of `stale`, unless another request has replaced it already.
    async fn renew_session(&self, stale: Option<Uuid>) -> Result<Option<Uuid>> {
        let _opening = self.session.opening.lock().await;
        match self.session() {
            Some(session) if Some(session.session_id) != stale => Ok(Some(session.session_id)),
            _ => self.open_session().await.map(Some),
        }
    }

    /// Creates the session and makes it the one in use. Called under `opening`.
    async fn open_session(&self) -> Result<Uuid> {
        let name = self.session.name.lock().unwrap().clone();
        let created = self.create_session(name.as_deref(), self.session.timeout_s).await?;
        let id = created.session_id;
        *self.session.current.lock().unwrap() = Some(created);
        self.session.closed.store(false, Ordering::SeqCst);
        Ok(id)
    }

    // --- HELPERS ---

    /// The route below the API root, each segment percent-encoded.
    fn url(&self, segments: &[&str]) -> Url {
        let mut url = self.base.clone();
        url.path_segments_mut().expect("an http(s) URL has a path").pop_if_empty().extend(segments);
        url
    }

    fn request(&self, method: Method, segments: &[&str]) -> RequestBuilder {
        self.http.request(method, self.url(segments))
    }

    /// Sends a request with the session; an error status becomes the matching [`Error`]. A
    /// request whose session expired is sent again, once, with a new one.
    async fn send(&self, request: RequestBuilder) -> Result<Response> {
        let session = self.session_id().await?;
        let Some(id) = session else {
            return self.send_plain(request).await;
        };
        let retry = request.try_clone();
        match self.send_plain(request.header(SESSION_HEADER, id.to_string())).await {
            Err(Error::SessionExpired(e)) => match retry {
                Some(retry) => {
                    let renewed = self.renew_session(session).await?.expect("a client with a session");
                    self.send_plain(retry.header(SESSION_HEADER, renewed.to_string())).await
                }
                None => Err(Error::SessionExpired(e)),
            },
            result => result,
        }
    }

    /// Sends a request as it is; an error status becomes the matching [`Error`].
    async fn send_plain(&self, request: RequestBuilder) -> Result<Response> {
        let response = request.send().await?;
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let url = response.url().to_string();
        let body = response.text().await.unwrap_or_default();
        Err(Error::from_response(status.as_u16(), body, url))
    }

    async fn json<T: DeserializeOwned>(&self, request: RequestBuilder) -> Result<T> {
        let bytes = self.send(request).await?.bytes().await?;
        Ok(serde_json::from_slice(&bytes)?)
    }

    async fn text(&self, request: RequestBuilder) -> Result<String> {
        Ok(self.send(request).await?.text().await?)
    }

    async fn bytes(&self, request: RequestBuilder) -> Result<Vec<u8>> {
        Ok(self.send(request).await?.bytes().await?.to_vec())
    }
}

/// `http(s)` → `ws(s)`.
fn to_websocket(url: &mut Url) -> Result<()> {
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme).map_err(|_| Error::Protocol(format!("cannot open a WebSocket to {url}")))
}

/// The URL with `?session=` when there is a session: browsers' and most WebSocket clients can't set
/// headers, so the server takes it as a parameter.
fn with_session(url: &Url, session: Option<Uuid>) -> Url {
    let mut url = url.clone();
    if let Some(session) = session {
        url.query_pairs_mut().append_pair("session", &session.to_string());
    }
    url
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_base_url_is_normalized() {
        for (given, expected) in [
            ("http://host:8742", "http://host:8742/api/v1/"),
            ("http://host:8742/", "http://host:8742/api/v1/"),
            ("http://host:8742/api/v1", "http://host:8742/api/v1/"),
            ("https://proxy/racs/api/v1/", "https://proxy/racs/api/v1/"),
        ] {
            assert_eq!(normalize_base_url(given).unwrap().as_str(), expected, "{given}");
        }
    }

    #[test]
    fn route_segments_are_percent_encoded() {
        let client = RacsClient::new("http://host:8742").unwrap();
        assert_eq!(
            client.url(&["devices", "0", "gc", "feature", "a/b c"]).as_str(),
            "http://host:8742/api/v1/devices/0/gc/feature/a%2Fb%20c"
        );
    }

    #[test]
    fn error_responses_map_to_specific_errors() {
        let error = |status, body: &str| Error::from_response(status, body.into(), "u".into());
        assert!(matches!(error(500, "Error: StoreError(Busy(0))"), Error::CameraBusy(_)));
        assert!(matches!(error(404, "no job"), Error::NotFound(_)));
        assert!(matches!(error(410, "timeout"), Error::ImageFailed(_)));
        assert!(matches!(error(500, "Error: NotDiscovered(9)"), Error::Api(_)));
        assert_eq!(error(500, "x").status(), Some(500));
        assert!(error(500, "Error: StoreError(Busy(0))").refusal().is_none());
    }

    #[test]
    fn refusals_map_to_their_errors_with_the_parsed_body() {
        use crate::models::{HolderKind, Mode};
        let error = |status, body: &str| Error::from_response(status, body.into(), "u".into());

        let expired = error(401, r#"{"error":"session_expired"}"#);
        assert!(matches!(expired, Error::SessionExpired(_)));
        assert_eq!(expired.refusal().unwrap().error, "session_expired");

        let read_only =
            error(403, r#"{"error":"read_only","mode":"ro-shared","owner":{"client_id":"3f2a9c1e","name":"line-script"}}"#);
        assert!(matches!(read_only, Error::ReadOnly(_)));
        let refusal = read_only.refusal().unwrap();
        assert_eq!((refusal.mode, refusal.owner.unwrap().client_id.as_str()), (Some(Mode::RoShared), "3f2a9c1e"));

        let in_use = error(
            409,
            r#"{"error":"device_in_use","mode":"shared","owner":null,
                "members":[{"client_id":"77d0aa12","name":null}],"holder":{"kind":"live","client_id":null}}"#,
        );
        assert!(matches!(in_use, Error::DeviceInUse(_)));
        let refusal = in_use.refusal().unwrap();
        assert_eq!(refusal.members[0].client_id, "77d0aa12");
        assert_eq!(refusal.holder.unwrap().kind, HolderKind::Live);

        let locked = error(423, r#"{"error":"device_locked","mode":"exclusive","owner":{"client_id":"a","name":null}}"#);
        assert!(matches!(locked, Error::DeviceLocked(_)));
        assert_eq!(locked.status(), Some(423));
        assert_eq!(locked.refusal().unwrap().mode, Some(Mode::Exclusive));

        // A body that isn't a refusal still maps by status, without a parsed body.
        let plain = error(423, "locked");
        assert!(matches!(plain, Error::DeviceLocked(_)));
        assert!(plain.refusal().is_none());
        assert_eq!(error(400, r#"{"error":"session_required"}"#).refusal().unwrap().error, "session_required");
    }

    #[test]
    fn close_codes_map_to_their_errors() {
        assert!(Error::from_close(1000, "").is_none());
        assert!(Error::from_close(1001, "device disconnected").is_none());
        assert!(matches!(Error::from_close(4001, "session expired"), Some(Error::SessionEnded { reason }) if reason == "session expired"));
        assert!(matches!(Error::from_close(4003, "access revoked"), Some(Error::AccessRevoked { reason }) if reason == "access revoked"));
        assert!(matches!(
            Error::from_close(1011, ""),
            Some(Error::LiveStream { reason, code: Some(1011) }) if reason == "stream closed with code 1011"
        ));
    }

    #[test]
    fn websocket_urls_carry_the_session() {
        let mut url = Url::parse("http://host:8742/api/v1/events").unwrap();
        to_websocket(&mut url).unwrap();
        let id = Uuid::nil();
        assert_eq!(
            with_session(&url, Some(id)).as_str(),
            "ws://host:8742/api/v1/events?session=00000000-0000-0000-0000-000000000000"
        );
        assert_eq!(with_session(&url, None).as_str(), "ws://host:8742/api/v1/events");
    }
}

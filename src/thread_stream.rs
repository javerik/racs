use std::error::Error;
use std::fmt::{Display, Formatter};
use std::time::{Duration, Instant};

use aravis_port::memory::BufferStatus;
use aravis_port::Camera;
use tracing::{debug, warn};

/// How long a single-frame grab waits for a good frame before giving up.
pub const DEFAULT_GRAB_TIMEOUT: Duration = Duration::from_secs(5);

/// How long each individual pop waits. Short relative to the overall deadline so partial frames
/// can be recycled promptly — the pool only holds four buffers, and the reassembler drops whole
/// frames when it runs dry. The live stream reuses it as its cancellation granularity.
pub const POP_INTERVAL: Duration = Duration::from_millis(250);

pub enum ThreadStreamError {
    LibError(aravis_port::Error),
    StreamError(String)
}

impl std::fmt::Debug for ThreadStreamError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            ThreadStreamError::LibError(e) => write!(f, "ThreadStreamError::LibError({})", e),
            ThreadStreamError::StreamError(e) => write!(f, "ThreadStreamError::StreamError({:?})", e)
        }
    }
}

impl Display for ThreadStreamError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            ThreadStreamError::LibError(e) => write!(f, "Library error: {}", e),
            ThreadStreamError::StreamError(e) => write!(f, "Stream error: {}", e)
        }
    }
}

impl Error for ThreadStreamError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            ThreadStreamError::LibError(e) => Some(e),
            ThreadStreamError::StreamError(_) => None
        }
    }
}

impl From<aravis_port::Error> for ThreadStreamError {
    fn from(value: aravis_port::Error) -> Self {
        ThreadStreamError::LibError(value)
    }
}

/// A one-shot frame grab: start a stream, take the first good frame, stop the stream.
///
/// Every call here blocks, so it must run on a blocking thread (see
/// [`crate::stores::camera_store::CameraStore::with_camera`]).
pub struct ThreadStream<'a> {
    camera: &'a Camera
}

impl<'a> ThreadStream<'a> {

    pub fn new(camera: &'a Camera) -> ThreadStream<'a> {
        ThreadStream{camera}
    }

    /// Grab one frame, returning its `(width, height)` and pixel bytes.
    ///
    /// The first frame off a freshly started stream is normally incomplete, because acquisition is
    /// joined mid-frame — those are recycled and the grab keeps waiting rather than failing.
    pub fn grab_frame(&self, timeout: Duration) -> Result<((u32, u32), Vec<u8>), ThreadStreamError> {
        let (stream, pool) = self
            .camera
            .start_stream_channel_with_config(crate::controller::transport::stream_config(self.camera))?;
        let deadline = Instant::now() + timeout;

        let mut outcome = None;
        let mut rejected = 0usize;
        while Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(Instant::now()).min(POP_INTERVAL);
            let Some(buffer) = pool.timeout_pop_buffer(remaining) else { continue };

            if buffer.status == BufferStatus::Success {
                let dims = buffer
                    .image
                    .as_ref()
                    .map(|i| (i.width, i.height))
                    .unwrap_or((0, 0));
                let data = buffer.data().to_vec();
                // Recycle before stopping: the pool is the reassembler's only source of buffers.
                pool.push_buffer(buffer);
                outcome = Some((dims, data));
                break;
            }

            rejected += 1;
            debug!("discarding frame with status {:?}", buffer.status);
            pool.push_buffer(buffer);
        }

        // Stop the stream regardless of outcome so the camera isn't left acquiring.
        if let Err(e) = self.camera.stop_stream(stream) {
            warn!("failed to stop stream cleanly => {e}");
        }

        let ((mut width, mut height), data) = outcome.ok_or_else(|| self.timeout_error(rejected))?;

        // Some cameras omit image dimensions from the GVSP leader; fall back to the features.
        if width == 0 || height == 0 {
            width = self.camera.read::<i64>("Width").unwrap_or(0).max(0) as u32;
            height = self.camera.read::<i64>("Height").unwrap_or(0).max(0) as u32;
        }

        Ok(((width, height), data))
    }

    /// Grab one frame and return only its pixel bytes.
    pub fn grab_frame_data(&self, timeout: Duration) -> Result<Vec<u8>, ThreadStreamError> {
        Ok(self.grab_frame(timeout)?.1)
    }

    /// aravis-port starts acquisition on a best-effort basis and swallows the result, so a bare
    /// timeout gives no clue why. Probe the two things that actually explain it.
    fn timeout_error(&self, rejected: usize) -> ThreadStreamError {
        let has_control = self.camera.has_control();
        let acquisition_start = match self.camera.execute_command("AcquisitionStart") {
            Ok(()) => "ok".to_string(),
            Err(e) => format!("{e}"),
        };
        ThreadStreamError::StreamError(format!(
            "no complete frame received before timeout ({rejected} incomplete frame(s) discarded, \
             has_control={has_control}, AcquisitionStart={acquisition_start})"
        ))
    }
}

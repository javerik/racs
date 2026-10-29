use std::collections::VecDeque;
use std::sync::OnceLock;
use std::time::Duration;

use futures_util::Stream;
use uuid::Uuid;

use crate::camera::Camera;
use crate::error::{Error, Result};
use crate::frame::Frame;
use crate::models::{BurstJobInfo, ImageEntry, ImageFormat, JobStatus};

const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// The frame geometry of a job, the same for every frame.
#[derive(Debug, Clone)]
struct Geometry {
    format: ImageFormat,
    width: u32,
    height: u32,
    pixel_format: String,
    bit_depth: u8,
}

/// A burst job on the server.
///
/// The frames stay on the server until the job is [deleted](Self::delete), or expire 10 min after
/// it finishes. There is no async drop in Rust, so delete jobs you are done with.
#[derive(Debug)]
pub struct BurstJob {
    camera: Camera,
    id: Uuid,
    geometry: OnceLock<Geometry>,
}

impl BurstJob {
    pub(crate) fn new(camera: Camera, id: Uuid) -> Self {
        Self { camera, id, geometry: OnceLock::new() }
    }

    pub fn id(&self) -> Uuid {
        self.id
    }

    pub fn camera(&self) -> &Camera {
        &self.camera
    }

    /// The job's status and progress.
    pub async fn info(&self) -> Result<BurstJobInfo> {
        let info = self.camera.client().get_grab_job(self.camera.id(), self.id).await?;
        if let (Some(width), Some(height)) = (info.width, info.height) {
            let _ = self.geometry.set(Geometry {
                format: info.format,
                width,
                height,
                pixel_format: info.pixel_format.clone().unwrap_or_else(|| "Mono8".into()),
                bit_depth: info.bit_depth.unwrap_or(8),
            });
        }
        Ok(info)
    }

    /// Every frame attempted so far, in capture order.
    pub async fn images(&self) -> Result<Vec<ImageEntry>> {
        self.camera.client().list_grab_job_images(self.camera.id(), self.id).await
    }

    /// The encoded bytes of frame `index`.
    pub async fn image(&self, index: u32) -> Result<Vec<u8>> {
        self.camera.client().get_grab_job_image(self.camera.id(), self.id, index).await
    }

    /// Frame `index` with its geometry.
    pub async fn frame(&self, index: u32) -> Result<Frame> {
        let data = self.image(index).await?;
        if self.geometry.get().is_none() {
            // Fills in the geometry, which the job records with its first frame.
            self.info().await?;
        }
        let geometry = self
            .geometry
            .get()
            .ok_or_else(|| Error::Protocol(format!("burst job {} reports no frame geometry", self.id)))?;
        Ok(Frame {
            data,
            width: geometry.width,
            height: geometry.height,
            format: geometry.format,
            pixel_format: geometry.pixel_format.clone(),
            bit_depth: geometry.bit_depth,
            frame_number: None,
            dropped: None,
        })
    }

    /// Waits until the job is completed or cancelled and returns its final status;
    /// [`Error::BurstJobFailed`] if it failed. Wrap it in `tokio::time::timeout` to bound the wait.
    pub async fn wait(&self) -> Result<BurstJobInfo> {
        loop {
            let info = self.info().await?;
            if info.status.is_terminal() {
                return finished(info);
            }
            tokio::time::sleep(POLL_INTERVAL).await;
        }
    }

    /// Every captured frame in order, as soon as it is on the server; failed frames (only with
    /// `OnFailure::Skip`) are left out. Ends when the job is done, with
    /// [`Error::BurstJobFailed`] after the last frame if the job failed.
    pub fn frames(&self) -> impl Stream<Item = Result<Frame>> + '_ {
        struct State {
            next_index: u32,
            queue: VecDeque<u32>,
            // The final status once the job is terminal; the listing after it is complete.
            done: Option<BurstJobInfo>,
            ended: bool,
        }
        let state = State { next_index: 0, queue: VecDeque::new(), done: None, ended: false };
        futures_util::stream::unfold(state, move |mut state| async move {
            loop {
                if state.ended {
                    return None;
                }
                if let Some(index) = state.queue.pop_front() {
                    return Some((self.frame(index).await, state));
                }
                if let Some(info) = state.done.take() {
                    state.ended = true;
                    return match finished(info) {
                        Ok(_) => None,
                        Err(e) => Some((Err(e), state)),
                    };
                }
                // Status first: once it is terminal, the listing that follows is complete.
                let polled = async {
                    let info = self.info().await?;
                    let images = self.images().await?;
                    Ok::<_, Error>((info, images))
                };
                let (info, images) = match polled.await {
                    Ok(polled) => polled,
                    Err(e) => {
                        state.ended = true;
                        return Some((Err(e), state));
                    }
                };
                for entry in images {
                    if entry.index() < state.next_index {
                        continue;
                    }
                    state.next_index = entry.index() + 1;
                    if let ImageEntry::Ok { index, .. } = entry {
                        state.queue.push_back(index);
                    }
                }
                if info.status.is_terminal() {
                    state.done = Some(info);
                } else if state.queue.is_empty() {
                    tokio::time::sleep(POLL_INTERVAL).await;
                }
            }
        })
    }

    /// Cancels the job if it still runs, and drops it and its frames from the server.
    pub async fn delete(self) -> Result<()> {
        self.camera.client().delete_grab_job(self.camera.id(), self.id).await
    }
}

fn finished(info: BurstJobInfo) -> Result<BurstJobInfo> {
    if info.status == JobStatus::Failed {
        Err(Error::BurstJobFailed(Box::new(info)))
    } else {
        Ok(info)
    }
}

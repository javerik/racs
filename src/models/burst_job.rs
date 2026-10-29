//! Wire types for the burst image-grab jobs at `/devices/{id}/grab/jobs`.
//!
//! A burst job grabs `count` frames in the background, decoupled from the request that started it:
//! the `POST` returns a job id immediately and the client polls for progress and images. The
//! capture itself holds the camera exclusively for its whole run, exactly like a live stream does.

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::controller::frame_codec::FrameEncoding;
use crate::models::pixel::PixelDepth;

/// Upper bound on `count`, so one request cannot commit the process to unbounded memory.
///
/// A full job is held in RAM as encoded frames; at 500 frames a 1280x1024 Mono8 raw burst is
/// ~650MB, which is the point where this stops being reasonable; a 16-bit raw burst doubles that.
/// zstd bursts are about half of raw and JPEG ones an order of magnitude smaller, so this is a
/// ceiling for the worst case rather than a typical figure.
pub const MAX_BURST_COUNT: u32 = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum BurstFormat {
    Raw,
    Jpeg,
    /// Lossless: prediction residuals in one zstd frame, as on the live stream.
    Zstd,
}

/// What to do when a frame in the middle of a burst cannot be captured.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum OnFailure {
    /// Stop the burst and fail the job. The default: a partial burst is usually a broken one.
    #[default]
    Abort,
    /// Record the failure at that index and keep going, up to `max_failures`.
    Skip,
}

/// `POST /devices/{id}/grab/jobs` body.
#[derive(Debug, Clone, Deserialize, ToSchema)]
pub struct StartBurstJobRequest {
    /// How many frames to grab, `1..=500`.
    pub count: u32,
    /// `raw` (width*height pixels, 1 or 2 bytes each depending on `bit_depth`), `jpeg`, or `zstd`
    /// (the same pixels losslessly compressed, decoded as described for the live stream).
    pub format: BurstFormat,
    /// `mono8` (default) or `mono16`. See `BurstJobInfo.bit_depth` for what the camera granted.
    pub pixel_depth: Option<PixelDepth>,
    /// JPEG quality 1-100, default 80. Ignored for `raw` and `zstd`, and clamped rather than
    /// rejected.
    pub quality: Option<u8>,
    /// `abort` (default) or `skip`.
    pub on_failure: Option<OnFailure>,
    /// With `on_failure = skip`, how many failed frames to tolerate. Omit for unlimited.
    pub max_failures: Option<u32>,
}

/// The settings a burst job runs with, after the request defaults have been applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BurstParams {
    pub count: u32,
    pub format: BurstFormat,
    pub quality: u8,
    pub on_failure: OnFailure,
    pub max_failures: Option<u32>,
    pub pixel_depth: PixelDepth,
}

impl BurstParams {
    pub fn encoding(&self) -> FrameEncoding {
        match self.format {
            BurstFormat::Raw => FrameEncoding::Raw,
            BurstFormat::Jpeg => FrameEncoding::Jpeg { quality: self.quality },
            BurstFormat::Zstd => FrameEncoding::Zstd,
        }
    }
}

impl StartBurstJobRequest {
    /// Apply the documented defaults. Quality is clamped rather than rejected, matching
    /// [`LiveStreamQuery::to_options`](crate::models::queries::LiveStreamQuery::to_options);
    /// `count` is *not* defaulted, because there is no sensible burst length to guess.
    pub fn to_params(&self) -> BurstParams {
        BurstParams {
            count: self.count,
            format: self.format,
            quality: self.quality.unwrap_or(80).clamp(1, 100),
            on_failure: self.on_failure.unwrap_or_default(),
            // Meaningless with `abort`, but ignored rather than rejected — the same forgiving
            // handling every other option in this API gets.
            max_failures: self.max_failures,
            pixel_depth: self.pixel_depth.unwrap_or_default(),
        }
    }

    /// `Err` with a client-facing reason when the request cannot produce a job at all.
    pub fn validate(&self) -> Result<(), String> {
        if self.count == 0 {
            return Err("count must be at least 1".to_string());
        }
        if self.count > MAX_BURST_COUNT {
            return Err(format!("count must not exceed {MAX_BURST_COUNT}, got {}", self.count));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum JobStatus {
    /// Created, but the background task has not taken the camera yet.
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl JobStatus {
    /// Whether the job has stopped for good, and so has an `expires_at`.
    pub fn is_terminal(&self) -> bool {
        matches!(self, JobStatus::Completed | JobStatus::Failed | JobStatus::Cancelled)
    }
}

/// What `POST /devices/{id}/grab/jobs` returns, alongside `202 Accepted`.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BurstJobCreated {
    pub job_id: Uuid,
    pub device_id: u32,
    pub status: JobStatus,
}

/// What `GET /devices/{id}/grab/jobs/{job_id}` returns.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct BurstJobInfo {
    pub job_id: Uuid,
    pub device_id: u32,
    pub status: JobStatus,
    pub format: BurstFormat,
    pub requested_count: u32,
    /// Frames captured successfully so far.
    pub captured_count: u32,
    /// Frames attempted and failed so far; non-zero only with `on_failure = skip`.
    pub failed_count: u32,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub started_at: Option<chrono::DateTime<chrono::Utc>>,
    pub completed_at: Option<chrono::DateTime<chrono::Utc>>,
    /// When the finished job will be dropped from the server. `null` until it finishes.
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
    /// Why the job failed. `null` unless `status` is `failed`.
    pub error: Option<String>,
    /// Frame width. `null` until the first frame is captured; every frame of a job shares it.
    pub width: Option<u32>,
    /// Frame height. `null` until the first frame is captured.
    pub height: Option<u32>,
    /// The `PixelFormat` the camera actually streamed in. `null` until the first frame.
    pub pixel_format: Option<String>,
    /// Significant bits per pixel. Above 8, raw images are little-endian `u16`s. `null` until the
    /// first frame.
    pub bit_depth: Option<u8>,
}

/// One entry of `GET /devices/{id}/grab/jobs/{job_id}/images`.
#[derive(Debug, Clone, Serialize, ToSchema)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ImageEntryInfo {
    Ok { index: u32, size_bytes: u32 },
    Failed { index: u32, error: String },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn count_is_bounded_at_both_ends() {
        let req = |count| StartBurstJobRequest {
            count,
            format: BurstFormat::Raw,
            quality: None,
            on_failure: None,
            max_failures: None,
            pixel_depth: None,
        };
        // A zero-frame burst is a job that can never do anything, and an unbounded one is a way
        // to exhaust the server's memory from a single request.
        assert!(req(0).validate().is_err());
        assert!(req(MAX_BURST_COUNT + 1).validate().is_err());
        assert!(req(1).validate().is_ok());
        assert!(req(MAX_BURST_COUNT).validate().is_ok());
    }

    #[test]
    fn defaults_match_the_single_frame_endpoints() {
        let params = StartBurstJobRequest {
            count: 5,
            format: BurstFormat::Jpeg,
            quality: None,
            on_failure: None,
            max_failures: None,
            pixel_depth: None,
        }
        .to_params();
        assert_eq!(params.quality, 80);
        assert_eq!(params.on_failure, OnFailure::Abort, "a partial burst must not pass silently");
        assert_eq!(params.max_failures, None);
        assert_eq!(params.pixel_depth, PixelDepth::Mono8, "8-bit unless asked otherwise");
    }

    #[test]
    fn an_out_of_range_quality_is_clamped_not_rejected() {
        let req = |quality| StartBurstJobRequest {
            count: 1,
            format: BurstFormat::Jpeg,
            quality: Some(quality),
            on_failure: None,
            max_failures: None,
            pixel_depth: None,
        };
        // Losing a whole burst over a quality typo would be a poor trade; the JPEG endpoints
        // already clamp rather than 400.
        assert_eq!(req(0).to_params().quality, 1);
        assert_eq!(req(200).to_params().quality, 100);
    }

    #[test]
    fn the_request_uses_lowercase_enum_values() {
        let req: StartBurstJobRequest =
            serde_json::from_str(r#"{"count":3,"format":"jpeg","on_failure":"skip"}"#).unwrap();
        assert_eq!(req.format, BurstFormat::Jpeg);
        assert_eq!(req.to_params().on_failure, OnFailure::Skip);
    }

    #[test]
    fn an_image_entry_is_tagged_by_its_status() {
        let ok = serde_json::to_value(ImageEntryInfo::Ok { index: 0, size_bytes: 12 }).unwrap();
        assert_eq!(ok["status"], "ok");
        assert_eq!(ok["size_bytes"], 12);

        let failed =
            serde_json::to_value(ImageEntryInfo::Failed { index: 1, error: "boom".into() }).unwrap();
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["error"], "boom");
        // A failed entry carries no size — clients switch on `status`, not on field presence.
        assert!(failed.get("size_bytes").is_none());
    }
}

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::models::access::Mode;
use crate::models::live_stream::{LiveFormat, LiveOptions};
use crate::models::pixel::PixelDepth;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct JpegEncodingQuery {
    pub quality: Option<u8>
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct LiveStreamQuery {
    pub format: Option<LiveFormat>,
    pub quality: Option<u8>,
    pub fps: Option<f32>,
    pub pixel_depth: Option<PixelDepth>
}

impl LiveStreamQuery {
    /// Apply the documented defaults: 8-bit JPEG at quality 80, no frame-rate cap.
    ///
    /// An out-of-range quality is clamped rather than rejected — the same forgiving handling the
    /// one-shot JPEG endpoint gives it, and a 400 here would mean losing the whole stream.
    pub fn to_options(&self) -> LiveOptions {
        let defaults = LiveOptions::default();
        LiveOptions {
            format: self.format.unwrap_or(defaults.format),
            quality: self.quality.unwrap_or(defaults.quality).clamp(1, 100),
            fps: self.fps.filter(|f| f.is_finite() && *f > 0.0),
            pixel_depth: self.pixel_depth.unwrap_or(defaults.pixel_depth),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct StringValueQuery {
    pub value: String
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DeviceConnectionQuery {
    pub ip: Option<String>,
    /// Take the device's lease in this mode as part of the connect.
    pub mode: Option<Mode>,
}

/// `?force=true` of `PUT /devices/{id}/disconnect` and `DELETE /devices/{id}/access`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct ForceQuery {
    /// Act for everyone, whoever else uses the device or owns its lease.
    #[serde(default)]
    pub force: bool,
}

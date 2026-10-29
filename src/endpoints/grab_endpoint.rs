//! Burst grab jobs at `/devices/{id}/grab/jobs`.
//!
//! Every route here is fast: starting a job registers a record and spawns the capture, and the
//! rest read from that record. Nothing waits on the camera, which is the whole point of the
//! feature — see [`GrabCtrl`](crate::controller::grab_ctrl::GrabCtrl) for the capture itself.

use actix_web::http::header::ContentType;
use actix_web::{web, HttpResponse, Result};
use uuid::Uuid;

use crate::app_context::AppContext;
use crate::endpoints::device_endpoint::{admit, LOCKED, READ_ONLY};
use crate::models::access::{AccessError, Perm};
use crate::endpoints::errors;
use crate::stores::client_store::Client;
use crate::models::burst_job::{
    BurstJobCreated, BurstJobInfo, ImageEntryInfo, JobStatus, StartBurstJobRequest,
};
use crate::stores::job_store::ImageLookup;

#[utoipa::path(
    post,
    path = "/devices/{id}/grab/jobs",
    tag = "grab",
    description = "\
Starts a background job that grabs `count` frames from the device and keeps them in memory. The \
response is returned before the capture starts, so this never blocks for the duration of the burst; \
poll `GET /devices/{id}/grab/jobs/{job_id}` for progress and fetch the frames from the `images` \
routes.

The camera is held exclusively for the whole run, exactly like a live stream — every other request \
for that device fails while the job is capturing. A device that is *already* busy is not detected \
here, because the camera is only taken once the background task starts: such a job is created \
normally and then transitions straight to `failed`, so check the status rather than assuming a \
`202` means the capture began.

`format` is `raw`, `jpeg` or `zstd`. `pixel_depth` is `mono8` (default) or `mono16`; the latter asks the \
camera for the deepest unpacked mono format it supports (Mono16, 14, 12, then 10; Coord3D_C16 on a 3D \
camera in Linescan3D). Raw images are \
width*height bytes in 8-bit and width*height little-endian u16s above that; the job status reports \
`width`, `height`, `pixel_format` and `bit_depth` once the first frame is in. JPEG images always \
hold the top 8 significant bits. `zstd` images are the raw ones losslessly compressed, decoded as \
described for the live stream (`GET /devices/{id}/stream/live`); frames are compressed while the \
capture goes on, and the job completes once every one is stored. `quality` (1-100, default 80) \
applies to `jpeg` only and is clamped rather than rejected. `on_failure` is `abort` (default: the first frame \
that cannot be grabbed fails the job) or `skip` (record the failure at that index and carry on, up \
to `max_failures`).",
    params(
        ("id" = u32, Path, description = "The ID of the device to grab from")
    ),
    request_body = StartBurstJobRequest,
    responses(
        (status = 202, description = "Job accepted; the capture runs in the background", body = BurstJobCreated),
        (status = 400, description = "Invalid count", body = String),
        (status = 403, description = READ_ONLY, body = AccessError),
        (status = 423, description = LOCKED, body = AccessError),
        (status = 500, description = "The device could not be connected", body = String)
    )
)]
#[actix_web::post("/devices/{id}/grab/jobs")]
pub async fn start_grab_job(
    ctx: web::Data<AppContext>,
    client: Client,
    id: web::Path<u32>,
    body: web::Json<StartBurstJobRequest>,
) -> Result<HttpResponse> {
    let id = id.into_inner();
    if let Err(reason) = body.validate() {
        return Ok(HttpResponse::BadRequest().body(reason));
    }
    let adm = admit(&ctx, &client, id, Perm::Write)?;

    // Fail fast on an unusable device id, same as the single-frame endpoints. Whether the camera
    // is *free* is a separate question, answered later by the background task.
    if let Err(e) = ctx.dev_ctrl.connect(&adm).await {
        return Ok(errors::respond("", &e));
    }

    let job_id = ctx.grab_ctrl.create_job(&adm, body.to_params());

    // Deliberately detached: the request must not wait on the capture, and every outcome is
    // reported through the job record rather than through this response.
    let grab_ctrl = ctx.grab_ctrl.clone();
    actix_web::rt::spawn(async move { grab_ctrl.run_job(job_id, adm).await });

    Ok(HttpResponse::Accepted().json(BurstJobCreated {
        job_id,
        device_id: id,
        status: JobStatus::Pending,
    }))
}

#[utoipa::path(
    get,
    path = "/devices/{id}/grab/jobs/{job_id}",
    tag = "grab",
    description = "\
Reports a burst job's progress. `captured_count` and `failed_count` advance while the job runs; \
`expires_at` is null until the job reaches `completed`, `failed` or `cancelled`, after which the \
job and its images are dropped automatically at that time unless deleted sooner. `error` is set \
only for a failed job.",
    params(
        ("id" = u32, Path, description = "The ID of the device the job belongs to"),
        ("job_id" = Uuid, Path, description = "The job id returned when the job was started")
    ),
    responses(
        (status = 200, description = "Current job state", body = BurstJobInfo),
        (status = 423, description = LOCKED, body = AccessError),
        (status = 404, description = "No such job for this device", body = String)
    )
)]
#[actix_web::get("/devices/{id}/grab/jobs/{job_id}")]
pub async fn get_grab_job(
    ctx: web::Data<AppContext>,
    client: Client,
    path: web::Path<(u32, Uuid)>,
) -> Result<HttpResponse> {
    let (id, job_id) = path.into_inner();
    admit(&ctx, &client, id, Perm::Read)?;
    Ok(match ctx.job_store.info(id, job_id) {
        Some(info) => HttpResponse::Ok().json(info),
        None => job_not_found(job_id),
    })
}

#[utoipa::path(
    get,
    path = "/devices/{id}/grab/jobs/{job_id}/images",
    tag = "grab",
    description = "\
Lists the frames a burst job has attempted so far, in capture order — safe to poll while the job \
is still running, since the array simply grows. Each entry is either `{\"status\":\"ok\",\"index\",\
\"size_bytes\"}` or `{\"status\":\"failed\",\"index\",\"error\"}`; a failed entry only appears for a \
job started with `on_failure=skip`. Fetch the bytes of an entry from \
`/devices/{id}/grab/jobs/{job_id}/images/{index}`.",
    params(
        ("id" = u32, Path, description = "The ID of the device the job belongs to"),
        ("job_id" = Uuid, Path, description = "The job id returned when the job was started")
    ),
    responses(
        (status = 200, description = "Metadata for every index captured so far", body = Vec<ImageEntryInfo>),
        (status = 423, description = LOCKED, body = AccessError),
        (status = 404, description = "No such job for this device", body = String)
    )
)]
#[actix_web::get("/devices/{id}/grab/jobs/{job_id}/images")]
pub async fn list_grab_job_images(
    ctx: web::Data<AppContext>,
    client: Client,
    path: web::Path<(u32, Uuid)>,
) -> Result<HttpResponse> {
    let (id, job_id) = path.into_inner();
    admit(&ctx, &client, id, Perm::Read)?;
    Ok(match ctx.job_store.images(id, job_id) {
        Some(images) => HttpResponse::Ok().json(images),
        None => job_not_found(job_id),
    })
}

#[utoipa::path(
    get,
    path = "/devices/{id}/grab/jobs/{job_id}/images/{index}",
    tag = "grab",
    description = "\
Returns one captured frame, in the `format` the job was started with. The content type is \
`application/octet-stream` for `raw`, `jpeg` and `zstd` alike, matching the single-frame endpoints. \
A `zstd` frame decodes as described for the live stream (`GET /devices/{id}/stream/live`), with \
the job's `width`, `height` and `bit_depth`.

`404` covers both an index the job has not reached yet and one past the end of the burst; `410` \
means that index was attempted and failed, with the reason as the body.",
    params(
        ("id" = u32, Path, description = "The ID of the device the job belongs to"),
        ("job_id" = Uuid, Path, description = "The job id returned when the job was started"),
        ("index" = u32, Path, description = "Zero-based index into the burst")
    ),
    responses(
        (status = 200, description = "The captured frame", body = Vec<u8>, content_type = "application/octet-stream"),
        (status = 423, description = LOCKED, body = AccessError),
        (status = 404, description = "No such job, or that index has not been captured", body = String),
        (status = 410, description = "That index was attempted and failed", body = String)
    )
)]
#[actix_web::get("/devices/{id}/grab/jobs/{job_id}/images/{index}")]
pub async fn get_grab_job_image(
    ctx: web::Data<AppContext>,
    client: Client,
    path: web::Path<(u32, Uuid, u32)>,
) -> Result<HttpResponse> {
    let (id, job_id, index) = path.into_inner();
    admit(&ctx, &client, id, Perm::Read)?;
    Ok(match ctx.job_store.image(id, job_id, index) {
        // Shared with the store, not copied, and sent with its length.
        ImageLookup::Found(data) => HttpResponse::Ok().content_type(ContentType::octet_stream()).body(data),
        // Gone rather than 500: the index is a real part of this job that will never have bytes,
        // which is exactly what a client skipping past failures needs to tell apart from "not yet".
        ImageLookup::Failed(error) => HttpResponse::Gone().body(error),
        ImageLookup::Missing => {
            HttpResponse::NotFound().body(format!("no image {index} for job {job_id}"))
        }
    })
}

#[utoipa::path(
    delete,
    path = "/devices/{id}/grab/jobs/{job_id}",
    tag = "grab",
    description = "\
Cancels a running job or discards a finished one — the job and its images are gone either way. A \
job that is still capturing stops within a fraction of a second and releases the camera; its \
partial images are discarded with it, so fetch anything worth keeping first.",
    params(
        ("id" = u32, Path, description = "The ID of the device the job belongs to"),
        ("job_id" = Uuid, Path, description = "The job id returned when the job was started")
    ),
    responses(
        (status = 204, description = "The job was cancelled and/or removed"),
        (status = 403, description = READ_ONLY, body = AccessError),
        (status = 423, description = LOCKED, body = AccessError),
        (status = 404, description = "No such job for this device", body = String)
    )
)]
#[actix_web::delete("/devices/{id}/grab/jobs/{job_id}")]
pub async fn delete_grab_job(
    ctx: web::Data<AppContext>,
    client: Client,
    path: web::Path<(u32, Uuid)>,
) -> Result<HttpResponse> {
    let (id, job_id) = path.into_inner();
    let adm = admit(&ctx, &client, id, Perm::Write)?;
    Ok(match ctx.grab_ctrl.cancel(&adm, job_id) {
        true => HttpResponse::NoContent().finish(),
        false => job_not_found(job_id),
    })
}

/// An unknown, wrong-device, deleted or expired job are all the same answer to the client.
fn job_not_found(job_id: Uuid) -> HttpResponse {
    HttpResponse::NotFound().body(format!("no job {job_id}"))
}

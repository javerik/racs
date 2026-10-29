use actix_web::{
    web, HttpResponse, Result,Error
};
use actix_web::http::header::ContentType;
use actix_web::web::Bytes;
use crate::app_context::AppContext;
use crate::endpoints::device_endpoint::{admit, LOCKED, READ_ONLY};
use crate::models::access::{AccessError, Perm};
use crate::endpoints::errors;
use crate::stores::client_store::Client;
use futures::stream::{self, StreamExt};
use crate::models::queries::JpegEncodingQuery;
use crate::models::stream_errors::StreamErrorInfo;
use crate::models::transport::{AutoPacketSize, PacketSizeInfo};

#[utoipa::path(
    get,
    path = "/devices/{id}/stream/frame/raw",
    description = "Grabs a raw frame from the device.",
    params(
        ("id" = u32, Path, description = "The ID of the device to grab the frame from")
    ),
    tag = "stream",
    responses(
        (
            status = 200,
            description = "Successfully started streaming the raw frame",
            // We tell OpenAPI this is a binary stream
            body = Vec<u8>,
            content_type = "application/octet-stream"
        ),
        (status = 403, description = READ_ONLY, body = AccessError),
        (status = 423, description = LOCKED, body = AccessError),
        (
            status = 500,
            description = "Internal driver or streaming error",
            body = String
        )
    )
)]
#[actix_web::get("/devices/{id}/stream/frame/raw")]
pub async fn grab_raw_frame(ctx: web::Data<AppContext>, client: Client, id: web::Path<u32>) -> Result<HttpResponse> {
    let adm = admit(&ctx, &client, id.into_inner(), Perm::Write)?;
    if let Err(e) = ctx.dev_ctrl.connect(&adm).await {
        return Ok(errors::respond("", &e));
    }
    Ok(match ctx.stream_ctrl.grab_raw_frame(&adm).await {
        Ok(frame) => {
            let stream = stream::iter(frame)
                .chunks(1024)
                .map(|chunk| {
                    Ok::<Bytes, Error>(Bytes::from(chunk))
                });
            HttpResponse::Ok().content_type(ContentType::octet_stream())
                .streaming(stream)
        },
        Err(e) => errors::respond("", &e)
    })
}


#[utoipa::path(
    get,
    path = "/devices/{id}/stream/frame/jpeg",
    description = "Grabs a frame from the device and encodes it as a jpeg. The quality can be set using the query parameter quality. The default quality is 80. By default the pixel format is set to MONO8",
    params(
        ("id" = u32, Path, description = "The ID of the device to grab the frame from")
    ),
    tag = "stream",
    responses(
        (
            status = 200,
            description = "Successfully started streaming the jpeg frame",
            // We tell OpenAPI this is a binary stream
            body = Vec<u8>,
            content_type = "application/octet-stream"
        ),
        (status = 403, description = READ_ONLY, body = AccessError),
        (status = 423, description = LOCKED, body = AccessError),
        (
            status = 500,
            description = "Internal driver or streaming error",
            body = String
        )
    )
)]
#[actix_web::get("/devices/{id}/stream/frame/jpeg")]
pub async fn grab_jpg_frame(ctx: web::Data<AppContext>, client: Client, id: web::Path<u32>, query_data: web::Query<JpegEncodingQuery>) -> Result<HttpResponse> {
    let adm = admit(&ctx, &client, id.into_inner(), Perm::Write)?;
    if let Err(e) = ctx.dev_ctrl.connect(&adm).await {
        return Ok(errors::respond("", &e));
    }

    let quality = query_data.0.quality.unwrap_or(80);

    Ok(match ctx.stream_ctrl.grab_jpeg_frame(&adm, quality).await {
        Ok(frame) => {
            let stream = stream::iter(frame)
                .chunks(1024)
                .map(|chunk| {
                    Ok::<Bytes, Error>(Bytes::from(chunk))
                });
            HttpResponse::Ok().content_type(ContentType::octet_stream())
                .streaming(stream)
        },
        Err(e) => errors::respond("", &e)
    })
}


#[utoipa::path(
    get,
    path = "/devices/{id}/stream/error",
    description = "\
Returns why the last live stream on this device ended, whether one is running right now, and how \
many sockets watch it (`viewers`). A closed WebSocket carries its reason away with it, so this is \
how a client finds out after the fact. `last_error` and `timestamp` are null for a device whose \
streams have never failed.",
    params(
        ("id" = u32, Path, description = "The ID of the device to report on")
    ),
    tag = "stream",
    responses(
        (
            status = 200,
            description = "Last live-stream error and current stream state",
            body = StreamErrorInfo
        )
    )
)]
#[actix_web::get("/devices/{id}/stream/error")]
pub async fn get_stream_error(ctx: web::Data<AppContext>, client: Client, id: web::Path<u32>) -> Result<HttpResponse> {
    let adm = admit(&ctx, &client, id.into_inner(), Perm::Meta)?;
    // Always 200: "this device has never failed" is an answer, not an error, and an unknown id is
    // indistinguishable from one that simply has not streamed yet.
    Ok(HttpResponse::Ok().json(ctx.stream_errors.info(adm.device()).await))
}

#[utoipa::path(
    get,
    path = "/devices/{id}/stream/packet-size",
    description = "\
Returns the stream packet size (GevSCPSPacketSize: bytes per GVSP packet, IP and UDP headers \
included), the values it may take, and the MTU of the local interface the camera is reached over. \
Every grab, live stream and burst uses the camera's packet size as it is; change it with \
`PUT /devices/{id}/gc/feature/GevSCPSPacketSize?value=` or let \
`POST /devices/{id}/stream/packet-size/auto` find the largest that works. Packets larger than the \
link MTU never arrive, so jumbo frames (e.g. 7960) need an interface MTU of 9000. Answered during \
a live stream too; busy during a burst.",
    params(
        ("id" = u32, Path, description = "The ID of the device")
    ),
    tag = "stream",
    responses(
        (status = 200, description = "Packet size, its bounds and the link", body = PacketSizeInfo),
        (status = 423, description = LOCKED, body = AccessError),
        (status = 500, description = "The device could not be reached", body = String)
    )
)]
#[actix_web::get("/devices/{id}/stream/packet-size")]
pub async fn get_packet_size(ctx: web::Data<AppContext>, client: Client, id: web::Path<u32>) -> Result<HttpResponse> {
    let adm = admit(&ctx, &client, id.into_inner(), Perm::Read)?;
    Ok(match ctx.dev_ctrl.packet_size(&adm).await {
        Ok(info) => HttpResponse::Ok().json(info),
        Err(e) => errors::respond("Error: ", &e),
    })
}

#[utoipa::path(
    post,
    path = "/devices/{id}/stream/packet-size/auto",
    description = "\
Finds the largest stream packet size that reaches this host and sets it, the way Aravis does: the \
camera fires GigE Vision test packets with \"don't fragment\" set, and a binary search between the \
packet size bounds (capped at the link MTU) keeps the largest that arrives. Takes up to about a \
second. During a live stream, acquisition pauses for it and the stream carries on with the new \
size. A camera that answers no test packet keeps its packet size (`test_packets: false`). Busy \
during a burst. On connect the server already checks the camera's packet size this way and only \
replaces it when it doesn't get through.",
    params(
        ("id" = u32, Path, description = "The ID of the device")
    ),
    tag = "stream",
    responses(
        (status = 200, description = "The packet size now set", body = AutoPacketSize),
        (status = 403, description = READ_ONLY, body = AccessError),
        (status = 423, description = LOCKED, body = AccessError),
        (status = 500, description = "The device could not be reached or is busy", body = String)
    )
)]
#[actix_web::post("/devices/{id}/stream/packet-size/auto")]
pub async fn auto_packet_size(ctx: web::Data<AppContext>, client: Client, id: web::Path<u32>) -> Result<HttpResponse> {
    let adm = admit(&ctx, &client, id.into_inner(), Perm::Write)?;
    Ok(match ctx.dev_ctrl.auto_packet_size(&adm).await {
        Ok(outcome) => HttpResponse::Ok().json(outcome),
        Err(e) => errors::respond("Error: ", &e),
    })
}

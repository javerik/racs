use crate::endpoints::device_endpoint::{
    __path_get_devices, __path_get_connected_devices, __path_connect_device, __path_disconnect_device,
    __path_get_device_access, __path_set_device_access, __path_release_device_access,
    __path_get_device_xml, __path_get_device_gc_categories,
    __path_get_device_gc_node_value, __path_set_device_gc_node_value,
    __path_get_device_gc_feature_states, __path_execute_device_gc_command
};
use crate::endpoints::grab_endpoint::{
    __path_start_grab_job, __path_get_grab_job, __path_list_grab_job_images,
    __path_get_grab_job_image, __path_delete_grab_job
};
use crate::endpoints::stream_endpoint::{
    __path_grab_raw_frame, __path_grab_jpg_frame, __path_get_stream_error,
    __path_get_packet_size, __path_auto_packet_size
};
use crate::endpoints::websocket_endpoint::__path_stream_live;
use crate::endpoints::session_endpoint::{
    __path_create_session, __path_heartbeat, __path_rename_session, __path_end_session, __path_list_sessions
};
use crate::endpoints::events_endpoint::__path_events;
use crate::endpoints::session_mw::SESSION_HEADER;
use crate::events::{
    AccessState, BurstState, DeviceState, Event, EventKind, HelloSession, StateCause, StreamState
};
use crate::models::device_models::CloseReason;
use crate::models::session::{
    ApiError, ClientRef, CreateSessionRequest, DisconnectResult, EndReason, RenameSessionRequest, SessionCreated,
    SessionInfo
};
use utoipa::openapi::security::{ApiKey, ApiKeyValue, SecurityRequirement, SecurityScheme};
use utoipa::openapi::{ContentBuilder, Ref, RefOr, ResponseBuilder};
use utoipa::{Modify, OpenApi};
use crate::models::burst_job::{
    BurstFormat, BurstJobCreated, BurstJobInfo, ImageEntryInfo, JobStatus, OnFailure,
    StartBurstJobRequest
};
use crate::models::access::{AccessError, DeviceAccess, HolderKind, HolderRef, Mode, Role, SetAccessRequest};
use crate::models::device_models::{ConnectedDevice, DeviceDiscoverInfo, DeviceConnections};
use crate::models::genicam_models::{FeatureState, FeatureStateRequest, GenICamNodeCategory, GenICamNodeInfo, GenICamEnumInfo};
use crate::models::live_stream::StreamInfo;
use crate::models::pixel::PixelDepth;
use crate::models::stream_errors::StreamErrorInfo;
use crate::models::transport::{AutoPacketSize, PacketSizeInfo};

/// OpenAPI documentation
#[derive(OpenApi)]
#[openapi(
    paths(
        create_session,
        heartbeat,
        rename_session,
        end_session,
        list_sessions,
        events,
        get_devices,
        get_connected_devices,
        connect_device,
        disconnect_device,
        get_device_access,
        set_device_access,
        release_device_access,
        get_device_xml,
        grab_raw_frame,
        grab_jpg_frame,
        stream_live,
        get_stream_error,
        get_packet_size,
        auto_packet_size,
        get_device_gc_categories,
        get_device_gc_node_value,
        set_device_gc_node_value,
        get_device_gc_feature_states,
        execute_device_gc_command,
        start_grab_job,
        get_grab_job,
        list_grab_job_images,
        get_grab_job_image,
        delete_grab_job
    ),
    components(
        schemas(
            DeviceConnections,
            DeviceDiscoverInfo,
            ConnectedDevice,
            DeviceAccess,
            SetAccessRequest,
            AccessError,
            Role,
            HolderKind,
            HolderRef,
            GenICamNodeCategory,
            GenICamNodeInfo,
            GenICamEnumInfo,
            FeatureStateRequest,
            FeatureState,
            StreamErrorInfo,
            StreamInfo,
            PacketSizeInfo,
            AutoPacketSize,
            PixelDepth,
            StartBurstJobRequest,
            BurstFormat,
            OnFailure,
            JobStatus,
            BurstJobCreated,
            BurstJobInfo,
            ImageEntryInfo,
            CreateSessionRequest,
            RenameSessionRequest,
            SessionCreated,
            SessionInfo,
            ClientRef,
            EndReason,
            DisconnectResult,
            ApiError,
            CloseReason,
            Mode,
            Event,
            EventKind,
            HelloSession,
            DeviceState,
            AccessState,
            StreamState,
            BurstState,
            StateCause
        ),
    ),
    modifiers(&SessionSecurity),
    tags(
        (name = "sessions", description = "Client sessions, their heartbeat and the events WebSocket"),
        (name = "device", description = "Connecting devices and configure"),
        (name = "access", description = "Access modes: a device's lease, who may read and write it, and forcing it"),
        (name = "grab", description = "Background burst capture of multiple frames"),
    ),
    info(
        title = "RACS REST API",
        version = "0.5.0",
        description = "A RestAPI for configuring and controlling GEV cameras using Rust and Aravis.",
        contact(
            name = "API Support",
            email = "racs-support@javerik.space"
        ),
        license(
            name = "GPL-2.0-only",
            url = "https://www.gnu.org/licenses/old-licenses/gpl-2.0.en.html"
        )
    ),
    servers((url = "/api/v1", description = "API version 1")),
)]
pub struct ApiDoc;

/// The session as an optional security scheme on every route, instead of a header parameter per
/// path, and the `401` an unknown or expired session gets on every route.
struct SessionSecurity;

impl Modify for SessionSecurity {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let components = openapi.components.get_or_insert_with(Default::default);
        components.add_security_scheme(
            "session",
            SecurityScheme::ApiKey(ApiKey::Header(ApiKeyValue::with_description(
                SESSION_HEADER,
                "A session id from `POST /sessions`. Optional: requests without one are anonymous. \
WebSockets send it as the query parameter `?session=` instead; a request carrying both with different \
values is refused with `400 session_conflict`.",
            ))),
        );
        // Either no session or one: an empty requirement makes the scheme optional.
        openapi.security = Some(vec![
            SecurityRequirement::default(),
            SecurityRequirement::new("session", Vec::<String>::new()),
        ]);

        let unauthorized = ResponseBuilder::new()
            .description("The session is unknown or has expired (`session_expired`): create a new one")
            .content(
                "application/json",
                ContentBuilder::new().schema(Some(Ref::from_schema_name("ApiError"))).build(),
            )
            .build();
        for item in openapi.paths.paths.values_mut() {
            let operations = [
                &mut item.get,
                &mut item.put,
                &mut item.post,
                &mut item.delete,
                &mut item.patch,
                &mut item.head,
                &mut item.options,
                &mut item.trace,
            ];
            for operation in operations.into_iter().flatten() {
                operation
                    .responses
                    .responses
                    .entry("401".to_string())
                    .or_insert_with(|| RefOr::T(unauthorized.clone()));
            }
        }
    }
}

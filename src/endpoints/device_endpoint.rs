use crate::app_context::AppContext;
use crate::endpoints::errors;
use crate::models::access::{AccessError, DeviceAccess, Mode, Perm, SetAccessRequest};
use crate::models::device_models::{ConnectedDevice, DeviceConnections};
use crate::models::genicam_models::{FeatureState, FeatureStateRequest, GenICamNodeCategory};
use crate::models::queries::{DeviceConnectionQuery, ForceQuery, StringValueQuery};
use crate::models::session::DisconnectResult;
use crate::stores::client_store::{Admission, Client};
use actix_web::http::header::ContentType;
use actix_web::{web, HttpResponse, Result};
use std::time::Instant;

/// Admit the request's client to device `id` for a route of class `perm`, or refuse it (the
/// refusal renders itself as JSON, so handlers use `?`). A session that may read becomes a member,
/// any admitted request counts as activity for the idle timeout.
pub(crate) fn admit(ctx: &AppContext, client: &Client, id: u32, perm: Perm) -> Result<Admission, AccessError> {
    ctx.clients.admit(client, id, perm, Instant::now())
}

/// The refusals documented on the routes they can come from.
pub(crate) const READ_ONLY: &str = "`read_only`: the device is `ro-shared` and this session isn't its owner";
pub(crate) const LOCKED: &str =
    "`device_locked`: the device is `exclusive` for another session (or `ro-shared` and this client anonymous)";
pub(crate) const SESSION_REQUIRED: &str = "`session_required`: the route needs a session";
pub(crate) const IN_USE: &str =
    "`device_in_use`: `exclusive` while other sessions are members or another client's stream or burst holds the device";

#[utoipa::path(
    get,
    path = "/devices",
    tag = "device",
    description = "Returns a list of devices that are connected to the network",
    responses(
        (status = 200, description = "Discovered devices in network. The id is used for connecting to devices", body = DeviceConnections)
    )
)]
#[actix_web::get("/devices")]
pub async fn get_devices(ctx: web::Data<AppContext>) -> Result<HttpResponse> {
    match ctx.dev_ctrl.discover().await {
        Ok(v) => Ok(HttpResponse::Ok().json(v)),
        Err(e) => Ok(errors::respond("Discover error: ", &e)),
    }
}

#[utoipa::path(
    get,
    path = "/devices/connected",
    tag = "device",
    description = "Returns the devices this server is currently connected to. Unlike `GET /devices` this runs no \
network discovery, so it answers immediately and is cheap enough to poll. A device that is busy streaming \
is still listed. Each entry carries its `access` state (as `GET /devices/{id}/access` reports it to this client).",
    responses(
        (status = 200, description = "Connected devices", body = Vec<ConnectedDevice>)
    )
)]
#[actix_web::get("/devices/connected")]
pub async fn get_connected_devices(ctx: web::Data<AppContext>, client: Client) -> Result<HttpResponse> {
    Ok(HttpResponse::Ok().json(ctx.dev_ctrl.connected(&client).await))
}

#[utoipa::path(
    put,
    path = "/devices/{id}/connect",
    tag = "device",
    description = "Connects to a device by id. If the ip is specified, it will be used to connect to the device, choose an id which will be assigned to this device. If the ip is not specified, the device will be discovered using the GV interface. If the device is already connected, this will do nothing. With a session, the session becomes a member of the device, which keeps it connected until the session leaves (`PUT /devices/{id}/disconnect`) or ends.

With `mode` (`shared`, `ro-shared` or `exclusive`; needs a session) the connect takes the device's lease in one atomic step, with the same rules as `PUT /devices/{id}/access` without `force`. Without `mode` the client joins in the device's current mode. Answers the device's access state.",
    params(
        ("id" = u32, Path, description = "Device id, can be found using get devices"),
        ("ip" = Option<String>, Query, description = "IP address of device"),
        ("mode" = Option<Mode>, Query, description = "Take the lease in this mode")
    ),
    responses(
        (status = 200, description = "Connected; the device's access state", body = DeviceAccess),
        (status = 400, description = "`session_required`: `mode` without a session", body = AccessError),
        (status = 409, description = "`device_in_use`: `exclusive` while other clients use the device", body = AccessError),
        (status = 423, description = "`device_locked`: another session owns the lease", body = AccessError)
    )
)]
#[actix_web::put("/devices/{id}/connect")]
pub async fn connect_device(ctx: web::Data<AppContext>, client: Client,
                            id: web::Path<u32>, query_data: web::Query<DeviceConnectionQuery>) -> Result<HttpResponse> {
    let id = id.into_inner();
    let DeviceConnectionQuery { ip, mode } = query_data.into_inner();
    if let Some(mode) = mode {
        return Ok(match ctx.dev_ctrl.set_access(&client, id, mode, false, ip).await {
            Ok(access) => HttpResponse::Ok().json(access),
            Err(e) => errors::respond("Connect error: ", &e),
        });
    }
    let adm = admit(&ctx, &client, id, Perm::Meta)?;
    let connected = match ip {
        Some(ip) => ctx.dev_ctrl.connect_by_ip(&adm, ip).await,
        None => ctx.dev_ctrl.connect(&adm).await,
    };
    Ok(match connected {
        Ok(()) => HttpResponse::Ok().json(ctx.dev_ctrl.access(&adm)),
        Err(e) => errors::respond("Connect error: ", &e),
    })
}


#[utoipa::path(
    put,
    path = "/devices/{id}/disconnect",
    tag = "device",
    description = "Disconnects a device by id. If the device is not connected, this will do nothing.

Several clients may use a device. With a session, this *leaves* the device: the camera closes \
only when no other session is a member and no live stream or burst job holds it. Without a \
session, it closes the device unless a session is a member of it or holds it with a stream or \
burst. `?force=true` closes it for everyone and needs write permission (`403`/`423` otherwise). `closed` in the answer says whether the device is \
closed now, `members` how many sessions still use it.

When the device closes, a live stream on it is stopped and its socket closed with `1001` (`device \
disconnected`); a running burst job is cancelled and keeps its record (status `cancelled`, error \
`device disconnected`, the images taken so far). Requests for the device that arrive meanwhile \
wait for the disconnect, then connect it again.",
    params(
        ("id" = u32, Path, description = "Device id, can be found using get devices"),
        ("force" = Option<bool>, Query, description = "Close the device for everyone")
    ),
    responses(
        (status = 200, description = "Left or disconnected the device", body = DisconnectResult),
        (status = 403, description = "`read_only`: `force` on a `ro-shared` device by a reader", body = AccessError),
        (status = 423, description = "`device_locked`: `force` on a device another session's lease locks", body = AccessError)
    )
)]
#[actix_web::put("/devices/{id}/disconnect")]
pub async fn disconnect_device(
    ctx: web::Data<AppContext>,
    client: Client,
    id: web::Path<u32>,
    query: web::Query<ForceQuery>,
) -> Result<HttpResponse> {
    // Not admitted as a member: leaving must not make the session one first.
    let perm = if query.force { Perm::Write } else { Perm::Meta };
    let adm = ctx.clients.admit_without_joining(&client, id.into_inner(), perm)?;
    match ctx.dev_ctrl.disconnect(&adm, query.force).await {
        Ok(result) => Ok(HttpResponse::Ok().json(result)),
        Err(e) => Ok(errors::respond("Disconnect error: ", &e)),
    }
}

#[utoipa::path(
    get,
    path = "/devices/{id}/xml",
    tag = "device",
    description = "Returns the GenICam xml of a device by id.",
    params(
        ("id" = u32, Path, description = "Device id, can be found using get devices")
    ),
    responses(
        (status = 200, description = "Xml as string", content_type = "application/xml", body = String)
    )
)]
#[actix_web::get("/devices/{id}/xml")]
pub async fn get_device_xml(
    ctx: web::Data<AppContext>,
    client: Client,
    id: web::Path<u32>,
) -> Result<HttpResponse> {
    let adm = admit(&ctx, &client, id.into_inner(), Perm::Meta)?;
    match ctx.dev_ctrl.genicam_xml(&adm).await {
        Ok(v) => Ok(HttpResponse::Ok().content_type(ContentType::xml()).body(v)),
        Err(e) => Ok(errors::respond("Error: ", &e)),
    }
}

#[utoipa::path(
    get,
    path = "/devices/{id}/gc/feature/{feature_name}",
    tag = "device",
    description = "Returns the GenICam feature value of a device by id. The feature name must match with nodes of /devices/{id}/gc/categories. The value is returned as a string.",
    params(
        ("id" = u32, Path, description = "Device id, can be found using get devices"),
        ("feature_name" = String, Path, description = "Name of the feature")
    ),
    responses(
        (status = 200, description = "Get GenICam feature value as string", body = String),
        (status = 423, description = LOCKED, body = AccessError)
    )
)]
#[actix_web::get("/devices/{id}/gc/feature/{feature_name}")]
pub async fn get_device_gc_node_value(
    ctx: web::Data<AppContext>,
    client: Client,
    path_vars: web::Path<(u32, String)>,
) -> Result<HttpResponse> {
    let (id, feature_name) = path_vars.into_inner();
    let adm = admit(&ctx, &client, id, Perm::Read)?;
    Ok(
        match ctx
            .dev_ctrl
            .genicam_get_feature_value(&adm, &feature_name)
            .await
        {
            Ok(v) => HttpResponse::Ok().body(v),
            Err(e) => errors::respond("Error: ", &e),
        },
    )
}

#[utoipa::path(
    put,
    path = "/devices/{id}/gc/feature/{feature_name}",
    description = "Sets the GenICam feature value of a device by id. The feature name must match with nodes of /devices/{id}/gc/categories. The value must be a string: an integer for Integer and Enum features (an Enum also takes its symbolic entry name), a number for Float, `true`/`false` (or `1`/`0`) for Boolean. Commands have no value; execute them with POST /devices/{id}/gc/command/{name}. The value can be retrieved using get devices/{id}/gc/feature/{feature_name} and set using put devices/{id}/gc/feature/{feature_name}?value={value}. While a live stream runs on the device, reads and writes are carried out inside the stream (which restarts acquisition if the change alters the payload) instead of failing as busy; PixelFormat and the stream destination (GevSCDA, GevSCPHostPort) are refused then. During a burst job they still fail as busy. GevSCPSPacketSize must be a multiple of its increment within its bounds and not above the link MTU (see GET /devices/{id}/stream/packet-size); it applies to every following grab, stream and burst.",
    tag = "device",
    params(
        ("id" = u32, Path, description = "Device id, can be found using get devices"),
        ("feature_name" = String, Path, description = "Name of the feature"),
        ("value" = String, Query, description = "Value as string")
    ),
    responses(
        (status = 200, description = "Value has been set"),
        (status = 403, description = READ_ONLY, body = AccessError),
        (status = 423, description = LOCKED, body = AccessError)
    )
)]
#[actix_web::put("/devices/{id}/gc/feature/{feature_name}")]
pub async fn set_device_gc_node_value(
    ctx: web::Data<AppContext>,
    client: Client,
    path_vars: web::Path<(u32, String)>,
    query_data: web::Query<StringValueQuery>,
) -> Result<HttpResponse> {
    let (id, feature_name) = path_vars.into_inner();
    let feature_value = query_data.0.value;
    let adm = admit(&ctx, &client, id, Perm::Write)?;
    Ok(
        match ctx
            .dev_ctrl
            .genicam_set_feature_value(&adm, &feature_name, &feature_value)
            .await
        {
            Ok(_) => HttpResponse::Ok().finish(),
            Err(e) => errors::respond("Error: ", &e),
        },
    )
}

#[utoipa::path(
    get,
    path = "/devices/{id}/gc/categories",
    tag = "device",
    description = "Returns the GenICam categories of a device by id. The categories are returned as a list of GenICamNodeCategory structs. Each struct contains the category name and a list of feature nodes. The feature nodes are returned as a list of GenICamNode structs. Each struct contains the node name, node type, and node value. The node value is returned as a string. Use the query parameter value to set the value of the feature. The value must be a string. The value can be retrieved using get devices/{id}/gc/feature/{feature_name} and set using put devices/{id}/gc/feature/{feature_name}?value={value}",
    params(
        ("id" = u32, Path, description = "Device id, can be found using get devices")
    ),
    responses(
        (status = 200, description = "GenICam categories with feature node info", body = Vec<GenICamNodeCategory>)
    )
)]
#[actix_web::get("/devices/{id}/gc/categories")]
pub async fn get_device_gc_categories(
    ctx: web::Data<AppContext>,
    client: Client,
    id: web::Path<u32>,
) -> Result<HttpResponse> {
    let adm = admit(&ctx, &client, id.into_inner(), Perm::Meta)?;
    Ok(
        match ctx.dev_ctrl.genicam_categories_json(&adm).await {
            Ok(v) => HttpResponse::Ok().json(v),
            Err(e) => errors::respond("Error: ", &e),
        },
    )
}

/// Most names one `POST /gc/features/state` may ask for.
const MAX_STATE_NAMES: usize = 256;

#[utoipa::path(
    post,
    path = "/devices/{id}/gc/features/state",
    tag = "device",
    description = "Returns the live state of several GenICam features in one request, in the order asked: the value \
(formatted as by GET /devices/{id}/gc/feature/{feature_name}), whether the feature is currently available and \
locked, and for numeric features their evaluated min/max/increment, unit and representation. For an Enum, \
`available_entries` lists the integer values of the entries the device currently offers. A problem with one \
feature (unknown name, failed read) is reported in that entry's `error`, not as a failed request. Works during a \
live stream like the single-feature routes. 400 for an empty list or more than 256 names.",
    params(
        ("id" = u32, Path, description = "Device id, can be found using get devices")
    ),
    request_body = FeatureStateRequest,
    responses(
        (status = 200, description = "One state per requested name, in request order", body = Vec<FeatureState>),
        (status = 400, description = "No names, or more than 256", body = String),
        (status = 423, description = LOCKED, body = AccessError),
        (status = 500, description = "The device could not be reached, or is busy with a burst job", body = String)
    )
)]
#[actix_web::post("/devices/{id}/gc/features/state")]
pub async fn get_device_gc_feature_states(
    ctx: web::Data<AppContext>,
    client: Client,
    id: web::Path<u32>,
    body: web::Json<FeatureStateRequest>,
) -> Result<HttpResponse> {
    let names = body.into_inner().names;
    if names.is_empty() || names.len() > MAX_STATE_NAMES {
        return Ok(HttpResponse::BadRequest().body(format!("names must hold 1 to {MAX_STATE_NAMES} feature names")));
    }
    let adm = admit(&ctx, &client, id.into_inner(), Perm::Read)?;
    Ok(match ctx.dev_ctrl.genicam_feature_states(&adm, names).await {
        Ok(v) => HttpResponse::Ok().json(v),
        Err(e) => errors::respond("Error: ", &e),
    })
}

#[utoipa::path(
    post,
    path = "/devices/{id}/gc/command/{command_name}",
    tag = "device",
    description = "Executes a GenICam Command feature (node_type `Command` in /devices/{id}/gc/categories), such as \
TriggerSoftware, UserSetLoad or UserSetSave. Not idempotent: each request executes the command once. Works during a \
live stream like the feature routes; AcquisitionStart/AcquisitionStop are refused then.",
    params(
        ("id" = u32, Path, description = "Device id, can be found using get devices"),
        ("command_name" = String, Path, description = "Name of the command feature")
    ),
    responses(
        (status = 200, description = "Command executed"),
        (status = 403, description = READ_ONLY, body = AccessError),
        (status = 423, description = LOCKED, body = AccessError),
        (status = 500, description = "Unknown feature, not a command, or the device refused it", body = String)
    )
)]
#[actix_web::post("/devices/{id}/gc/command/{command_name}")]
pub async fn execute_device_gc_command(
    ctx: web::Data<AppContext>,
    client: Client,
    path_vars: web::Path<(u32, String)>,
) -> Result<HttpResponse> {
    let (id, command_name) = path_vars.into_inner();
    let adm = admit(&ctx, &client, id, Perm::Write)?;
    Ok(match ctx.dev_ctrl.genicam_execute_command(&adm, &command_name).await {
        Ok(_) => HttpResponse::Ok().finish(),
        Err(e) => errors::respond("Error: ", &e),
    })
}

#[utoipa::path(
    get,
    path = "/devices/{id}/access",
    tag = "access",
    description = "The device's access mode, its owner (the session holding the lease), its member sessions, \
what holds its camera (`live` or `burst`, and who started it), its live viewers, and `you`: this client's role \
(`owner`, `writer`, `reader` or `meta`).

| mode | owner | other sessions | anonymous |
|---|---|---|---|
| `shared` (default) | – | read + write | read + write |
| `ro-shared` | read + write | read | meta |
| `exclusive` | read + write | meta | meta |

Meta routes are the GenICam XML and categories, `stream/error` and this one. Doesn't connect the device.",
    params(
        ("id" = u32, Path, description = "Device id")
    ),
    responses(
        (status = 200, description = "The device's access state", body = DeviceAccess)
    )
)]
#[actix_web::get("/devices/{id}/access")]
pub async fn get_device_access(ctx: web::Data<AppContext>, client: Client, id: web::Path<u32>) -> Result<HttpResponse> {
    let adm = admit(&ctx, &client, id.into_inner(), Perm::Meta)?;
    Ok(HttpResponse::Ok().json(ctx.dev_ctrl.access(&adm)))
}

#[utoipa::path(
    put,
    path = "/devices/{id}/access",
    tag = "access",
    description = "Takes or changes the device's lease (`ro-shared`, `exclusive`), or gives it up (`shared`), \
connecting the device if needed. Needs a session; the lease ends when its owner releases it, when the owner's \
session ends, on a force, or when the device closes, and the mode returns to `shared`.

Taking a lease another session owns is refused with `423` unless `force`. Going `exclusive` while other \
sessions are members of the device or another client's live stream or burst holds it is refused with `409` \
unless `force`, which evicts them: they leave the device, their live sockets close with `4003` (`access \
revoked`), their running bursts are cancelled (error `access revoked`), and each evicted session gets \
`access_revoked` on its events socket.",
    params(
        ("id" = u32, Path, description = "Device id")
    ),
    request_body = SetAccessRequest,
    responses(
        (status = 200, description = "The device's access state after the change", body = DeviceAccess),
        (status = 400, description = SESSION_REQUIRED, body = AccessError),
        (status = 409, description = IN_USE, body = AccessError),
        (status = 423, description = "`device_locked`: another session owns the lease", body = AccessError),
        (status = 500, description = "The device could not be connected", body = String)
    )
)]
#[actix_web::put("/devices/{id}/access")]
pub async fn set_device_access(
    ctx: web::Data<AppContext>,
    client: Client,
    id: web::Path<u32>,
    body: web::Json<SetAccessRequest>,
) -> Result<HttpResponse> {
    let SetAccessRequest { mode, force } = body.into_inner();
    Ok(match ctx.dev_ctrl.set_access(&client, id.into_inner(), mode, force, None).await {
        Ok(access) => HttpResponse::Ok().json(access),
        Err(e) => errors::respond("Connect error: ", &e),
    })
}

#[utoipa::path(
    delete,
    path = "/devices/{id}/access",
    tag = "access",
    description = "Gives up the device's lease (its owner), or breaks it (anyone, with `force`; the owner gets \
`access_revoked`). The mode returns to `shared`. Nothing to do on a device without a lease. Needs a session.",
    params(
        ("id" = u32, Path, description = "Device id"),
        ("force" = Option<bool>, Query, description = "Break another session's lease")
    ),
    responses(
        (status = 200, description = "The device's access state after the release", body = DeviceAccess),
        (status = 400, description = SESSION_REQUIRED, body = AccessError),
        (status = 423, description = "`device_locked`: another session owns the lease", body = AccessError)
    )
)]
#[actix_web::delete("/devices/{id}/access")]
pub async fn release_device_access(
    ctx: web::Data<AppContext>,
    client: Client,
    id: web::Path<u32>,
    query: web::Query<ForceQuery>,
) -> Result<HttpResponse> {
    Ok(match ctx.dev_ctrl.release_access(&client, id.into_inner(), query.force) {
        Ok(access) => HttpResponse::Ok().json(access),
        Err(e) => errors::respond("Error: ", &e),
    })
}

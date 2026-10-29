
pub mod device_endpoint;
pub mod errors;
pub mod events_endpoint;
pub mod grab_endpoint;
pub mod session_endpoint;
pub mod session_mw;
pub mod stream_endpoint;
pub mod websocket_endpoint;

use actix_web::middleware::from_fn;
use actix_web::web;

/// Every route, behind the session middleware. An empty-path scope, so the callers (`main`, the
/// fake server, the tests) mount it under `/api/v1` as before and get the middleware with it.
pub fn config_endpoints(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("")
            .wrap(from_fn(session_mw::resolve_session))
            .service(session_endpoint::create_session)
            .service(session_endpoint::heartbeat)
            .service(session_endpoint::rename_session)
            .service(session_endpoint::end_session)
            .service(session_endpoint::list_sessions)
            .service(events_endpoint::events)
            .service(device_endpoint::get_devices)
            .service(device_endpoint::get_connected_devices)
            .service(device_endpoint::connect_device)
            .service(device_endpoint::disconnect_device)
            .service(device_endpoint::get_device_access)
            .service(device_endpoint::set_device_access)
            .service(device_endpoint::release_device_access)
            .service(device_endpoint::get_device_xml)
            .service(device_endpoint::get_device_gc_categories)
            .service(device_endpoint::get_device_gc_node_value)
            .service(device_endpoint::set_device_gc_node_value)
            .service(device_endpoint::get_device_gc_feature_states)
            .service(device_endpoint::execute_device_gc_command)
            .service(stream_endpoint::grab_raw_frame)
            .service(stream_endpoint::grab_jpg_frame)
            .service(stream_endpoint::get_stream_error)
            .service(stream_endpoint::get_packet_size)
            .service(stream_endpoint::auto_packet_size)
            .service(websocket_endpoint::stream_live)
            .service(grab_endpoint::start_grab_job)
            .service(grab_endpoint::get_grab_job)
            .service(grab_endpoint::list_grab_job_images)
            .service(grab_endpoint::get_grab_job_image)
            .service(grab_endpoint::delete_grab_job),
    );
}

//! RACS — GigE Vision cameras over a REST API.
//!
//! Everything lives in the library target so integration tests under `tests/` can drive the
//! controllers and stores directly; `main.rs` is a thin binary over this.

pub mod app_context;
pub mod controller;
pub mod endpoints;
pub mod events;
pub mod maintenance;
pub mod models;
pub mod processor;
pub mod rcs_erros;
pub mod restapi_doc;
pub mod stores;
pub mod thread_stream;

pub mod server_config;
pub mod webapp;

use actix_web::{web, App, HttpServer};
use clap::Parser;
use rust_cam_serve::app_context::AppContext;
use rust_cam_serve::endpoints::config_endpoints;
use rust_cam_serve::maintenance;
use rust_cam_serve::restapi_doc::ApiDoc;
use rust_cam_serve::{server_config::ServerConfig, webapp};
use utoipa::OpenApi;

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let mut config = ServerConfig::parse();
    config.validate()?;
    env_logger::init();
    println!("Welcome to rust-cam-serve v{}", env!("CARGO_PKG_VERSION"));

    let context = AppContext::new(config.runtime()).await;
    // Expired sessions, idle devices and expired burst jobs.
    maintenance::spawn(context.clone());

    let web_root = config.web_root.clone();
    let server = HttpServer::new(move || {
        let app = App::new()
            .app_data(web::Data::new(context.clone()))
            .service(web::scope("/api/v1").configure(config_endpoints));

        let app = app.service(
            utoipa_swagger_ui::SwaggerUi::new("/swagger-ui/{_:.*}")
                .url("/api-docs/openapi.json", ApiDoc::openapi()),
        );
        if let Some(root) = &web_root {
            app.service(webapp::files(root.clone()))
        } else {
            app
        }
    });

    let server = server
        .bind((config.host.as_str(), config.port))
        .map_err(|e| {
            std::io::Error::new(e.kind(), format!("cannot bind {}: {e}", config.base_url()))
        })?;
    println!("Listening at {}", config.base_url());
    if config.web_root.is_some() {
        println!("Access the webapp at {}/", config.base_url());
    }
    println!(
        "Access the API documentation at {}/swagger-ui/",
        config.base_url()
    );
    println!("Stopping server with Ctrl+C");
    server.run().await
}

//! The integrated website must not swallow API errors or expose files outside its root.
use actix_web::{
    http::{header, StatusCode},
    test, web, App,
};
use clap::Parser;
use rust_cam_serve::{server_config::ServerConfig, webapp};
use std::{fs, path::PathBuf, process::Command};

#[macro_use]
mod common;

struct Site(PathBuf);
impl Site {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("racs-web-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::write(root.join("index.html"), "<html>RACS test</html>").unwrap();
        fs::write(root.join("main.js"), "console.log('racs');").unwrap();
        Self(root)
    }
}
impl Drop for Site {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[actix_web::test]
async fn static_files_navigation_and_reserved_routes() {
    let site = Site::new();
    let app = test::init_service(
        App::new()
            .service(web::scope("/api/v1").route("/example", web::get().to(|| async { "API" })))
            .service(webapp::files(site.0.clone())),
    )
    .await;
    for path in ["/", "/device-discovery", "/device/12"] {
        let req = test::TestRequest::get()
            .uri(path)
            .insert_header((header::ACCEPT, "text/html"))
            .to_request();
        let res = test::call_service(&app, req).await;
        assert_eq!(res.status(), StatusCode::OK, "{path}");
        assert!(res
            .headers()
            .get(header::CONTENT_TYPE)
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with("text/html"));
        assert_eq!(test::read_body(res).await, "<html>RACS test</html>");
    }
    let res = test::call_service(&app, test::TestRequest::get().uri("/main.js").to_request()).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert!(res
        .headers()
        .get(header::CONTENT_TYPE)
        .unwrap()
        .to_str()
        .unwrap()
        .contains("javascript"));
    let res = test::call_service(
        &app,
        test::TestRequest::get().uri("/api/v1/example").to_request(),
    )
    .await;
    assert_eq!(test::read_body(res).await, "API");
    for path in [
        "/missing.js",
        "/assets/missing",
        "/assets",
        "/assets/",
        "/api/v1/missing",
        "/api/missing",
        "/api-docs/missing",
        "/swagger-ui/missing",
        "/.secret",
        "/../Cargo.toml",
        "/%2e%2e/Cargo.toml",
    ] {
        let req = test::TestRequest::get()
            .uri(path)
            .insert_header((header::ACCEPT, "text/html"))
            .to_request();
        let res = test::call_service(&app, req).await;
        assert!(res.status().is_client_error(), "{path}: {}", res.status());
        assert_ne!(
            test::read_body(res).await,
            "<html>RACS test</html>",
            "{path}"
        );
    }
    let req = test::TestRequest::post()
        .uri("/device/12")
        .insert_header((header::ACCEPT, "text/html"))
        .to_request();
    assert!(test::call_service(&app, req)
        .await
        .status()
        .is_client_error());
    let req = test::TestRequest::default()
        .method(actix_web::http::Method::HEAD)
        .uri("/device/12")
        .insert_header((header::ACCEPT, "text/html"))
        .to_request();
    let res = test::call_service(&app, req).await;
    assert_eq!(res.status(), StatusCode::OK);
}

#[cfg(unix)]
#[actix_web::test]
async fn symlink_cannot_escape_web_root() {
    let site = Site::new();
    std::os::unix::fs::symlink("/etc/passwd", site.0.join("leak.txt")).unwrap();
    let app = test::init_service(App::new().service(webapp::files(site.0.clone()))).await;
    let res =
        test::call_service(&app, test::TestRequest::get().uri("/leak.txt").to_request()).await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
}

#[actix_web::test]
async fn configuration_validates_arguments_and_website() {
    let config = ServerConfig::try_parse_from(["racs"]).unwrap();
    assert_eq!(config.host, "0.0.0.0");
    assert_eq!(config.port, 8742);
    for port in ["0", "65536", "abc"] {
        assert!(ServerConfig::try_parse_from(["racs", "--port", port]).is_err());
    }
    assert!(ServerConfig::try_parse_from(["racs", "--host", ""]).is_err());
    let mut config =
        ServerConfig::try_parse_from(["racs", "--host", "::1", "--port", "9000"]).unwrap();
    assert_eq!(config.base_url(), "http://[::1]:9000");
    let site = Site::new();
    config.web_root = Some(site.0.clone());
    config.validate().unwrap();
    fs::remove_file(site.0.join("index.html")).unwrap();
    assert!(config.validate().is_err());

    // Auto-detect a sibling `web/` folder next to the executable when `--web-root` is omitted.
    let bundle_dir = std::env::temp_dir().join(format!("racs-bundle-test-{}", uuid::Uuid::new_v4()));
    let fake_exe = bundle_dir.join("racs-webapp.exe");
    fs::create_dir_all(&bundle_dir).unwrap();
    let mut config = ServerConfig::try_parse_from(["racs"]).unwrap();
    config.validate_with_exe(Some(&fake_exe)).unwrap();
    assert!(config.web_root.is_none());

    let web_dir = bundle_dir.join("web");
    fs::create_dir_all(&web_dir).unwrap();
    // Missing index.html in bundled web/ fails validation.
    let mut config = ServerConfig::try_parse_from(["racs"]).unwrap();
    assert!(config.validate_with_exe(Some(&fake_exe)).is_err());

    fs::write(web_dir.join("index.html"), "<html>Bundled</html>").unwrap();
    let mut config = ServerConfig::try_parse_from(["racs"]).unwrap();
    config.validate_with_exe(Some(&fake_exe)).unwrap();
    assert_eq!(config.web_root, Some(web_dir.canonicalize().unwrap()));

    // Explicit `--web-root` takes precedence over the bundled `web/` directory.
    let override_site = Site::new();
    let mut config = ServerConfig::try_parse_from([
        "racs",
        "--web-root",
        override_site.0.to_str().unwrap(),
    ])
    .unwrap();
    config.validate_with_exe(Some(&fake_exe)).unwrap();
    assert_eq!(config.web_root, Some(override_site.0.canonicalize().unwrap()));
    let _ = fs::remove_dir_all(&bundle_dir);
}

#[actix_web::test]
async fn cli_overrides_environment_and_help_needs_no_camera() {
    let bin = env!("CARGO_BIN_EXE_rust-cam-serve");
    let output = Command::new(bin)
        .env("RACS_HOST", "")
        .env("RACS_PORT", "bad")
        .env("RACS_WEB_ROOT", "/environment-root")
        .args([
            "--host",
            "127.0.0.1",
            "--port",
            "9000",
            "--web-root",
            "/nonexistent-racs-root",
        ])
        .output()
        .unwrap();
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(!output.status.success());
    assert!(
        error.contains("invalid web root /nonexistent-racs-root"),
        "{error}"
    );
    let output = Command::new(bin)
        .env("RACS_PORT", "bad")
        .arg("--help")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stdout).contains("RACS_PORT"));
    let output = Command::new(bin).env("RACS_PORT", "bad").output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("--port"));
}

#[actix_web::test]
async fn shared_listener_serves_website_and_live_websocket() {
    use futures::SinkExt;
    let (_camera, context) = common::app_context().await;
    let site = Site::new();
    let root = site.0.clone();
    let mut server = actix_test::start(move || {
        App::new()
            .configure(common::api(context.clone()))
            .service(webapp::files(root.clone()))
    });
    let response = server.get("/").send().await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response = server
        .head("/device/12")
        .insert_header((header::ACCEPT, "text/html"))
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let mut socket = server.ws_at("/api/v1/devices/0/stream/live").await.unwrap();
    let frame = next_frame!(socket);
    assert!(matches!(frame, awc::ws::Frame::Text(_)));
    let frame = next_frame!(socket);
    assert!(matches!(frame, awc::ws::Frame::Binary(_)));
    socket.send(awc::ws::Message::Close(None)).await.unwrap();
}

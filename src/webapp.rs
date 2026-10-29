//! Static website handling. Mount after API and documentation services.
use actix_files::{Files, NamedFile};
use actix_web::{
    dev::{fn_service, ServiceRequest, ServiceResponse},
    http::{header, Method},
    Error, HttpResponse,
};
use std::path::PathBuf;

pub fn files(root: PathBuf) -> Files {
    let filter_root = root.clone();
    Files::new("/", &root)
        .index_file("index.html")
        .disable_content_disposition()
        .path_filter(move |path, head| {
            if reserved(head.uri.path()) {
                return false;
            }
            // Files sanitizes URL traversal. Also prevent symlinks from escaping the root.
            match filter_root.join(path).canonicalize() {
                Ok(real) if real.starts_with(&filter_root) => {
                    if real.is_dir() {
                        real.join("index.html")
                            .canonicalize()
                            .map(|index| index.starts_with(&filter_root))
                            .unwrap_or(false)
                    } else {
                        true
                    }
                }
                _ => false,
            }
        })
        .default_handler(fn_service(move |request: ServiceRequest| {
            let root = root.clone();
            async move {
                let (req, _) = request.into_parts();
                let path = req.path();
                let html = req
                    .headers()
                    .get(header::ACCEPT)
                    .and_then(|h| h.to_str().ok())
                    .map(|h| {
                        h.split(',')
                            .any(|item| item.trim().starts_with("text/html"))
                    })
                    .unwrap_or(false);
                let navigation = matches!(*req.method(), Method::GET | Method::HEAD)
                    && html
                    && !reserved(path)
                    && !path
                        .split('/')
                        .any(|segment| segment.contains('.') || segment.contains('%'))
                    && path != "/assets"
                    && !path.starts_with("/assets/");
                let response = if navigation {
                    NamedFile::open_async(root.join("index.html"))
                        .await?
                        .into_response(&req)
                } else {
                    HttpResponse::NotFound().finish()
                };
                Ok::<_, Error>(ServiceResponse::new(req, response))
            }
        }))
}

fn reserved(path: &str) -> bool {
    ["/api", "/api-docs", "/swagger-ui"]
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
}

//! eisenpaper server: serves the built web app and owns the sheet file.
//!
//! `GET /tasks.json` returns the sheet, `PUT /tasks.json` replaces it
//! atomically. Every other `GET` is a file from the web directory.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::rejection::BytesRejection;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderName, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use tokio::net::TcpListener;

/// Marker header: tells the app this origin accepts `PUT /tasks.json`.
const MARKER: (HeaderName, HeaderValue) = (
    HeaderName::from_static("x-eisenpaper"),
    HeaderValue::from_static("1"),
);
/// Upper bound for an uploaded sheet; far above any real one.
const MAX_SHEET_BYTES: usize = 16 * 1024 * 1024;

/// Help text for `--help` and argument errors.
const USAGE: &str = "\
usage: eisenpaper [--host H] [--port P] [--web DIR] [--data FILE]
  --host  bind address, 0.0.0.0 for the LAN/phone (default 127.0.0.1)
  --port  port (default 8741)
  --web   built web app directory (default web/dist)
  --data  sheet file (default tasks.json)";

/// Runtime configuration from the command line.
#[derive(Debug, PartialEq, Eq)]
struct Config {
    /// Bind address.
    host: String,
    /// Bind port.
    port: u16,
    /// Directory holding the built web app.
    web: PathBuf,
    /// The sheet file.
    data: PathBuf,
}

/// What the command line asked for.
#[derive(Debug, PartialEq, Eq)]
enum Cli {
    /// Serve with this configuration.
    Run(Config),
    /// Print usage and exit.
    Help,
}

/// Parses arguments (without the program name).
fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Cli, String> {
    let mut cfg = Config {
        host: "127.0.0.1".to_owned(),
        port: 8741,
        web: PathBuf::from("web/dist"),
        data: PathBuf::from("tasks.json"),
    };
    let mut args = args.into_iter();
    while let Some(flag) = args.next() {
        if flag == "-h" || flag == "--help" {
            return Ok(Cli::Help);
        }
        let value = match flag.as_str() {
            "--host" | "--port" | "--web" | "--data" => {
                args.next().ok_or_else(|| format!("{flag} needs a value"))?
            }
            _ => return Err(format!("unknown argument: {flag}")),
        };
        match flag.as_str() {
            "--host" => cfg.host = value,
            "--port" => {
                cfg.port = value
                    .parse()
                    .map_err(|_| format!("--port needs a port number, got {value:?}"))?;
            }
            "--web" => cfg.web = value.into(),
            _ => cfg.data = value.into(),
        }
    }
    Ok(Cli::Run(cfg))
}

/// Maps a URL path to a file under `web`, or `None` if it may not be served.
///
/// Rejects every segment that is empty or starts with a dot, which rules out
/// `..` traversal and dotfiles. The URL is not percent-decoded, so encoded
/// separators only ever name a literal (nonexistent) file.
fn resolve_static(web: &Path, url_path: &str) -> Option<PathBuf> {
    let rel = url_path.strip_prefix('/')?;
    let rel = if rel.is_empty() { "index.html" } else { rel };
    let mut path = web.to_path_buf();
    for segment in rel.split('/') {
        if segment.is_empty() || segment.starts_with('.') || segment.contains('\\') {
            return None;
        }
        path.push(segment);
    }
    Some(path)
}

/// MIME type by file extension, for the files a Vite build emits.
fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json" | "map") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("ico") => "image/x-icon",
        Some("webmanifest") => "application/manifest+json",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

/// Serves a static file, following symlinks only if they stay inside `web`.
fn serve_static(web: &Path, url_path: &str) -> Response {
    let Some(path) = resolve_static(web, url_path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let inside = match (path.canonicalize(), web.canonicalize()) {
        (Ok(file), Ok(root)) => file.starts_with(root),
        _ => false,
    };
    if !inside {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Ok(data) = fs::read(&path) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Vite fingerprints everything under /assets/, so it can be cached forever
    let cache = if url_path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    (
        [
            (CONTENT_TYPE, HeaderValue::from_static(content_type(&path))),
            (CACHE_CONTROL, HeaderValue::from_static(cache)),
        ],
        data,
    )
        .into_response()
}

/// Every other `GET`: a file from the web directory.
async fn get_static(State(cfg): State<Arc<Config>>, uri: Uri) -> Response {
    serve_static(&cfg.web, uri.path())
}

/// `GET /tasks.json`: the sheet, or a marked 404 so the app knows it may PUT.
async fn get_sheet(State(cfg): State<Arc<Config>>) -> Response {
    let Ok(bytes) = fs::read(&cfg.data) else {
        return (StatusCode::NOT_FOUND, [MARKER]).into_response();
    };
    (
        [
            MARKER,
            (CONTENT_TYPE, HeaderValue::from_static("application/json")),
            (CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        bytes,
    )
        .into_response()
}

/// Why a sheet upload was refused.
#[derive(Debug)]
enum PutError {
    /// The body is not JSON; the existing sheet is left untouched.
    InvalidJson,
    /// Writing the file failed.
    Io(io::Error),
}

/// Writes the sheet atomically (temp file + rename) after validating it, so
/// a crash or a concurrent reader (Syncthing) never sees a partial sheet.
fn write_sheet(data: &Path, body: &[u8]) -> Result<(), PutError> {
    if serde_json::from_slice::<serde_json::Value>(body).is_err() {
        return Err(PutError::InvalidJson);
    }
    let name = data
        .file_name()
        .ok_or_else(|| PutError::Io(io::Error::other("data path has no file name")))?;
    let mut tmp_name = std::ffi::OsString::from(".");
    tmp_name.push(name);
    tmp_name.push(".tmp");
    let tmp = data.with_file_name(tmp_name);
    fs::write(&tmp, body).map_err(PutError::Io)?;
    fs::rename(&tmp, data).map_err(|e| {
        // best effort: the rename error is what matters to the caller
        drop(fs::remove_file(&tmp));
        PutError::Io(e)
    })
}

/// `PUT /tasks.json`: stores a body of at most [`MAX_SHEET_BYTES`].
async fn put_sheet(
    State(cfg): State<Arc<Config>>,
    body: Result<Bytes, BytesRejection>,
) -> Response {
    let status = match body {
        // 413 past the body limit, 400 if the body could not be read
        Err(rejection) => rejection.status(),
        Ok(body) => match write_sheet(&cfg.data, &body) {
            Ok(()) => StatusCode::NO_CONTENT,
            Err(PutError::InvalidJson) => StatusCode::BAD_REQUEST,
            Err(PutError::Io(e)) => {
                eprintln!("writing {} failed: {e}", cfg.data.display());
                StatusCode::INTERNAL_SERVER_ERROR
            }
        },
    };
    (status, [MARKER]).into_response()
}

/// The routes; any other method gets a 405.
///
/// Handlers do their file I/O synchronously: the files are local and small,
/// and on the single-threaded runtime (see `main`) it keeps two uploads from
/// interleaving inside `write_sheet`, which reuses one temp file name.
fn app(cfg: Arc<Config>) -> Router {
    Router::new()
        .route("/tasks.json", get(get_sheet).put(put_sheet))
        .fallback(get(get_static))
        .layer(DefaultBodyLimit::max(MAX_SHEET_BYTES))
        .with_state(cfg)
}

// one thread: connections are served concurrently, but handlers never run in parallel
#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let cfg = match parse_args(std::env::args().skip(1)) {
        Ok(Cli::Run(cfg)) => cfg,
        Ok(Cli::Help) => {
            println!("{USAGE}");
            return ExitCode::SUCCESS;
        }
        Err(msg) => {
            eprintln!("{msg}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    if !cfg.web.join("index.html").is_file() {
        eprintln!(
            "warning: no index.html in {} — only /tasks.json will work (run `just build`)",
            cfg.web.display()
        );
    }
    let listener = match TcpListener::bind((cfg.host.as_str(), cfg.port)).await {
        Ok(listener) => listener,
        Err(e) => {
            eprintln!("cannot bind {}:{}: {e}", cfg.host, cfg.port);
            return ExitCode::FAILURE;
        }
    };
    let shown = if cfg.host == "127.0.0.1" {
        "localhost"
    } else {
        cfg.host.as_str()
    };
    println!(
        "eisenpaper → http://{shown}:{} (sheet: {})",
        cfg.port,
        cfg.data.display()
    );
    if let Err(e) = axum::serve(listener, app(Arc::new(cfg))).await {
        eprintln!("server failed: {e}");
        return ExitCode::FAILURE;
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{Body, to_bytes};
    use axum::http::Request;
    use tower::ServiceExt;

    /// A fresh, empty directory per test.
    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("eisenpaper-test-{}-{name}", std::process::id()));
        drop(fs::remove_dir_all(&dir));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn args(list: &[&str]) -> Result<Cli, String> {
        parse_args(list.iter().map(|s| (*s).to_owned()))
    }

    /// The full router over a scratch directory, plus its sheet path.
    fn scratch_app(name: &str) -> (Router, PathBuf) {
        let dir = scratch(name);
        let data = dir.join("tasks.json");
        let cfg = Config {
            host: "127.0.0.1".to_owned(),
            port: 0,
            web: dir.join("web"),
            data: data.clone(),
        };
        (app(Arc::new(cfg)), data)
    }

    /// Sends one request through the router.
    async fn call(app: &Router, method: &str, uri: &str, body: Vec<u8>) -> Response {
        let req = Request::builder()
            .method(method)
            .uri(uri)
            .body(Body::from(body))
            .unwrap();
        app.clone().oneshot(req).await.unwrap()
    }

    #[test]
    fn resolve_maps_root_to_index_and_nested_assets_inside_web() {
        let web = Path::new("/srv/web");
        assert_eq!(
            resolve_static(web, "/"),
            Some(PathBuf::from("/srv/web/index.html"))
        );
        assert_eq!(
            resolve_static(web, "/assets/index-abc.js"),
            Some(PathBuf::from("/srv/web/assets/index-abc.js"))
        );
    }

    #[test]
    fn resolve_rejects_traversal_dotfiles_and_odd_segments() {
        let web = Path::new("/srv/web");
        for bad in [
            "/../etc/passwd",
            "/assets/../../etc/passwd",
            "/.git/config",
            "/assets/.hidden",
            "//etc/passwd",
            "/assets//x.js",
            "/a\\..\\b",
            "no-leading-slash",
        ] {
            assert_eq!(resolve_static(web, bad), None, "{bad} must be refused");
        }
    }

    #[test]
    fn serve_static_refuses_symlink_escaping_web_dir() {
        let dir = scratch("symlink");
        let web = dir.join("web");
        fs::create_dir_all(&web).unwrap();
        fs::write(dir.join("secret.txt"), "private").unwrap();
        std::os::unix::fs::symlink(dir.join("secret.txt"), web.join("leak.txt")).unwrap();
        assert_eq!(
            serve_static(&web, "/leak.txt").status(),
            StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn write_sheet_rejects_invalid_json_and_keeps_existing_sheet() {
        let dir = scratch("invalid");
        let data = dir.join("tasks.json");
        fs::write(&data, r#"{"tasks":[]}"#).unwrap();
        assert!(matches!(
            write_sheet(&data, b"not json{{"),
            Err(PutError::InvalidJson)
        ));
        assert_eq!(fs::read_to_string(&data).unwrap(), r#"{"tasks":[]}"#);
    }

    #[test]
    fn write_sheet_replaces_file_and_leaves_no_temp_behind() {
        let dir = scratch("atomic");
        let data = dir.join("tasks.json");
        fs::write(&data, "{}").unwrap();
        write_sheet(&data, br#"{"tasks":[1]}"#).unwrap();
        assert_eq!(fs::read_to_string(&data).unwrap(), r#"{"tasks":[1]}"#);
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .filter(|n| n != "tasks.json")
            .collect();
        assert!(leftovers.is_empty(), "stray files: {leftovers:?}");
    }

    #[tokio::test]
    async fn sheet_responses_carry_the_marker_the_app_looks_for() {
        let (app, _) = scratch_app("marker");
        // no sheet yet: a marked 404 tells the app to create one
        let res = call(&app, "GET", "/tasks.json", Vec::new()).await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert_eq!(res.headers()["x-eisenpaper"], "1");
        let sheet = br#"{"tasks":[],"archive":[]}"#;
        let res = call(&app, "PUT", "/tasks.json", sheet.to_vec()).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert_eq!(res.headers()["x-eisenpaper"], "1");
        let res = call(&app, "GET", "/tasks.json?t=1", Vec::new()).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()["x-eisenpaper"], "1");
        assert_eq!(res.headers()["cache-control"], "no-store");
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body, &sheet[..]);
    }

    #[tokio::test]
    async fn put_accepts_max_sheet_bytes_and_refuses_one_more() {
        let (app, data) = scratch_app("limit");
        // a JSON string of exactly the limit, far above axum's 2 MiB default
        let mut sheet = vec![b'x'; MAX_SHEET_BYTES];
        sheet[0] = b'"';
        sheet[MAX_SHEET_BYTES - 1] = b'"';
        let res = call(&app, "PUT", "/tasks.json", sheet.clone()).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        sheet.insert(1, b'x');
        let res = call(&app, "PUT", "/tasks.json", sheet).await;
        assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(res.headers()["x-eisenpaper"], "1");
        assert_eq!(fs::read(&data).unwrap().len(), MAX_SHEET_BYTES);
    }

    #[test]
    fn parse_args_defaults_and_overrides() {
        let Ok(Cli::Run(cfg)) = args(&[]) else {
            panic!("defaults must parse")
        };
        assert_eq!((cfg.host.as_str(), cfg.port), ("127.0.0.1", 8741));
        let Ok(Cli::Run(cfg)) = args(&["--port", "9000", "--data", "/x/sheet.json"]) else {
            panic!("overrides must parse")
        };
        assert_eq!(cfg.port, 9000);
        assert_eq!(cfg.data, PathBuf::from("/x/sheet.json"));
    }

    #[test]
    fn parse_args_rejects_bad_input() {
        assert!(args(&["--port", "http"]).is_err());
        assert!(args(&["--port"]).is_err());
        assert!(args(&["--dir", "x"]).is_err());
        assert_eq!(args(&["--help"]), Ok(Cli::Help));
    }
}

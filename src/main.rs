//! eisenpaper server: serves the built web app and owns the sheet file.
//!
//! `GET /tasks.json` returns the sheet, `PUT /tasks.json` replaces it
//! atomically. Every other `GET` is a file from the web directory.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, FromRequest, Request, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::{HeaderName, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Extension, Router};
use tokio::net::TcpListener;
use tokio::sync::Semaphore;

/// Marker header: tells the app this origin accepts `PUT /tasks.json`.
const MARKER: (HeaderName, HeaderValue) = (
    HeaderName::from_static("x-eisenpaper"),
    HeaderValue::from_static("1"),
);
/// Upper bound for an uploaded sheet; far above any real one.
const MAX_SHEET_BYTES: usize = 16 * 1024 * 1024;
/// Uploads whose bodies may be read at once; each buffers up to
/// [`MAX_SHEET_BYTES`], so this bounds the memory uploads can pin.
const MAX_UPLOADS: usize = 2;
/// How long an upload may wait for a slot and send its body before it is
/// refused with 408, so stalled clients cannot pin a buffer or a slot (nor
/// keep a queued upload waiting) for longer than this.
const BODY_TIMEOUT: Duration = Duration::from_secs(30);

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
///
/// Only a missing file is a 404: any other read failure is a marked 500, so
/// the app shows an error instead of creating a sheet over the existing one.
async fn get_sheet(State(cfg): State<Arc<Config>>) -> Response {
    let bytes = match fs::read(&cfg.data) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            return (StatusCode::NOT_FOUND, [MARKER]).into_response();
        }
        Err(e) => {
            eprintln!("reading {} failed: {e}", cfg.data.display());
            return (StatusCode::INTERNAL_SERVER_ERROR, [MARKER]).into_response();
        }
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

/// `PUT /tasks.json`: stores a body of at most [`MAX_SHEET_BYTES`], read
/// while holding one of the [`MAX_UPLOADS`] slots, all within [`BODY_TIMEOUT`].
async fn put_sheet(
    State(cfg): State<Arc<Config>>,
    Extension(uploads): Extension<Arc<Semaphore>>,
    request: Request,
) -> Response {
    let upload = async {
        // the semaphore is never closed, so this only waits for a free slot
        let Ok(slot) = uploads.acquire().await else {
            return Err(StatusCode::INTERNAL_SERVER_ERROR);
        };
        // 413 past the body limit, 400 if the body could not be read
        let body = Bytes::from_request(request, &())
            .await
            .map_err(|rejection| rejection.status())?;
        Ok((slot, body))
    };
    let status = match tokio::time::timeout(BODY_TIMEOUT, upload).await {
        Err(_elapsed) => StatusCode::REQUEST_TIMEOUT,
        Ok(Err(status)) => status,
        // the slot is held until the buffered body is written and dropped
        Ok(Ok((_slot, body))) => match write_sheet(&cfg.data, &body) {
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
        .layer(Extension(Arc::new(Semaphore::new(MAX_UPLOADS))))
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
    use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
    use tokio::sync::mpsc::UnboundedSender;
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

    /// In-memory connections for `axum::serve`. Without sockets, paused time
    /// only skips ahead once the server is really waiting.
    struct Pipes(tokio::sync::mpsc::UnboundedReceiver<DuplexStream>);

    impl axum::serve::Listener for Pipes {
        type Io = DuplexStream;
        type Addr = ();

        async fn accept(&mut self) -> (DuplexStream, ()) {
            match self.0.recv().await {
                Some(pipe) => (pipe, ()),
                None => std::future::pending().await,
            }
        }

        fn local_addr(&self) -> io::Result<()> {
            Ok(())
        }
    }

    /// Serves the full app the way `main` does, over [`Pipes`].
    fn spawn_server(name: &str) -> (UnboundedSender<DuplexStream>, PathBuf) {
        let (app, data) = scratch_app(name);
        let (connect, pipes) = tokio::sync::mpsc::unbounded_channel();
        drop(tokio::spawn(
            async move { axum::serve(Pipes(pipes), app).await },
        ));
        (connect, data)
    }

    /// Opens a connection and sends `request` on it.
    async fn send(server: &UnboundedSender<DuplexStream>, request: &[u8]) -> DuplexStream {
        let (mut conn, pipe) = tokio::io::duplex(64 * 1024);
        server.send(pipe).unwrap();
        conn.write_all(request).await.unwrap();
        conn
    }

    /// A PUT whose body stops after one of its 100 bytes.
    const STALLED_PUT: &[u8] =
        b"PUT /tasks.json HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{";

    /// Reads a response head (these responses have no body), failing the
    /// test if none comes in time. Not waiting for the close keeps paused
    /// time from skipping ahead while the connection shuts down.
    async fn response(conn: &mut DuplexStream) -> String {
        let mut res = Vec::new();
        let read_head = async {
            while !res.ends_with(b"\r\n\r\n") {
                let mut buf = [0; 512];
                let len = conn.read(&mut buf).await.unwrap();
                assert!(len > 0, "connection closed mid-response");
                res.extend_from_slice(&buf[..len]);
            }
        };
        tokio::time::timeout(BODY_TIMEOUT * 2, read_head)
            .await
            .expect("no response before the deadline");
        String::from_utf8(res).unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_put_body_is_refused_with_marked_408() {
        let (server, _) = spawn_server("stalled");
        let start = tokio::time::Instant::now();
        let mut conn = send(&server, STALLED_PUT).await;
        let res = response(&mut conn).await;
        assert!(res.starts_with("HTTP/1.1 408"), "{res}");
        assert!(res.contains("x-eisenpaper: 1"), "{res}");
        assert!(start.elapsed() >= BODY_TIMEOUT);
    }

    #[tokio::test(start_paused = true)]
    async fn put_body_waits_while_max_uploads_are_being_read() {
        let (server, data) = spawn_server("permits");
        let start = tokio::time::Instant::now();
        let mut stalled = Vec::new();
        for _ in 0..MAX_UPLOADS {
            stalled.push(send(&server, STALLED_PUT).await);
        }
        // paused time only advances once the server idles: all slots are taken
        tokio::time::sleep(Duration::from_secs(1)).await;
        let mut conn = send(
            &server,
            b"PUT /tasks.json HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}",
        )
        .await;
        let res = response(&mut conn).await;
        assert!(res.starts_with("HTTP/1.1 204"), "{res}");
        // its body was only read once a stalled upload gave up its slot
        assert!(start.elapsed() >= BODY_TIMEOUT);
        assert_eq!(fs::read_to_string(&data).unwrap(), "{}");
        for conn in &mut stalled {
            assert!(response(conn).await.starts_with("HTTP/1.1 408"));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn put_waiting_for_a_slot_is_refused_within_body_timeout() {
        let (server, _) = spawn_server("queued");
        let mut stalled = Vec::new();
        for _ in 0..MAX_UPLOADS {
            stalled.push(send(&server, STALLED_PUT).await);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        let start = tokio::time::Instant::now();
        let mut queued = send(&server, STALLED_PUT).await;
        let res = response(&mut queued).await;
        assert!(res.starts_with("HTTP/1.1 408"), "{res}");
        // the wait for a slot counts: no fresh BODY_TIMEOUT once it gets one
        assert!(start.elapsed() <= BODY_TIMEOUT);
        for conn in &mut stalled {
            assert!(response(conn).await.starts_with("HTTP/1.1 408"));
        }
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
        assert_eq!(res.headers()["content-type"], "application/json");
        let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body, &sheet[..]);
    }

    #[tokio::test]
    async fn static_responses_never_carry_the_marker() {
        let (app, data) = scratch_app("unmarked");
        fs::write(&data, "{}").unwrap();
        // an unmarked 404 keeps the app from treating the origin as writable
        for uri in ["/missing.js", "/sub/tasks.json", "/tasks.json/x"] {
            let res = call(&app, "GET", uri, Vec::new()).await;
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "{uri}");
            assert!(!res.headers().contains_key("x-eisenpaper"), "{uri}");
        }
    }

    #[tokio::test]
    async fn put_with_query_string_still_writes_the_sheet() {
        let (app, data) = scratch_app("put-query");
        let res = call(&app, "PUT", "/tasks.json?x=1", b"{}".to_vec()).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert_eq!(fs::read_to_string(&data).unwrap(), "{}");
    }

    #[tokio::test]
    async fn other_methods_are_refused_with_405_and_write_nothing() {
        let (app, data) = scratch_app("methods");
        for (method, uri) in [
            ("POST", "/tasks.json"),
            ("DELETE", "/tasks.json"),
            ("PATCH", "/tasks.json"),
            ("POST", "/"),
            ("PUT", "/"),
            ("PUT", "/sub/tasks.json"),
        ] {
            let res = call(&app, method, uri, b"{}".to_vec()).await;
            assert_eq!(
                res.status(),
                StatusCode::METHOD_NOT_ALLOWED,
                "{method} {uri}"
            );
        }
        assert!(!data.exists());
    }

    #[tokio::test]
    async fn unreadable_sheet_is_a_marked_500_not_a_404() {
        let (app, data) = scratch_app("unreadable");
        // the sheet exists but cannot be read; a 404 would make the app overwrite it
        fs::create_dir_all(&data).unwrap();
        let res = call(&app, "GET", "/tasks.json", Vec::new()).await;
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(res.headers()["x-eisenpaper"], "1");
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

    #[tokio::test]
    async fn put_of_invalid_json_is_a_marked_400_and_keeps_the_sheet() {
        let (app, data) = scratch_app("put-invalid");
        fs::write(&data, r#"{"tasks":[]}"#).unwrap();
        let res = call(&app, "PUT", "/tasks.json", b"not json{{".to_vec()).await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert_eq!(res.headers()["x-eisenpaper"], "1");
        assert_eq!(fs::read_to_string(&data).unwrap(), r#"{"tasks":[]}"#);
    }

    #[tokio::test]
    async fn put_whose_rename_fails_is_a_marked_500_and_leaves_no_temp_behind() {
        let (app, data) = scratch_app("put-rename");
        // the temp file can be written, but renaming a file onto a directory fails
        fs::create_dir_all(&data).unwrap();
        let res = call(&app, "PUT", "/tasks.json", b"{}".to_vec()).await;
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(res.headers()["x-eisenpaper"], "1");
        assert!(data.is_dir());
        // a stray temp file would be synced next to the real sheet
        let tmp = data.with_file_name(".tasks.json.tmp");
        assert!(!tmp.exists(), "{} left behind", tmp.display());
    }

    #[test]
    fn write_sheet_reports_unwritable_paths_as_io_errors() {
        // no file name to derive the temp name from: refused before any write
        assert!(matches!(
            write_sheet(Path::new("/"), b"{}"),
            Err(PutError::Io(_))
        ));
        // the temp file itself cannot be created
        let data = scratch("missing-dir").join("gone").join("tasks.json");
        assert!(matches!(write_sheet(&data, b"{}"), Err(PutError::Io(_))));
        assert!(!data.exists());
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

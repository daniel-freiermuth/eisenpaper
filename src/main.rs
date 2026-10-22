//! eisenpaper server: serves the built web app and owns the sheet file.
//!
//! `GET /tasks.json` returns the sheet with an `ETag`; `PUT /tasks.json`
//! replaces it atomically, but only if its `If-Match` names the sheet's
//! current `ETag` (or `If-None-Match: *` while there is no sheet), so a
//! client that missed another device's save gets a 412 instead of
//! overwriting it. Every other `GET` is a file from the web directory.

use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::ExitCode;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, FromRequest, Request, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, ETAG, IF_MATCH, IF_NONE_MATCH};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::serve::Listener;
use axum::{Extension, Router};
use hyper::server::conn::http1;
use hyper_util::rt::{TokioIo, TokioTimer};
use hyper_util::service::TowerToHyperService;
use serde::Deserialize;
use serde::de::IgnoredAny;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpListener;
use tokio::sync::Semaphore;
use tokio::time::Sleep;

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
/// How long a connection may take to send a request head, counted from when
/// the server starts waiting for one: on a new connection and after every
/// response. Idle keep-alive and stalled-header connections are closed after
/// this, so they cannot pile up and pin sockets and header buffers.
const HEADER_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a response write may wait for the client to read before the
/// connection is closed, so clients that stop reading cannot pile up and pin
/// sockets and buffered responses either.
const WRITE_TIMEOUT: Duration = Duration::from_secs(30);

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

/// The sheet's entity tag (RFC 9110 §8.8.3): a quoted FNV-1a hash of its
/// bytes. Derived from the content, it stays valid across restarts and
/// changes whenever anything (another device, Syncthing, an editor)
/// rewrites the file.
#[expect(
    clippy::expect_used,
    reason = "16 hex digits in quotes are always a valid header value"
)]
fn etag(bytes: &[u8]) -> HeaderValue {
    let hash = bytes.iter().fold(0xcbf2_9ce4_8422_2325_u64, |h, &b| {
        (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3)
    });
    HeaderValue::try_from(format!("\"{hash:016x}\"")).expect("hex is a valid header value")
}

/// Whether a comma-separated entity-tag list names `current` (`*` names any
/// existing sheet). Weak tags never match: `If-Match` compares strongly.
fn names(list: &HeaderValue, current: Option<&HeaderValue>) -> bool {
    let Some(current) = current else {
        return false;
    };
    let Ok(list) = list.to_str() else {
        return false;
    };
    list.split(',')
        .map(str::trim)
        .any(|tag| tag == "*" || tag.as_bytes() == current.as_bytes())
}

/// Checks a PUT's preconditions against the current sheet's tag (`None` =
/// no sheet), per RFC 9110 §13.2.2. A PUT without any is refused with 428
/// (RFC 6585): that is a blind overwrite of whatever another device saved.
fn precondition(headers: &HeaderMap, current: Option<&HeaderValue>) -> Result<(), StatusCode> {
    let ok = if let Some(if_match) = headers.get(IF_MATCH) {
        names(if_match, current)
    } else if let Some(if_none_match) = headers.get(IF_NONE_MATCH) {
        // weak comparison, but our tags are never weak: same test
        !names(if_none_match, current)
    } else {
        return Err(StatusCode::PRECONDITION_REQUIRED);
    };
    if ok {
        Ok(())
    } else {
        Err(StatusCode::PRECONDITION_FAILED)
    }
}

/// Reads the sheet; `Ok(None)` if there is none yet.
fn read_sheet(data: &Path) -> io::Result<Option<Vec<u8>>> {
    match fs::read(data) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// `GET /tasks.json`: the sheet and its `ETag`, or a marked 404 so the app
/// knows it may create one.
///
/// Only a missing file is a 404: any other read failure is a marked 500, so
/// the app shows an error instead of creating a sheet over the existing one.
async fn get_sheet(State(cfg): State<Arc<Config>>) -> Response {
    let bytes = match read_sheet(&cfg.data) {
        Ok(Some(bytes)) => bytes,
        Ok(None) => return (StatusCode::NOT_FOUND, [MARKER]).into_response(),
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
            (ETAG, etag(&bytes)),
        ],
        bytes,
    )
        .into_response()
}

/// The shape of a sheet, mirroring `SheetSchema` in `web/src/lib/model.ts`.
///
/// Only checked, never used: the raw body is what gets stored, so unknown
/// fields and the task contents round-trip untouched.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[expect(dead_code, reason = "parsed to validate the upload, then dropped")]
struct SheetShape {
    /// Open tasks.
    tasks: Vec<IgnoredAny>,
    /// Archived sheets.
    archive: Vec<IgnoredAny>,
    /// Optional, but a number when present: `null` is refused like the app does.
    #[serde(default)]
    saved_at: f64,
}

/// Why a sheet upload was refused.
#[derive(Debug)]
enum PutError {
    /// The body is not a sheet; the existing sheet is left untouched.
    InvalidSheet,
    /// Writing the file failed.
    Io(io::Error),
}

/// Follows `data` while it is a symlink, even when the final target does not
/// exist yet. A relative target is relative to the link's directory.
fn resolve_links(data: &Path) -> Result<PathBuf, PutError> {
    let mut path = data.to_path_buf();
    // the kernel's own limit on links followed in a single lookup
    for _ in 0..40 {
        match fs::read_link(&path) {
            Ok(target) => path = path.parent().unwrap_or_else(|| Path::new("")).join(target),
            Err(_) => return Ok(path),
        }
    }
    Err(PutError::Io(io::Error::other(
        "too many levels of symbolic links",
    )))
}

/// Writes the sheet atomically (temp file + rename) after validating it, so
/// a crash or a concurrent reader (Syncthing) never sees a partial sheet.
///
/// The temp file is fsynced before the rename and the directory after it:
/// otherwise a power loss can persist the rename but not the data, leaving
/// an empty or truncated sheet in place of the old one.
fn write_sheet(data: &Path, body: &[u8]) -> Result<(), PutError> {
    if serde_json::from_slice::<SheetShape>(body).is_err() {
        return Err(PutError::InvalidSheet);
    }
    // rename replaces a symlink rather than writing through it, so write next
    // to and over the file it points at (e.g. a link into a Syncthing folder).
    // Links are followed by hand: canonicalize fails on a link whose target
    // does not exist yet, which is exactly the first write into a sync folder.
    let data = resolve_links(data)?;
    let data = data.as_path();
    let name = data
        .file_name()
        .ok_or_else(|| PutError::Io(io::Error::other("data path has no file name")))?;
    let mut tmp_name = std::ffi::OsString::from(".");
    tmp_name.push(name);
    tmp_name.push(".tmp");
    let tmp = data.with_file_name(tmp_name);
    let replace = || {
        let mut file = fs::File::create(&tmp)?;
        // a new file gets the umask's mode: keep the sheet's (e.g. a private
        // 0600) instead, and set it before the contents go in
        match fs::metadata(data) {
            Ok(sheet) => file.set_permissions(sheet.permissions())?,
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        file.write_all(body)?;
        file.sync_all()?;
        fs::rename(&tmp, data)
    };
    replace().map_err(|e| {
        // best effort: the write or rename error is what matters to the caller
        drop(fs::remove_file(&tmp));
        PutError::Io(e)
    })?;
    // a bare file name has an empty parent: the current directory
    let dir = match data.parent() {
        Some(dir) if !dir.as_os_str().is_empty() => dir,
        _ => Path::new("."),
    };
    fs::File::open(dir)
        .and_then(|dir| dir.sync_all())
        .map_err(PutError::Io)
}

/// Replaces the sheet with `body` if the request's preconditions hold for
/// the sheet on disk right now; returns the new `ETag`, or the status to
/// refuse with plus the current `ETag` (if there is a sheet).
///
/// Synchronous on purpose: no other handler can run between the check and
/// the write (see [`app`]), so two uploads cannot both pass the same check.
fn store_sheet(
    data: &Path,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<HeaderValue, (StatusCode, Option<HeaderValue>)> {
    let current = match read_sheet(data) {
        Ok(bytes) => bytes.map(|b| etag(&b)),
        Err(e) => {
            eprintln!("reading {} failed: {e}", data.display());
            return Err((StatusCode::INTERNAL_SERVER_ERROR, None));
        }
    };
    if let Err(status) = precondition(headers, current.as_ref()) {
        return Err((status, current));
    }
    match write_sheet(data, body) {
        Ok(()) => Ok(etag(body)),
        Err(PutError::InvalidSheet) => Err((StatusCode::BAD_REQUEST, None)),
        Err(PutError::Io(e)) => {
            eprintln!("writing {} failed: {e}", data.display());
            Err((StatusCode::INTERNAL_SERVER_ERROR, None))
        }
    }
}

/// `PUT /tasks.json`: stores a body of at most [`MAX_SHEET_BYTES`], read
/// while holding one of the [`MAX_UPLOADS`] slots, all within [`BODY_TIMEOUT`],
/// if its `If-Match`/`If-None-Match` still holds (see [`store_sheet`]).
/// Success and 412 both carry the sheet's current `ETag`.
async fn put_sheet(
    State(cfg): State<Arc<Config>>,
    Extension(uploads): Extension<Arc<Semaphore>>,
    request: Request,
) -> Response {
    let headers = request.headers().clone();
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
    let (status, tag) = match tokio::time::timeout(BODY_TIMEOUT, upload).await {
        Err(_elapsed) => (StatusCode::REQUEST_TIMEOUT, None),
        Ok(Err(status)) => (status, None),
        // the slot is held until the buffered body is written and dropped
        Ok(Ok((_slot, body))) => match store_sheet(&cfg.data, &headers, &body) {
            Ok(tag) => (StatusCode::NO_CONTENT, Some(tag)),
            Err(refusal) => refusal,
        },
    };
    let mut res = (status, [MARKER]).into_response();
    res.headers_mut().extend(tag.map(|tag| (ETAG, tag)));
    res
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

/// A connection whose writes fail once one has been pending for
/// [`WRITE_TIMEOUT`], which ends the connection.
///
/// hyper only times out reading a request head: without this, a client that
/// stops reading a response larger than the socket buffers keeps its
/// connection, and the whole buffered response, forever.
struct WriteTimeout<I> {
    /// The connection.
    io: I,
    /// Fires [`WRITE_TIMEOUT`] after the pending write began to wait.
    deadline: Pin<Box<Sleep>>,
    /// Whether a write is pending, so `deadline` is armed.
    pending: bool,
}

impl<I> WriteTimeout<I> {
    /// Wraps `io`; must be called inside the runtime.
    fn new(io: I) -> Self {
        Self {
            io,
            deadline: Box::pin(tokio::time::sleep(WRITE_TIMEOUT)),
            pending: false,
        }
    }

    /// Passes on a write's result, but fails one still pending at the deadline.
    fn check<T>(&mut self, cx: &mut Context<'_>, poll: Poll<io::Result<T>>) -> Poll<io::Result<T>> {
        if poll.is_ready() {
            self.pending = false;
            return poll;
        }
        if !self.pending {
            self.pending = true;
            let deadline = tokio::time::Instant::now() + WRITE_TIMEOUT;
            self.deadline.as_mut().reset(deadline);
        }
        self.deadline
            .as_mut()
            .poll(cx)
            .map(|()| Err(io::ErrorKind::TimedOut.into()))
    }
}

impl<I: AsyncRead + Unpin> AsyncRead for WriteTimeout<I> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().io).poll_read(cx, buf)
    }
}

impl<I: AsyncWrite + Unpin> AsyncWrite for WriteTimeout<I> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let poll = Pin::new(&mut this.io).poll_write(cx, buf);
        this.check(cx, poll)
    }

    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let poll = Pin::new(&mut this.io).poll_write_vectored(cx, bufs);
        this.check(cx, poll)
    }

    fn is_write_vectored(&self) -> bool {
        self.io.is_write_vectored()
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let poll = Pin::new(&mut this.io).poll_flush(cx);
        this.check(cx, poll)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        let poll = Pin::new(&mut this.io).poll_shutdown(cx);
        this.check(cx, poll)
    }
}

/// Serves `app` over HTTP/1.1 on every connection `listener` accepts.
///
/// Unlike `axum::serve`, hyper gets a timer here, which is what makes it
/// enforce [`HEADER_TIMEOUT`], and every connection gets a [`WriteTimeout`].
/// Accept errors are retried by the [`Listener`] impl (with a backoff for
/// `TcpListener`).
async fn serve(mut listener: impl Listener, app: Router) -> ! {
    loop {
        let (io, _addr) = listener.accept().await;
        let conn = http1::Builder::new()
            .timer(TokioTimer::new())
            .header_read_timeout(HEADER_TIMEOUT)
            .serve_connection(
                TokioIo::new(WriteTimeout::new(io)),
                TowerToHyperService::new(app.clone()),
            );
        // a failed or timed-out connection only concerns its own client
        drop(tokio::spawn(async move { drop(conn.await) }));
    }
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
    serve(listener, app(Arc::new(cfg))).await
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

    /// PUTs `body` to the sheet with one precondition header.
    async fn put(app: &Router, precondition: (&str, &str), body: &[u8]) -> Response {
        let req = Request::builder()
            .method("PUT")
            .uri("/tasks.json")
            .header(precondition.0, precondition.1)
            .body(Body::from(body.to_vec()))
            .unwrap();
        app.clone().oneshot(req).await.unwrap()
    }

    /// The response's `ETag`, as a string.
    fn tag_of(res: &Response) -> String {
        res.headers()[ETAG].to_str().unwrap().to_owned()
    }

    /// A distinct, valid sheet for each `n`.
    fn version(n: u8) -> Vec<u8> {
        format!(r#"{{"tasks":[{n}],"archive":[]}}"#).into_bytes()
    }

    /// In-memory connections for `axum::serve`. Without sockets, paused time
    /// only skips ahead once the server is really waiting.
    struct Pipes(tokio::sync::mpsc::UnboundedReceiver<DuplexStream>);

    impl Listener for Pipes {
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
        drop(tokio::spawn(serve(Pipes(pipes), app)));
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

    /// The smallest body `write_sheet` accepts, for tests about what happens
    /// after validation.
    const EMPTY_SHEET: &[u8] = br#"{"tasks":[],"archive":[]}"#;

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
            b"PUT /tasks.json HTTP/1.1\r\nHost: x\r\nIf-None-Match: *\r\nContent-Length: 25\r\n\r\n{\"tasks\":[],\"archive\":[]}",
        )
        .await;
        let res = response(&mut conn).await;
        assert!(res.starts_with("HTTP/1.1 204"), "{res}");
        // its body was only read once a stalled upload gave up its slot
        assert!(start.elapsed() >= BODY_TIMEOUT);
        assert_eq!(
            fs::read_to_string(&data).unwrap(),
            r#"{"tasks":[],"archive":[]}"#
        );
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

    /// Reads until the server closes `conn`, failing the test if it is
    /// still open at the deadline.
    async fn closed(conn: &mut DuplexStream) {
        let mut rest = Vec::new();
        let _len = tokio::time::timeout(HEADER_TIMEOUT * 2, conn.read_to_end(&mut rest))
            .await
            .expect("connection still open at the deadline")
            .unwrap();
    }

    #[tokio::test(start_paused = true)]
    async fn connection_that_never_finishes_its_request_head_is_closed() {
        let (server, _) = spawn_server("partial-head");
        let start = tokio::time::Instant::now();
        let mut conn = send(&server, b"PUT /tasks.json HTTP/1.1\r\n").await;
        closed(&mut conn).await;
        assert!(start.elapsed() >= HEADER_TIMEOUT);
    }

    #[tokio::test(start_paused = true)]
    async fn idle_keep_alive_connection_is_closed() {
        let (server, _) = spawn_server("idle");
        let mut conn = send(
            &server,
            b"PUT /tasks.json HTTP/1.1\r\nHost: x\r\nIf-None-Match: *\r\nContent-Length: 25\r\n\r\n{\"tasks\":[],\"archive\":[]}",
        )
        .await;
        let res = response(&mut conn).await;
        assert!(res.starts_with("HTTP/1.1 204"), "{res}");
        let idle = tokio::time::Instant::now();
        closed(&mut conn).await;
        assert!(idle.elapsed() >= HEADER_TIMEOUT);
    }

    #[tokio::test(start_paused = true)]
    async fn connection_that_stops_reading_its_response_is_closed() {
        let (server, data) = spawn_server("stalled-reader");
        // far more than the pipe holds, so the response cannot be written out
        fs::write(&data, vec![b' '; 1024 * 1024]).unwrap();
        let mut conn = send(&server, b"GET /tasks.json HTTP/1.1\r\nHost: x\r\n\r\n").await;
        tokio::time::sleep(HEADER_TIMEOUT * 2).await;
        // reading would unstall the server: the dropped server end shows instead
        let err = conn.write_all(b"x").await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::BrokenPipe);
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

    #[tokio::test]
    async fn router_refuses_traversal_raw_or_percent_encoded() {
        let (app, data) = scratch_app("traversal");
        let dir = data.parent().unwrap();
        fs::create_dir_all(dir.join("web/assets")).unwrap();
        fs::write(dir.join("web/index.html"), "<!doctype html>").unwrap();
        fs::write(dir.join("secret.txt"), "private").unwrap();
        // the web dir is served, so the 404s below come from the traversal guard
        let res = call(&app, "GET", "/", Vec::new()).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()["content-type"], "text/html; charset=utf-8");
        // the path is never percent-decoded: encoded dots and slashes name no file
        for uri in [
            "/../secret.txt",
            "/assets/../../secret.txt",
            "/%2e%2e/secret.txt",
            "/assets/%2e%2e/%2e%2e/secret.txt",
            "/%2E%2E/secret.txt",
            "/..%2fsecret.txt",
            "/%2e%2e%2fsecret.txt",
            "/assets%2f..%2f..%2fsecret.txt",
        ] {
            let res = call(&app, "GET", uri, Vec::new()).await;
            assert_eq!(res.status(), StatusCode::NOT_FOUND, "{uri}");
            let body = to_bytes(res.into_body(), usize::MAX).await.unwrap();
            assert!(body.is_empty(), "{uri} leaked {body:?}");
        }
    }

    #[test]
    fn write_sheet_rejects_invalid_json_and_keeps_existing_sheet() {
        let dir = scratch("invalid");
        let data = dir.join("tasks.json");
        fs::write(&data, r#"{"tasks":[],"archive":[]}"#).unwrap();
        assert!(matches!(
            write_sheet(&data, b"not json{{"),
            Err(PutError::InvalidSheet)
        ));
        assert_eq!(
            fs::read_to_string(&data).unwrap(),
            r#"{"tasks":[],"archive":[]}"#
        );
    }

    #[test]
    fn write_sheet_rejects_json_that_is_not_a_sheet_and_keeps_existing_sheet() {
        let dir = scratch("not-a-sheet");
        let data = dir.join("tasks.json");
        let existing = r#"{"tasks":[{"id":"a"}],"archive":[]}"#;
        fs::write(&data, existing).unwrap();
        for bad in [
            "null",
            "[]",
            "42",
            "{}",
            r#"{"tasks":[]}"#,
            r#"{"archive":[]}"#,
            r#"{"tasks":{},"archive":[]}"#,
            r#"{"tasks":[],"archive":null}"#,
            r#"{"tasks":[],"archive":[],"savedAt":"yesterday"}"#,
            r#"{"tasks":[],"archive":[],"savedAt":null}"#,
        ] {
            assert!(
                matches!(
                    write_sheet(&data, bad.as_bytes()),
                    Err(PutError::InvalidSheet)
                ),
                "{bad} must be refused"
            );
            assert_eq!(fs::read_to_string(&data).unwrap(), existing);
        }
    }

    #[test]
    fn write_sheet_stores_sheets_with_unknown_fields_byte_for_byte() {
        let dir = scratch("loose");
        let data = dir.join("tasks.json");
        for good in [
            r#"{"tasks":[],"archive":[]}"#,
            r#"{"tasks":[{"id":"a","x":1}],"archive":[{"at":1,"tasks":[]}],"savedAt":1700000000000,"future":{"k":[1]}}"#,
        ] {
            write_sheet(&data, good.as_bytes()).unwrap();
            assert_eq!(fs::read_to_string(&data).unwrap(), good);
        }
    }

    #[test]
    fn write_sheet_replaces_file_and_leaves_no_temp_behind() {
        let dir = scratch("atomic");
        let data = dir.join("tasks.json");
        fs::write(&data, "{}").unwrap();
        let sheet = r#"{"tasks":[1],"archive":[]}"#;
        write_sheet(&data, sheet.as_bytes()).unwrap();
        assert_eq!(fs::read_to_string(&data).unwrap(), sheet);
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .filter(|n| n != "tasks.json")
            .collect();
        assert!(leftovers.is_empty(), "stray files: {leftovers:?}");
    }

    #[test]
    fn write_sheet_through_a_symlink_updates_the_target_and_keeps_the_link() {
        let dir = scratch("write-symlink");
        let target = dir.join("synced.json");
        fs::write(&target, br#"{"tasks":[]}"#).unwrap();
        let data = dir.join("tasks.json");
        std::os::unix::fs::symlink(&target, &data).unwrap();
        let sheet = r#"{"tasks":[],"archive":[],"savedAt":1}"#;
        write_sheet(&data, sheet.as_bytes()).unwrap();
        let link = fs::symlink_metadata(&data).unwrap();
        assert!(link.file_type().is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), sheet);
    }

    #[test]
    fn write_sheet_through_a_dangling_symlink_creates_the_target_and_keeps_the_link() {
        let dir = scratch("dangling-symlink");
        // the link exists before its target, e.g. before Syncthing delivers it
        let target = dir.join("synced.json");
        let data = dir.join("tasks.json");
        std::os::unix::fs::symlink(&target, &data).unwrap();
        let sheet = r#"{"tasks":[],"archive":[],"savedAt":1}"#;
        write_sheet(&data, sheet.as_bytes()).unwrap();
        let link = fs::symlink_metadata(&data).unwrap();
        assert!(link.file_type().is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), sheet);
    }

    #[test]
    fn write_sheet_keeps_the_existing_sheets_permissions() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = scratch("mode");
        let data = dir.join("tasks.json");
        fs::write(&data, EMPTY_SHEET).unwrap();
        fs::set_permissions(&data, fs::Permissions::from_mode(0o600)).unwrap();
        write_sheet(&data, EMPTY_SHEET).unwrap();
        let mode = fs::metadata(&data).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "mode became {mode:o}");
    }

    #[tokio::test]
    async fn sheet_responses_carry_the_marker_the_app_looks_for() {
        let (app, _) = scratch_app("marker");
        // no sheet yet: a marked 404 tells the app to create one
        let res = call(&app, "GET", "/tasks.json", Vec::new()).await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
        assert_eq!(res.headers()["x-eisenpaper"], "1");
        let sheet = br#"{"tasks":[],"archive":[]}"#;
        let res = put(&app, ("if-none-match", "*"), sheet).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert_eq!(res.headers()["x-eisenpaper"], "1");
        let created = tag_of(&res);
        let res = call(&app, "GET", "/tasks.json?t=1", Vec::new()).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.headers()["x-eisenpaper"], "1");
        assert_eq!(res.headers()["cache-control"], "no-store");
        assert_eq!(res.headers()["content-type"], "application/json");
        assert_eq!(
            tag_of(&res),
            created,
            "GET must name the sheet the PUT stored"
        );
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
        let req = Request::builder()
            .method("PUT")
            .uri("/tasks.json?x=1")
            .header("if-none-match", "*")
            .body(Body::from(EMPTY_SHEET))
            .unwrap();
        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        assert_eq!(fs::read(&data).unwrap(), EMPTY_SHEET);
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
    async fn put_without_a_precondition_is_refused_with_428() {
        let (app, data) = scratch_app("blind");
        let res = call(&app, "PUT", "/tasks.json", version(1)).await;
        assert_eq!(res.status(), StatusCode::PRECONDITION_REQUIRED);
        assert_eq!(res.headers()["x-eisenpaper"], "1");
        assert!(!data.exists());
        fs::write(&data, version(1)).unwrap();
        let res = call(&app, "PUT", "/tasks.json", version(2)).await;
        assert_eq!(res.status(), StatusCode::PRECONDITION_REQUIRED);
        assert_eq!(fs::read(&data).unwrap(), version(1));
    }

    #[tokio::test]
    async fn put_over_a_sheet_it_never_saw_is_refused_with_the_current_etag() {
        let (app, data) = scratch_app("stale");
        let res = put(&app, ("if-none-match", "*"), &version(1)).await;
        let first = tag_of(&res);
        // a second device saves over the first version
        let res = put(&app, ("if-match", &first), &version(2)).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        let second = tag_of(&res);
        assert_ne!(second, first);
        // the first device, still holding `first`, must not overwrite it
        let res = put(&app, ("if-match", &first), &version(3)).await;
        assert_eq!(res.status(), StatusCode::PRECONDITION_FAILED);
        assert_eq!(res.headers()["x-eisenpaper"], "1");
        assert_eq!(tag_of(&res), second);
        // nor may anyone create a sheet that already exists
        let res = put(&app, ("if-none-match", "*"), &version(3)).await;
        assert_eq!(res.status(), StatusCode::PRECONDITION_FAILED);
        assert_eq!(fs::read(&data).unwrap(), version(2));
        // a weak tag never matches, even when its opaque part does
        let weak = format!("W/{second}");
        let res = put(&app, ("if-match", &weak), &version(3)).await;
        assert_eq!(res.status(), StatusCode::PRECONDITION_FAILED);
        // any tag in a list may match
        let list = format!("{first}, {second}");
        let res = put(&app, ("if-match", &list), &version(3)).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn a_sheet_rewritten_on_disk_invalidates_its_old_etag() {
        let (app, data) = scratch_app("synced-file");
        fs::write(&data, version(1)).unwrap();
        let seen = tag_of(&call(&app, "GET", "/tasks.json", Vec::new()).await);
        // Syncthing (or an editor) replaces the file behind the server's back
        fs::write(&data, version(9)).unwrap();
        let res = put(&app, ("if-match", &seen), &version(2)).await;
        assert_eq!(res.status(), StatusCode::PRECONDITION_FAILED);
        assert_eq!(fs::read(&data).unwrap(), version(9));
    }

    #[tokio::test]
    async fn if_match_star_needs_an_existing_sheet() {
        let (app, data) = scratch_app("star");
        let res = put(&app, ("if-match", "*"), &version(1)).await;
        assert_eq!(res.status(), StatusCode::PRECONDITION_FAILED);
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
        // a sheet of exactly the limit, far above axum's 2 MiB default
        let head = br#"{"tasks":[],"archive":[],"pad":""#;
        let mut sheet = vec![b'x'; MAX_SHEET_BYTES];
        sheet[..head.len()].copy_from_slice(head);
        sheet[MAX_SHEET_BYTES - 2..].copy_from_slice(br#""}"#);
        let res = put(&app, ("if-none-match", "*"), &sheet).await;
        assert_eq!(res.status(), StatusCode::NO_CONTENT);
        sheet.insert(head.len(), b'x');
        let res = put(&app, ("if-match", "*"), &sheet).await;
        assert_eq!(res.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(res.headers()["x-eisenpaper"], "1");
        assert_eq!(fs::read(&data).unwrap().len(), MAX_SHEET_BYTES);
    }

    #[tokio::test]
    async fn put_of_invalid_json_is_a_marked_400_and_keeps_the_sheet() {
        let (app, data) = scratch_app("put-invalid");
        fs::write(&data, r#"{"tasks":[]}"#).unwrap();
        let res = put(&app, ("if-match", "*"), b"not json{{").await;
        assert_eq!(res.status(), StatusCode::BAD_REQUEST);
        assert_eq!(res.headers()["x-eisenpaper"], "1");
        assert_eq!(fs::read_to_string(&data).unwrap(), r#"{"tasks":[]}"#);
    }

    #[tokio::test]
    async fn put_whose_rename_fails_is_a_marked_500_and_leaves_no_temp_behind() {
        let (app, data) = scratch_app("put-rename");
        // the temp file can be written, but renaming a file onto a directory fails
        fs::create_dir_all(&data).unwrap();
        // a stray temp file would be synced next to the real sheet
        let tmp = data.with_file_name(".tasks.json.tmp");
        assert!(matches!(
            write_sheet(&data, EMPTY_SHEET),
            Err(PutError::Io(_))
        ));
        assert!(!tmp.exists(), "{} left behind", tmp.display());
        // over HTTP, reading the directory for its ETag already fails
        let res = put(&app, ("if-match", "*"), EMPTY_SHEET).await;
        assert_eq!(res.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(res.headers()["x-eisenpaper"], "1");
        assert!(data.is_dir());
        assert!(!tmp.exists(), "{} left behind", tmp.display());
    }

    #[test]
    fn write_sheet_reports_unwritable_paths_as_io_errors() {
        // no file name to derive the temp name from: refused before any write
        assert!(matches!(
            write_sheet(Path::new("/"), EMPTY_SHEET),
            Err(PutError::Io(_))
        ));
        // the temp file itself cannot be created
        let data = scratch("missing-dir").join("gone").join("tasks.json");
        assert!(matches!(
            write_sheet(&data, EMPTY_SHEET),
            Err(PutError::Io(_))
        ));
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

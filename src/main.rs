//! eisenpaper server: serves the built web app and owns the sheet file.
//!
//! `GET /tasks.json` returns the sheet, `PUT /tasks.json` replaces it
//! atomically. Every other `GET` is a file from the web directory.

use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use tiny_http::{Header, Method, Request, Response, ResponseBox, Server};

/// Marker header: tells the app this origin accepts `PUT /tasks.json`.
const MARKER: (&str, &str) = ("X-Eisenpaper", "1");
/// Upper bound for an uploaded sheet; far above any real one.
const MAX_SHEET_BYTES: u64 = 16 * 1024 * 1024;

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

/// Builds a header from static ASCII parts.
fn header(name: &str, value: &str) -> Header {
    #[expect(
        clippy::expect_used,
        reason = "only called with static ASCII names and values, which always parse"
    )]
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid static header")
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
fn serve_static(web: &Path, url_path: &str) -> ResponseBox {
    let Some(path) = resolve_static(web, url_path) else {
        return Response::empty(404).boxed();
    };
    let inside = match (path.canonicalize(), web.canonicalize()) {
        (Ok(file), Ok(root)) => file.starts_with(root),
        _ => false,
    };
    if !inside {
        return Response::empty(404).boxed();
    }
    let Ok(data) = fs::read(&path) else {
        return Response::empty(404).boxed();
    };
    // Vite fingerprints everything under /assets/, so it can be cached forever
    let cache = if url_path.starts_with("/assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    Response::from_data(data)
        .with_header(header("Content-Type", content_type(&path)))
        .with_header(header("Cache-Control", cache))
        .boxed()
}

/// `GET /tasks.json`: the sheet, or a marked 404 so the app knows it may PUT.
fn get_sheet(data: &Path) -> ResponseBox {
    let marker = header(MARKER.0, MARKER.1);
    match fs::read(data) {
        Ok(bytes) => Response::from_data(bytes)
            .with_header(marker)
            .with_header(header("Content-Type", "application/json"))
            .with_header(header("Cache-Control", "no-store"))
            .boxed(),
        Err(_) => Response::empty(404).with_header(marker).boxed(),
    }
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

/// `PUT /tasks.json`: reads a bounded body and stores it.
fn put_sheet(data: &Path, req: &mut Request) -> ResponseBox {
    let mut body = Vec::new();
    let read = req
        .as_reader()
        .take(MAX_SHEET_BYTES + 1)
        .read_to_end(&mut body);
    let status = match read {
        Err(_) => 400,
        Ok(n) if u64::try_from(n).map_or(true, |n| n > MAX_SHEET_BYTES) => 413,
        Ok(_) => match write_sheet(data, &body) {
            Ok(()) => 204,
            Err(PutError::InvalidJson) => 400,
            Err(PutError::Io(e)) => {
                eprintln!("writing {} failed: {e}", data.display());
                500
            }
        },
    };
    Response::empty(status)
        .with_header(header(MARKER.0, MARKER.1))
        .boxed()
}

/// Routes one request.
fn handle(cfg: &Config, mut req: Request) {
    let path = req.url().split('?').next().unwrap_or("/").to_owned();
    let response = match (req.method(), path.as_str()) {
        (Method::Get, "/tasks.json") => get_sheet(&cfg.data),
        (Method::Put, "/tasks.json") => put_sheet(&cfg.data, &mut req),
        (Method::Get, _) => serve_static(&cfg.web, &path),
        _ => Response::empty(405).boxed(),
    };
    if let Err(e) = req.respond(response) {
        eprintln!("response failed: {e}");
    }
}

fn main() -> ExitCode {
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
    let server = match Server::http((cfg.host.as_str(), cfg.port)) {
        Ok(server) => server,
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
    for req in server.incoming_requests() {
        handle(&cfg, req);
    }
    ExitCode::SUCCESS
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(serve_static(&web, "/leak.txt").status_code().0, 404);
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

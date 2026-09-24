//! eisenpaper server: serves the app and owns tasks.json (GET/PUT).
//!
//! run:            eisenpaper                     → http://localhost:8741
//! phone on LAN:   eisenpaper --host 0.0.0.0
//! from anywhere:  eisenpaper --dir /path/to/eisenpaper

use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::process::exit;

use tiny_http::{Header, Method, Request, Response, Server};

const MARKER: (&str, &str) = ("X-Eisenpaper", "1");

struct Cfg {
    host: String,
    port: u16,
    dir: PathBuf,
}

fn parse_args() -> Cfg {
    let mut cfg = Cfg {
        host: "127.0.0.1".into(),
        port: 8741,
        dir: std::env::current_dir().expect("no working directory"),
    };
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        let mut val = |name: &str| {
            args.next().unwrap_or_else(|| {
                eprintln!("{name} needs a value");
                exit(2);
            })
        };
        match a.as_str() {
            "--host" => cfg.host = val("--host"),
            "--port" => {
                cfg.port = val("--port").parse().unwrap_or_else(|_| {
                    eprintln!("--port needs a number");
                    exit(2);
                })
            }
            "--dir" => cfg.dir = PathBuf::from(val("--dir")),
            "-h" | "--help" => {
                println!("usage: eisenpaper [--host H] [--port P] [--dir D]");
                println!("  --host  bind address, 0.0.0.0 for the LAN/phone (default 127.0.0.1)");
                println!("  --port  port (default 8741)");
                println!("  --dir   project folder holding index.html and tasks.json (default: cwd)");
                exit(0);
            }
            other => {
                eprintln!("unknown argument: {other}");
                exit(2);
            }
        }
    }
    cfg
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("static header")
}

fn with_marker<R: Read>(resp: Response<R>) -> Response<R> {
    resp.with_header(header(MARKER.0, MARKER.1))
}

fn empty(status: u32) -> Response<std::io::Empty> {
    Response::empty(status)
}

/// GET /tasks.json — the sheet, or a marked 404 so the app knows PUT works here.
fn get_tasks(dir: &PathBuf) -> Response<std::io::Cursor<Vec<u8>>> {
    match fs::read(dir.join("tasks.json")) {
        Ok(data) => with_marker(
            Response::from_data(data)
                .with_header(header("Content-Type", "application/json"))
                .with_header(header("Cache-Control", "no-store")),
        ),
        Err(_) => with_marker(Response::from_data(Vec::new()).with_status_code(404)),
    }
}

/// PUT /tasks.json — validate, then write atomically (tmp + rename), so a
/// crash or a concurrent reader (Syncthing) never sees a half-written sheet.
fn put_tasks(dir: &PathBuf, req: &mut Request) -> u32 {
    let mut body = Vec::with_capacity(req.body_length().unwrap_or(0));
    if req.as_reader().read_to_end(&mut body).is_err() {
        return 400;
    }
    // never let a broken payload clobber the sheet
    if serde_json::from_slice::<serde_json::Value>(&body).is_err() {
        return 400;
    }
    let tmp = dir.join(".tasks.json.tmp");
    if fs::write(&tmp, &body).is_err() {
        return 500;
    }
    match fs::rename(&tmp, dir.join("tasks.json")) {
        Ok(()) => 204,
        Err(_) => {
            let _ = fs::remove_file(&tmp);
            500
        }
    }
}

fn handle(dir: &PathBuf, mut req: Request) {
    let path = req.url().split('?').next().unwrap_or("/").to_string();
    let result = match (req.method(), path.as_str()) {
        (Method::Get, "/tasks.json") => req.respond(get_tasks(dir)),
        (Method::Put, "/tasks.json") => {
            let status = put_tasks(dir, &mut req);
            req.respond(with_marker(empty(status)))
        }
        // the app is a single file — serve exactly that, nothing else
        // (no directory walking, so Cargo.toml/src/target stay private)
        (Method::Get, "/" | "/index.html") => match fs::read(dir.join("index.html")) {
            Ok(data) => req.respond(
                Response::from_data(data)
                    .with_header(header("Content-Type", "text/html; charset=utf-8")),
            ),
            Err(_) => req.respond(empty(404)),
        },
        (Method::Get, _) => req.respond(empty(404)),
        _ => req.respond(empty(405)),
    };
    if let Err(e) = result {
        eprintln!("response failed: {e}");
    }
}

fn main() {
    let cfg = parse_args();
    if !cfg.dir.join("index.html").is_file() {
        eprintln!(
            "no index.html in {} — run from the eisenpaper folder or pass --dir",
            cfg.dir.display()
        );
        exit(1);
    }
    let server = Server::http((cfg.host.as_str(), cfg.port)).unwrap_or_else(|e| {
        eprintln!("cannot bind {}:{}: {e}", cfg.host, cfg.port);
        exit(1);
    });
    let shown = if cfg.host == "127.0.0.1" { "localhost" } else { &cfg.host };
    println!("eisenpaper → http://{}:{}", shown, cfg.port);
    for req in server.incoming_requests() {
        handle(&cfg.dir, req);
    }
}

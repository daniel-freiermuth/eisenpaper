<p align="center">
  <img src="web/public/logo.svg" alt="" width="128" height="128" />
</p>

<h1 align="center">eisenpaper</h1>

<p align="center">
  An Eisenhower matrix that feels like a sheet of paper on your desk —
  jot tasks anywhere, drag them by urgency and importance, cross them out,
  and plan your week.
</p>

---

eisenpaper is a small self-hosted task sheet. A tiny Rust server owns one
JSON file (`tasks.json`); the web app runs in any browser, on the desktop or
on your phone over the LAN, and keeps working offline.

## Features

- **Priorities** — the classic urgent × important matrix. Double-click
  anywhere to jot a task where it belongs; drag it as priorities change.
- **Schedule** — a week view next to a backlog sorted most urgent and
  important first. Drag tasks onto days, reorder them within a day; overdue
  tasks are collected at the top of the backlog.
- **Task details** — click a task to open a side pane: assign a project,
  schedule it (today, tomorrow, next week, any date, or back to the
  backlog), and keep free-text notes.
- **Projects with colours** — manage projects in _settings_. Pick one of
  eight default inks, any colour with its own opacity, or none. Text on a
  tinted task always stays readable (WCAG AA, 4.5:1): dark or light text is
  chosen per colour, and the selected task stands out without losing
  contrast.
- **Fresh sheet** — the paper ritual: crossed-out tasks move to a dated
  archive (_old sheets_), open ones carry over.
- **Offline first** — the browser keeps a copy and syncs when the server is
  reachable again. Export and import the whole sheet as JSON.

## Using it

### Priorities

| Action              | Mouse / touch                           | Keyboard |
| ------------------- | --------------------------------------- | -------- |
| new task            | double-click empty paper                |          |
| open details        | click the task                          |          |
| cross out / uncross | hover (or select) the task, click **✓** | `Space`  |
| edit the text       | double-click the task                   | `Enter`  |
| reprioritize        | drag                                    |          |
| tear off (delete)   | right-click                             | `Delete` |
| close details       | click empty paper                       | `Esc`    |

### Schedule

| Action              | Mouse                                           | Touch                 | Keyboard |
| ------------------- | ----------------------------------------------- | --------------------- | -------- |
| open details        | click                                           | tap                   | `Enter`  |
| cross out           | hover, click **✓**                              | tap, then **✓**       | `Space`  |
| schedule / reorder  | drag onto a day                                 | long-press, then drag |          |
| back to the backlog | drag onto the backlog, or **×** when overdue    | same                  |          |
| turn the page       | **‹ ›** **« »**, or hold a dragged task on them | same                  |          |

## Running

You need [Rust](https://rustup.rs) 1.85+, [Node.js](https://nodejs.org)
24+, [pnpm](https://pnpm.io) (`corepack enable` picks the pinned version)
and [just](https://just.systems).

```sh
just          # build everything and serve at http://localhost:8741
just lan      # same, reachable from your phone on the LAN
```

The sheet lives in `tasks.json` next to the checkout. To keep eisenpaper
running in the background as a systemd user service:

```sh
just install-service
```

For phone access, append `--host 0.0.0.0` to `ExecStart` in
`~/.config/systemd/user/eisenpaper.service`.

### Server options

```text
usage: eisenpaper [--host H] [--port P] [--web DIR] [--data FILE]
  --host  bind address, 0.0.0.0 for the LAN/phone (default 127.0.0.1)
  --port  port (default 8741)
  --web   built web app directory (default web/dist)
  --data  sheet file (default tasks.json)
```

## How syncing works

- The server's `tasks.json` is the source of truth. `GET /tasks.json` reads
  it and returns its `ETag`; `PUT /tasks.json` replaces it atomically
  (fsynced temp file + rename), so a crash, a power loss or a file syncer
  such as Syncthing never sees half a sheet. If `tasks.json` is a symlink —
  say into a Syncthing folder — the file it points at is updated (or
  created, if it does not exist yet) and the link kept. Uploads that are not
  a sheet are refused; the stored body is otherwise kept byte for byte.
- A `PUT` must name the version it replaces: `If-Match` with the current
  sheet's `ETag`, or `If-None-Match: *` to create a sheet where there is
  none. A stale tag is refused with `412 Precondition Failed`, a `PUT` with
  neither header with `428 Precondition Required`. To restore a backup over
  whatever sheet is there, send `If-Match: *` (`If-None-Match: *` if there
  is none yet):
  `curl -X PUT -H 'If-Match: *' --data-binary @backup.json http://localhost:8741/tasks.json`.
- Every change is cached in the browser right away and written to the
  server shortly after. If the server is unreachable, the toolbar shows
  _offline_ and the edits are pushed once it is back.
- On sync, the browser's sheet and the server's are merged against the
  server version the browser last saw: tasks and projects by `id`, archive
  entries by `at`, field by field. A change made on only one side is kept;
  when both changed the same field, the browser's value wins. An item one
  side deleted stays deleted unless the other side changed it. A device
  that has never seen the server adds its tasks to the server's sheet. A
  save refused with `412` because another device saved first is merged
  with that save and retried.

## The sheet format

`tasks.json` is plain, readable JSON:

```json
{
  "tasks": [
    {
      "id": "muf3qxfa7we1l",
      "text": "file tax return",
      "x": 0.8,
      "y": 0.09,
      "done": false,
      "created": 1790228368054,
      "day": "2026-10-21",
      "order": 0,
      "project": "mvggxqlqt06i6w12d6ke7",
      "note": "receipts are in the blue folder"
    }
  ],
  "archive": [{ "at": 1790228357000, "tasks": [] }],
  "projects": [
    { "id": "mvggxqlqt06i6w12d6ke7", "name": "admin", "color": "#2f5d9e" }
  ]
}
```

`x` runs from not urgent (0) to urgent (1), `y` from important (0) to not
important (1). `day`, `order`, `project`, `note` and `color` are optional.
Unknown fields are kept, so an older tab never strips data a newer one
wrote.

## Development

```sh
just dev      # hot-reloading UI on :5173, backend on :8742 using dev-tasks.json
just check    # everything CI runs: rustfmt, clippy, tests, cargo-deny,
              # prettier, eslint, svelte-check, vitest, build
just fmt      # format Rust and web code
just fix      # apply automatic lint fixes, then format
```

`just dev` never touches your real `tasks.json`.

| Path                          | What                                                         |
| ----------------------------- | ------------------------------------------------------------ |
| `src/main.rs`                 | the server: static files plus `GET`/`PUT /tasks.json`        |
| `web/src/lib/`                | the Svelte 5 app; its core lives in four modules:            |
| `web/src/lib/model.ts`        | sheet schema (valibot), parsing, archive ritual              |
| `web/src/lib/sheet.svelte.ts` | the store: every change, sync with the server, offline cache |
| `web/src/lib/schedule.ts`     | days, backlog order, overdue, placing tasks on days          |
| `web/src/lib/tint.ts`         | project colours → readable text and selection colours        |

## License

eisenpaper is free to use and share under the
[Parity Public License 7.0.0](LICENSE.md), commercially or not. In return,
software you develop, operate or analyze with it — including changes to
eisenpaper itself — must be published as open source too.

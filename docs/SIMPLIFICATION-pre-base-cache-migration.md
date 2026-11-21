# RFC: delete the migration for caches written before the merge base was kept

Status: needs a decision from the owner. No code has changed.

## The question

**Does any browser still hold one of the two localStorage states below?**
The migration exists for them. Deleting it changes what happens to them,
and nothing else.

1. **An untouched old cache.** `eisenpaper.v1` is present, and neither
   `eisenpaper.v1.base` nor `eisenpaper.v1.unsynced` is. Only the app as it
   was before 5743bf0 (2026-10-18) writes this state. The current app keeps
   it as it is until a sync reaches the server. Every early return in
   `#pull` skips `#persist` and leaves storage untouched:
   - the fetch throws (sheet.svelte.ts:289-291)
   - the reply does not come from eisenpaper (293-296)
   - an HTTP error (297-300)
   - the body drops (304-306)
   - an invalid tasks.json (332-337)

   So a browser that opened the app since 2026-10-18 can still hold this
   state if its first sync failed and nothing was edited.
2. **An old cache that the current app stored as the base, unconfirmed.**
   `eisenpaper.v1.base` and `eisenpaper.v1.legacy` are present, and
   `eisenpaper.v1.unsynced` is not. The *current* app writes this state:
   - A browser in state 1 opens the app.
   - The first sync fails: offline, an HTTP error, or an invalid tasks.json.
   - An edit is made before any sync succeeds.
   - `#persist` then caches the old sheet as `BASE_KEY` and sets
     `LEGACY_KEY` (sheet.svelte.ts:181-183).
   - The state lasts until a sync reaches the server.

**Opening the app since 2026-10-18 rules out neither state.** Only the
per-browser storage check under "Mitigation" does.

Any other state behaves the same before and after the deletion:

- no `eisenpaper.v1`
- `eisenpaper.v1.unsynced` present
- `eisenpaper.v1.base` present without `eisenpaper.v1.legacy`

The decision:

- **No browser holds state 1 or 2**: delete the migration as described
  below. "Mitigation" says how to check each browser and how to clear the
  states first.
- **One might, and the owner won't check**: keep the migration as it is.

## What exists and why

5743bf0 (2026-10-18, "conditional saves and per-task three-way merge")
replaced last-writer-wins on `savedAt` with a three-way merge against a base
cached in `eisenpaper.v1.base` (`BASE_KEY`). A cache written by the earlier
app has no base, so its first merge ran against an empty sheet: its stale
fields beat other devices' edits and tasks deleted elsewhere came back.

Four fixes followed, all for that one state:

| commit | date | what it added |
|---|---|---|
| 8aebbf6 | 2026-10-22 | `legacyCache()`: a cache with `savedAt > 0` and no base is its own base, unless its `savedAt` is newer than tasks.json's, in which case merge against empty so failed saves survive |
| 48467de | 2026-10-24 | `UNSYNCED_KEY` again, written by the *current* app whenever it caches without a base, so an imported backup carrying an old `savedAt` is not taken for a legacy cache |
| c05a04b | 2026-11-09 | stop trusting the legacy cache once tasks.json matched it (`#legacyCache = null` in `#write` and `#pull`) |
| c1eeb21 | 2026-11-16 | `LEGACY_KEY`, so an offline edit that stores the legacy cache as `BASE_KEY` stays flagged across reloads |

All in `web/src/lib/sheet.svelte.ts` (line numbers at 0c13622):

- `UNSYNCED_KEY` and its doc, 25-32; `LEGACY_KEY` and its doc, 33-39
- `savedAt()`, 86-89; `legacyCache()`, 91-106
- `#legacyCache` field, 134-138, and its use in `#lastServerText`, 140-146
- `#persist`: the `UNSYNCED_KEY` write, 174-177, and the `LEGACY_KEY`
  set/clear, 181-186
- `#write`: clearing `#legacyCache` on a matching PUT, 259-261
- `#pull`: clear-and-persist when unchanged, 323-327; the `savedAt`
  comparison that swaps the base for an empty sheet, 346-356; the clear
  after a merge, 359-360

## Who uses it today (re-verified)

The migration only acts on a cache the pre-2026-10-18 app wrote.

- `legacyCache()` returns non-null in two cases. One is `CACHE_KEY` present,
  no `BASE_KEY`, no `UNSYNCED_KEY`, with `savedAt > 0`
  (sheet.svelte.ts:100-105). The other is `BASE_KEY` plus `LEGACY_KEY`
  (102), and only the migration writes `LEGACY_KEY` (181-183).
- The current app never sets `savedAt`. A search for
  `savedAt|saved_at` finds:
  - the schema, `web/src/lib/model.ts:152`
  - the reader, `sheet.svelte.ts:86-88`
  - the server's shape check, `src/main.rs:332`
  - tests in `model.test.ts`, `sheet.svelte.test.ts` and `src/main.rs`
- The old app did set it. `git show 5743bf0^:web/src/lib/sheet.svelte.ts`
  has `this.sheet.savedAt = Date.now()` on every commit (line 65) and
  `UNSYNCED_KEY` (line 18).
- No service worker can keep serving the old bundle. There is no service
  worker or workbox anywhere in the repo. `src/main.rs:192-196` serves
  everything outside `/assets/` with `no-cache`. So any browser that opens
  the app runs the current code. That alone does not take it out of the
  legacy states:
  - **Opened, no edit, first sync failed:** nothing is persisted, so the
    cache stays in state 1.
  - **Opened, an edit made before any sync succeeded:** the cache moves to
    state 2, `BASE_KEY` + `LEGACY_KEY` (sheet.svelte.ts:146, 181-183).
    `legacyCache()` keeps returning that base on every reload (102).
  - **A sync that reaches the server:** `LEGACY_KEY` is cleared, and the
    browser leaves both states. That is a GET of tasks.json that gets
    merged or matches, or an accepted PUT. Code: the `#legacyCache = null`
    clears in `#write`/`#pull` (261, 325, 360), then the `else` branch of
    `#persist` (184-186). A 404 sets `UNSYNCED_KEY` (177), and that turns
    `legacyCache()` off on its own (100).
- Neither `README.md` nor anything else in the repo documents these keys.
  Nothing else reads `eisenpaper.v1.*`. `App.svelte` only uses its own pane
  key.

The remaining users are browsers in state 1 or state 2. Either one needs a
browser whose cache predates 2026-10-18 and which has not had a sync reach
the server since. That browser may never have opened the current app, or
it may have opened it while the first sync failed. With no edit, it stays
in state 1. With an edit, it moves to state 2.
The repo cannot say whether either exists. Only the owner of this
single-user, self-hosted app can, by checking each browser (see
"Mitigation").

## The simpler design

One rule: the base is `BASE_KEY`, or there is none. A sheet with no base
merges against an empty sheet. That is 5743bf0's original contract, and the
`mergeSheets` doc still states it (model.ts:239-241: "empty if it never saw
one").

- `#lastServerText` starts as
  `this.#cache === null ? null : cacheGet(BASE_KEY)`.
- `#persist` becomes: base null → `cacheRemove(BASE_KEY)`. Otherwise, if
  `!cacheSet(BASE_KEY, …)`, remove both keys.
- `#pull` merges against
  `(base === null ? null : parseSheet(base)) ?? emptySheet()`, with no
  `savedAt` comparison.
- The `#legacyCache` clears in `#write` and `#pull` go away.

This adds no new helper, key or type.

## What would be deleted (estimate, production code only)

I applied the design above to `sheet.svelte.ts` as an experiment and then
reverted it. The diff was:

- `web/src/lib/sheet.svelte.ts`: 73 lines removed, 3 added. Of the removed
  lines, 34 are code; the rest are doc comments for the removed keys and
  functions.
- `web/src/lib/model.ts:148-151`: the `savedAt` doc comment would be
  reworded. It says the field is "still read to recognise its cache", and
  that would no longer be true. The field itself stays.

Concepts that would no longer exist:

- 2 localStorage keys: `eisenpaper.v1.unsynced`, `eisenpaper.v1.legacy`
- 1 private field: `#legacyCache`
- 2 module functions: `savedAt()`, `legacyCache()`
- the `savedAt` comparison that swaps the merge base
- 5 branches in the store's methods: 2 in `#persist`, 1 in `#write`, 2 in
  `#pull`. The 3 inside `legacyCache()` go with that function.

Tests, counted separately (`web/src/lib/sheet.svelte.test.ts`): delete the
8 tests at 554, 575, 599, 628, 661, 696, 725 and 743, about 225 lines. Each
one builds a localStorage state that only the pre-5743bf0 app writes: a
`savedAt`-stamped `CACHE_KEY` with no base, or a hand-set
`eisenpaper.v1.unsynced`.

The proposal also listed 779 ("keeps a backup imported before the first
sync across a reload") for deletion. **Keep it.** It drives a path the
current app can still take, `store.replace` with a backup that carries a
`savedAt`, then a reload. In the experiment it passes unchanged. Only its
comment, which mentions the app before the base, would be reworded.

## What breaks, and for whom

With the experimental change, `pnpm -C web exec vitest run
src/lib/sheet.svelte.test.ts` gave **1 failed, 74 passed**. The failure is
554, "takes another device's edits over a cache from before the base was
kept":

```
-       "text": "file tax return by May",
+       "text": "file tax return",
+     },
+     {
+       "id": "t2",
+       "text": "call the plumber",
```

This is exactly the 8aebbf6 bug coming back. On such a device's first sync:

- a rename made on another device is reverted to the stale cached text
- a task that another device archived reappears on the sheet

The other legacy tests (575, 599, 628, 661, 696, 725, 743) still passed.
**That does not mean failed saves survive.** In each of them, every phase
runs on the module under test. So with the experimental module, the
offline phase of 599 never wrote `LEGACY_KEY`, and state 2 was never
exercised.

State 2 needs the browsers in the field, which already hold it, to reload
onto the new code. I reproduced that with a throwaway test, since deleted:

- Phase 1 ran on the current `sheet.svelte.ts`. A state-1 cache
  `{t1 done:true, savedAt:200}` was opened offline and a note set on t1.
- Phase 2 reloaded online against tasks.json `{t1 done:false, savedAt:100}`.
- After phase 1, storage held
  `[eisenpaper.v1, eisenpaper.v1.base, eisenpaper.v1.legacy]`.

| phase 2 runs on | t1 in tasks.json after the sync | `eisenpaper.v1.legacy` after |
|---|---|---|
| current code | `done:true, note:"hello"` | removed |
| RFC design | `done:false, note:"hello"` | still there, unread |

So the deletion has two losses, one per state.

- **State 1** (test 554): the first sync takes the stale cache over other
  devices' changes. A rename made elsewhere is reverted, and a task
  archived elsewhere comes back.
- **State 2** (the reproduction above): the old app's failed saves are
  reverted to tasks.json's values. Base and local both hold the unsaved
  value, so the merge reads it as unchanged locally and takes the
  server's. Here, a task crossed out offline comes back undone. Edits made
  on the new app since are kept.

Browsers in neither state are unaffected. There is no `savedAt` to compare
and no `LEGACY_KEY` that matters, so the old and new code take the same
base. That covers no cache, `eisenpaper.v1.unsynced` set, or a base
without `eisenpaper.v1.legacy`.

## Things left alone on purpose

- `SheetSchema.savedAt` (model.ts:152) and `SheetShape.saved_at`
  (src/main.rs:332). tasks.json files and exported backups may still carry
  a `savedAt`, and both sides must keep refusing a non-numeric one
  (model.test.ts:101-112; src/main.rs:1271-1273).
- Orphan `eisenpaper.v1.unsynced` keys would stay in browsers, unread and
  harmless. A leftover `eisenpaper.v1.legacy` is **not** harmless: it
  marks state 2. It must be cleared by a sync before the deletion ships
  (see below), not left as an orphan.

## Mitigation, and the check behind the owner's answer

Just opening the app is not enough. The status badge is no proof either.
The reproduction above also showed that an edit undone while offline sets
the status to "synced" without contacting the server (`#write` returns
"synced" when the sheet equals `#lastServerText`, sheet.svelte.ts:206-213).
`eisenpaper.v1.legacy` stays set when that happens.

On every browser profile that has used eisenpaper:

1. Open the app while the server is reachable, and let the first sync
   finish before editing anything.
2. In DevTools → Application → Local Storage, check that neither state
   remains:
   - no `eisenpaper.v1.legacy` unless `eisenpaper.v1.unsynced` is also
     present, and
   - if `eisenpaper.v1` is present, then `eisenpaper.v1.base` or
     `eisenpaper.v1.unsynced` is too.

A sync that reaches the server leaves every browser passing this check. If
any browser cannot be checked, the answer is "keep the migration".

Handling a leftover `LEGACY_KEY` in code instead is no cheaper. A guard
that drops a flagged base at load would keep the failed saves, but it
would bring back the state-1 loss for that browser. It would also keep
reading both keys, so most of the concepts this RFC removes would stay.
Keeping the migration is the only lossless choice without the check.

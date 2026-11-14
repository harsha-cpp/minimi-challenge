# UI preview copy

Preview: http://localhost:3001
Original app: http://localhost:3000

This directory contains a source copy, its own SQLite database and its own server/clock. The original source, credentials, database and running server are untouched. Installed dependencies are copied too; installs or edits in this preview cannot change the main app’s dependencies.

UI changes: clear selected-era controls, date-aware starter questions, progressive research status, collapsible details, saved-passage source inspector, Copy/Edit/Retry/Re-check actions, searchable Ledger with conversation reopening, refresh recovery, mobile layout and keyboard/focus handling. The hero overline and its red dot have been removed as requested. The edition panel drops the “Your viewpoint” label, the live-mode note, the top rule, and the extra date link; use the masthead stamp to change the clock. The stamp sits flat, without the old slant. Scrollable areas use a thin orange custom scrollbar. Press **⌘E** (macOS) or **Ctrl+E** (other platforms) to focus the composer; the hint sits inside the field. Live mode hides the composer date strip (stamp only). Type and spacing are slightly larger for a cleaner layout.

Only the copy's server gained a read-only session-history endpoint for reopening saved conversations. Search/model/simulation logic remains identical to the main app.

From this directory, start with:

```sh
PORT=3001 DB_PATH=data/asof.db npm run dev
```

No merge or change to the main branch has been made. The review patch is saved at `.context/ui-changes.patch` in this copy.

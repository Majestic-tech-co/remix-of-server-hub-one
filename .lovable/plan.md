# Option A — Connection notes per server

Add a free-text `connection_notes` field on each server so you can paste your one-time `ssh -i key.pem ubuntu@host` command (or any other login reminder) for reference. Nothing sensitive is executed — this is a notes field, not a credential store.

## Database

One migration:
- `ALTER TABLE servers ADD COLUMN connection_notes text`
- No RLS changes — existing owner-only policies already cover it.

## UI

**Server detail page** (`src/routes/servers.$id.tsx`)
- New **Info** tab alongside Charts / Commands
- Shows: hostname, IP, OS, type, region, instance_id, tags, and a **Connection notes** section
- Notes are **masked by default** (shows "•••••• Click to reveal") with a Reveal/Hide toggle
- Edit button opens a dialog with a `<Textarea>` (monospace) and Save/Cancel
- Placeholder text suggests: `ssh -i ~/.ssh/my-key.pem ubuntu@1.2.3.4`
- One-click **Copy** button on the revealed notes

**Add-server dialog** (`src/routes/index.tsx`)
- Add an optional "Connection notes" textarea at the bottom, collapsed under a "Show advanced" toggle so it doesn't clutter the common case

## Security notes shown in the UI

Small helper text under the notes field: *"Stored as plain text in your private database. Don't paste private key contents here — only the login command."* Keeps expectations clear.

## Files touched

- Migration (schema only)
- `src/routes/servers.$id.tsx` — add Info tab + notes UI
- `src/routes/index.tsx` — add optional notes field to AddServerDialog
- `src/integrations/supabase/types.ts` — regenerated after migration

## Non-goals

- No encryption at rest beyond what the DB already provides (it's a notes field, not a secret store)
- No private key upload, no SSH relay, no browser-based SSH

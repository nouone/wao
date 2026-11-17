# Personal configuration defaults

Snapshot of the owner's live Wao configuration, kept in git so a fresh
install or rebuilt machine can be restored to the working setup.
Refresh manually when the live config changes (see below).

| File | What it is | Where it lives at runtime |
| --- | --- | --- |
| `soul.md` | The agent Soul (persona, worldview, verification + analysis rules, boundaries) shown under Settings → Agent → Soul | renderer storage key `agent-soul` (localforage/IndexedDB), not a file |
| `settings.json` | Redacted copy of the `settings` blob from `%APPDATA%\Wao\config.json`: custom providers (Lamina `http://localhost:8080`, embeddings `http://127.0.0.1:8086`), read-aloud/ASR endpoints, theme, model defaults | `%APPDATA%\Wao\config.json` |

## Secrets — deliberately not in git

- `tavilyApiKey` and `asrKey` are replaced with `<REDACTED>`. Re-enter the
  Tavily key under Settings → Web search after restoring; the ASR key must
  match the `cbl-voice` sidecar's `.env` (local-only service).
- The Lamina provider key `"abc "` is a placeholder the field requires for
  a keyless local endpoint — not a secret.
- The local chat API bearer token (`%APPDATA%\Wao\local-api-token.txt`) is
  machine-local and regenerable; never committed.

## Restoring

- **Soul:** copy `soul.md` into Settings → Agent → Soul (the app keeps it in
  IndexedDB; there is no file drop-in).
- **Settings:** `settings.json` is a reference snapshot. To restore fully,
  close Wao and merge it into a fresh `%APPDATA%\Wao\config.json` under the
  `settings` key (config.json also holds `configVersion`, `windowState` and
  `configs.uuid` — regenerate those rather than copying, the uuid seeds
  device identity). Then re-enter the redacted keys.

## Refreshing the snapshot

Run from the repo root while Wao holds the current state:

```powershell
node probe/mksnapshot.cjs   # regenerates defaults/settings.json (redacted)
```

The Soul must be copied from the Settings → Agent → Soul editor (or via an
agent session's SOUL file view) — `probe/idbextract.cjs` shows why reading
IndexedDB directly is fragile; don't script it.

## Not included

- Agent memories (Settings → Agent → Memories): living personal facts, not
  configuration; use the in-app export if you need a backup.
- Chat transcripts: app backup/export covers those.
- Window geometry, About-dialog state, device uuid: machine noise.

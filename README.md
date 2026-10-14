# tagplay

Self-hosted app for NFC tags. A tag stores a short URL such as
`https://tagplay.duckdns.org/v/HI542HCI`; scanning it opens a page that streams a
video. The link stays valid until you deactivate it.

You convert your video on your own machine with `scripts/convert.sh` (MP4, H.264 + AAC,
faststart), then upload the result with one REST call. The server does no conversion: it
stores the MP4 on local disk and returns the link to write on the tag.

Node.js 20+, TypeScript, Express, multer, better-sqlite3. No Docker, no cloud.

## Environment variables

| Variable      | Required | Default  | Description                                               |
| ------------- | -------- | -------- | --------------------------------------------------------- |
| `ADMIN_KEY`   | yes      |          | Secret for the `X-Admin-Key` header. Must not be empty.   |
| `BASE_URL`    | yes      |          | Public URL, e.g. `https://tagplay.duckdns.org`            |
| `PORT`        | no       | `3001`   | Port; the app listens on `127.0.0.1` only                 |
| `DATA_DIR`    | no       | `./data` | Holds `tagplay.db`, `videos/` and `tmp/`                  |

The app refuses to start if `ADMIN_KEY` or `BASE_URL` is missing.

## Run locally

Needs Node 20+.

```bash
npm install
ADMIN_KEY=dev-key BASE_URL=http://localhost:3001 npm run dev
```

PowerShell:

```powershell
npm install
$env:ADMIN_KEY="dev-key"; $env:BASE_URL="http://localhost:3001"; npm run dev
```

Then open http://localhost:3001 (the app has no home page; upload a video first and
open the returned `url`).

## Prepare a video (on your machine)

Needs ffmpeg (with libx264 and aac) installed locally, e.g. `sudo dnf install ffmpeg`.

```bash
./scripts/convert.sh source.mov      # -> source-tagplay.mp4
```

The script runs ffmpeg with: `-c:v libx264 -pix_fmt yuv420p -crf 28 -preset slow
-c:a aac -b:a 96k -movflags +faststart`. Set `FFMPEG_PATH` if ffmpeg is not on the PATH.

## Upload a video

Upload the already processed MP4 (the server stores it as is):

```bash
curl -X POST https://tagplay.duckdns.org/admin/videos -H "X-Admin-Key: $ADMIN_KEY" -F "title=Demo" -F "video=@source-tagplay.mp4"
```

(In Windows PowerShell use `curl.exe` and `$env:ADMIN_KEY`; plain `curl` is an alias of
another command there.)

Response `201`:

```json
{ "videoId": 1, "code": "HI542HCI", "url": "https://tagplay.duckdns.org/v/HI542HCI" }
```

Write `url` on the NFC tag. `title` is optional (defaults to the file name without its
extension).

Errors are JSON `{ "error": "..." }`: `401` wrong/missing key, `413` over 500 MB,
`415` not an MP4 (`video/mp4`).

## Other admin endpoints

All need the `X-Admin-Key` header.

```bash
# list tags (code, active, createdAt, video title)
curl https://tagplay.duckdns.org/admin/tags -H "X-Admin-Key: $ADMIN_KEY"

# deactivate / reactivate a tag, or point it to another video
curl -X PATCH https://tagplay.duckdns.org/admin/tags/HI542HCI \
  -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"active": false}'
curl -X PATCH https://tagplay.duckdns.org/admin/tags/HI542HCI \
  -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"videoId": 2}'
```

## Delete a video permanently

```bash
curl -X DELETE https://tagplay.duckdns.org/admin/videos/1 -H "X-Admin-Key: $ADMIN_KEY"
```

Response `200`: `{ "deleted": true, "videoId": 1, "removedTags": ["HI542HCI"] }`.

This is **irreversible**. It removes the video, every tag pointing to it (the links stop
working for good) and the MP4 file, which is overwritten with zeros and flushed to disk
before being deleted. The SQLite database runs with `secure_delete`, so the rows do not
linger in the `.db` file either. Errors: `400` invalid id, `401` wrong/missing key,
`404` unknown video. To stop a tag temporarily instead, deactivate it (see above).

Limits: this wipes the file as far as the application can. Existing backups and
snapshots of `DATA_DIR` are not touched, and on SSDs or copy-on-write filesystems
(btrfs, ZFS) overwriting in place does not guarantee the old blocks are physically gone.

## Public routes

- `GET /v/:code`: player page (code is case-insensitive).
- `GET /v/:code/video`: the MP4 stream, with HTTP Range support (needed by iPhone/Safari).

A deactivated tag stops working immediately on both routes (404).

The page hides the player's download button and context menu, but this only discourages
casual saving: anyone technical can still fetch the stream URL. It is not DRM.

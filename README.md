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

## Public routes

- `GET /v/:code`: player page (code is case-insensitive).
- `GET /v/:code/video`: the MP4 stream, with HTTP Range support (needed by iPhone/Safari).

A deactivated tag stops working immediately on both routes (404).

The page hides the player's download button and context menu, but this only discourages
casual saving: anyone technical can still fetch the stream URL. It is not DRM.

## Deploy on your server (systemd + nginx + certbot)

Prerequisites:

- The DuckDNS name `tagplay.duckdns.org` points to your server's public IP.
- Ports 80 and 443 are open on the server and forwarded by your router (certbot needs
  them to issue the certificate).

1. **Install what is missing.** nginx is already there. Install Node 20+ manually, and
   certbot with its nginx plugin, e.g. on Debian/Ubuntu:

   ```bash
   sudo apt install certbot python3-certbot-nginx
   # Node 20+: install it your usual way (NodeSource, ...), then check: node -v
   ```

   If `npm ci` has to compile better-sqlite3 (no prebuilt binary for your platform):
   `sudo apt install build-essential python3`.

2. **Create the service user and folders.**

   ```bash
   sudo useradd --system --no-create-home --shell /usr/sbin/nologin tagplay
   sudo mkdir -p /opt/tagplay /var/lib/tagplay
   sudo chown tagplay:tagplay /var/lib/tagplay      # DATA_DIR must be writable by the service
   sudo chown "$USER": /opt/tagplay                 # you build the app as yourself
   ```

3. **Copy the project to `/opt/tagplay`** (without `node_modules`, `dist`, `data`), then
   build. The build needs the dev dependencies, so prune only afterwards:

   ```bash
   cd /opt/tagplay
   npm ci
   npm run build
   npm prune --omit=dev
   ```

4. **Create `/etc/tagplay.env`:**

   ```bash
   sudo tee /etc/tagplay.env >/dev/null <<EOF
   ADMIN_KEY=$(openssl rand -hex 32)
   BASE_URL=https://tagplay.duckdns.org
   PORT=3001
   DATA_DIR=/var/lib/tagplay
   EOF
   sudo chmod 600 /etc/tagplay.env
   sudo cat /etc/tagplay.env      # note your ADMIN_KEY
   ```

5. **Enable and start the service:**

   ```bash
   sudo cp tagplay.service /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now tagplay
   journalctl -u tagplay -f        # logs
   ```

   If the `node` path in `tagplay.service` is not `/usr/bin/node` (`which node`), edit it.

6. **Configure nginx:**

   ```bash
   sudo cp nginx/tagplay.conf /etc/nginx/sites-available/tagplay.conf
   sudo ln -s /etc/nginx/sites-available/tagplay.conf /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl reload nginx
   ```

7. **HTTPS with certbot:**

   ```bash
   sudo certbot --nginx -d tagplay.duckdns.org
   ```

   certbot adds the HTTPS block and the redirect to the nginx config. It also installs
   automatic renewal (a systemd timer or cron job); check it with
   `sudo certbot renew --dry-run`.

8. **Try it** with the curl example above.

### Updating

After each code update, in `/opt/tagplay`:

```bash
npm ci && npm run build && npm prune --omit=dev
sudo systemctl restart tagplay
```

### Backups

`DATA_DIR` (`/var/lib/tagplay`) is the folder to back up: the uploaded videos in
`videos/` and the database `tagplay.db`. Copy it while the service is stopped, or the
database file may be caught mid-write. `tmp/` holds in-progress uploads and does not need
backing up.

# Installation & Deployment (Ubuntu VM)

Step-by-step guide to run tagplay on an Ubuntu 22.04 server and expose it over HTTPS with nginx and a free DuckDNS name. The app runs in the background with PM2 (like Klaody) on `127.0.0.1:3001` (port 3000 is already used by another app on this server), under your own user, with everything inside your home folder. nginx is the only public entry point.

Replace every `<placeholder>` with your own value. If you already set up Node.js, PM2, nginx, or the firewall ports for another app on the same VM, skip the matching step.

## 1. Clone the repository

```bash
git clone https://github.com/Ilo06/tagplay.git
cd tagplay
```

Run every command below from this folder unless told otherwise.

## 2. Install Node.js 22

Skip this step if `node -v` already shows v20.6 or newer (the app needs it to load its `.env` file).

If `npm: command not found`: the `node` package does not exist in apt, and `sudo apt install npm` installs an outdated version. Use NodeSource:

```bash
sudo apt update
sudo apt install -y curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v    # v22.x
npm -v
```

## 3. Install ffmpeg and the build tools

tagplay calls ffmpeg to convert every upload to MP4 (H.264 + AAC). The build tools are needed because `better-sqlite3` is a native module that `npm ci` may have to compile.

```bash
sudo apt install -y ffmpeg build-essential
ffmpeg -version | head -1
ffmpeg -hide_banner -encoders | grep -E "libx264|aac"    # both must be listed
```

> `npm error ... gyp ERR! stack Error: not found: make` during `npm ci` means `build-essential` is missing. Install it and run `npm ci` again.

## 4. Install and build the app

```bash
npm ci
npm run build
npm prune --omit=dev     # the build needs the dev dependencies, so prune only afterwards
```

## 5. Configure

Create the `.env` file in the app folder (it is git-ignored). The admin key is generated for you:

```bash
cat > .env <<EOF
ADMIN_KEY=$(openssl rand -hex 32)
BASE_URL=https://tagplay.duckdns.org
PORT=3001
DATA_DIR=$HOME/tagplay-data
EOF
chmod 600 .env
```

| Variable      | Description                                                                          |
| ------------- | ------------------------------------------------------------------------------------ |
| `ADMIN_KEY`   | Secret for the `X-Admin-Key` header. Use a long random value, keep it private.       |
| `BASE_URL`    | Public URL. It is the start of every link returned by the upload endpoint.           |
| `PORT`        | `3001`. The app listens on `127.0.0.1` only.                                         |
| `DATA_DIR`    | Videos and the SQLite database. Created automatically on the first start.            |
| `FFMPEG_PATH` | Optional. Only if ffmpeg is not on the PATH.                                         |

Read the admin key back when you need it (step 9): `grep '^ADMIN_KEY=' .env`

> `BASE_URL` is written into the links you put on the NFC tags. Set the final HTTPS domain now, before uploading anything.

> The app does not read `.env` by itself: PM2 starts it with Node's `--env-file=.env` flag (step 6). After editing `.env`, run `pm2 restart tagplay`.

## 6. Keep it running with PM2

Run this from the app folder: PM2 remembers it, and `.env` and `dist/` are found relative to it.

```bash
sudo npm i -g pm2        # skip if already installed for Klaody
pm2 start dist/server.js --name tagplay --node-args="--env-file=.env"
pm2 save
pm2 logs tagplay --lines 30
```

If you already ran `pm2 startup` for Klaody, `pm2 save` is all you need. Otherwise run `pm2 startup`, run the command it prints, then `pm2 save`, so both apps come back after a reboot.

The log should show `tagplay listening on http://127.0.0.1:3001`. Check that the app answers locally (a 404 "Video not found" page is the expected answer, there is no home page):

```bash
pm2 status
curl -i http://127.0.0.1:3001/v/AAAAAAAA
sudo ss -tlnp | grep 3001     # must show 127.0.0.1:3001, not 0.0.0.0
```

If `pm2 status` shows `errored` or the app keeps restarting, read the error log with `pm2 logs tagplay --err --lines 30`:

| Message                                                | Fix                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `node: .env: not found`                                | PM2 was started outside the app folder, or `.env` is missing. `pm2 delete tagplay`, then redo step 5 and run the `pm2 start` command again from the app folder. |
| `ADMIN_KEY is required and must not be empty`          | `.env` has no `ADMIN_KEY` line. Fix it, then `pm2 restart tagplay`.                              |
| `BASE_URL is required` / `BASE_URL is not a valid URL` | Add the full URL with `https://`, then `pm2 restart tagplay`.                                    |
| `ffmpeg is not available`                              | Redo step 3, or set `FFMPEG_PATH` in `.env`.                                                     |
| `EACCES ... tagplay-data`                              | `sudo chown -R "$USER": ~/tagplay-data`, then `pm2 restart tagplay`.                             |
| `Cannot find module` / `ERR_MODULE_NOT_FOUND`          | `npm ci && npm run build && npm prune --omit=dev`, then `pm2 restart tagplay`.                   |

## 7. Open the ports

Skip this step if ports 80 and 443 already work for another app on this VM.

**a) Cloud provider firewall** (security group / security list): allow inbound TCP 80 and 443 from `0.0.0.0/0`.

**b) VM firewall** (Ubuntu images on Oracle Cloud)

iptables reads rules in order. The `ACCEPT` rules for ports 80 and 443 must come **before** the `REJECT ... icmp-host-prohibited` rule, otherwise the traffic is rejected (symptoms: `No route to host` and Certbot failures).

```bash
sudo iptables -L INPUT -n --line-numbers
```

If they come after the `REJECT` (for example the `REJECT` is rule 5 and the `ACCEPT` rules are 6 and 7), delete the misplaced rules (highest number first), then re-insert them before the `REJECT`:

```bash
sudo iptables -D INPUT 7
sudo iptables -D INPUT 6
sudo iptables -I INPUT 5 -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 5 -p tcp --dport 443 -j ACCEPT
```

Make the rules persistent across reboots (otherwise certificate renewal will break after a restart):

```bash
sudo apt install -y iptables-persistent   # if netfilter-persistent is missing
sudo netfilter-persistent save
```

> Do **not** open port 3001. The app only listens on `127.0.0.1`, and nginx is the public entry point.

## 8. Expose the app: nginx + HTTPS

Prerequisite: the DuckDNS subdomain `tagplay.duckdns.org` points to the VM's public IP.

```bash
curl -4 ifconfig.me                  # public IP of the VM
nslookup tagplay.duckdns.org         # must return the same IP (otherwise update DuckDNS)
```

Install nginx and certbot (skip what is already installed), then enable the site from the repository:

```bash
sudo apt install -y nginx certbot python3-certbot-nginx

sudo cp nginx/tagplay.conf /etc/nginx/sites-available/tagplay.conf
sudo ln -s /etc/nginx/sites-available/tagplay.conf /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

The config allows uploads up to 500 MB (it must match the limit in the app), streams uploads straight to Node, and waits up to one hour for the response, because the upload only answers once ffmpeg has finished converting the video.

Get the certificate (certbot adds the HTTPS block and the redirect to the nginx config):

```bash
sudo certbot --nginx -d tagplay.duckdns.org
curl -i https://tagplay.duckdns.org/v/AAAAAAAA     # 404 "Video not found" = HTTPS and proxy work
```

Certbot renews the certificate automatically. To test the renewal: `sudo certbot renew --dry-run`.

**If Certbot fails** (`Error getting validation data`, `No route to host`), port 80 is blocked before reaching nginx. Check, in this order:

```bash
nslookup tagplay.duckdns.org                # must return the VM's public IP
sudo systemctl status nginx --no-pager
sudo ss -tlnp | grep -E ':80|:443'
curl -I http://localhost
sudo iptables -L INPUT -n --line-numbers    # ACCEPT 80/443 before the REJECT (see step 7)
```

Also check the **ingress** rules for TCP 80 and 443 in your cloud provider's console. Test from outside the VM: `curl -I http://tagplay.duckdns.org`.

> `curl https://tagplay.duckdns.org` (without a path) returns `Cannot GET /`. This is expected: the app has no home page. Use `/v/<code>` or the admin endpoints.

## 9. Upload your first video

Any video format works (mp4, mov, mkv, ...): the server converts it to MP4. From the app folder, load the admin key into your shell, then upload:

```bash
export ADMIN_KEY=$(grep '^ADMIN_KEY=' .env | cut -d= -f2)

curl -X POST https://tagplay.duckdns.org/admin/videos \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -F "title=Demo" \
  -F "video=@source.mov"
```

The response is `{ "videoId": 1, "code": "HI542HCI", "url": "https://tagplay.duckdns.org/v/HI542HCI" }`. Write `url` on the NFC tag.

> The request returns only once the conversion is finished. A long video can take several minutes, curl simply waits.

Other admin calls (all need the `X-Admin-Key` header):

```bash
# list tags
curl https://tagplay.duckdns.org/admin/tags -H "X-Admin-Key: $ADMIN_KEY"

# deactivate a tag (use "active": true to bring it back, or "videoId": 2 to point it to another video)
curl -X PATCH https://tagplay.duckdns.org/admin/tags/<code> \
  -H "X-Admin-Key: $ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{"active": false}'
```

The full API is described in `openapi.yaml`.

## 10. Update, logs and backup

After each code update, from the app folder:

```bash
git pull
npm ci && npm run build && npm prune --omit=dev
pm2 restart tagplay
```

Logs and status:

```bash
pm2 logs tagplay
pm2 status
```

Back up `~/tagplay-data`: it holds the converted videos (`videos/`) and the database (`tagplay.db`). Stop the app while copying it (`pm2 stop tagplay`, then `pm2 restart tagplay` when done), otherwise the database file may be caught mid-write. `tmp/` only holds uploads in progress.

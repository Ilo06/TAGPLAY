import express from "express";
import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import cors from "cors";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import * as db from "./db.js";

export interface Config {
  adminKey: string;
  baseUrl: string; // without trailing slash
  dataDir: string;
}

// Keep in sync with client_max_body_size in nginx/tagplay.conf.
const MAX_UPLOAD_BYTES = 500 * 1024 * 1024;

const NOT_FOUND_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  "<title>Video not found</title></head>" +
  '<body style="font-family:sans-serif;text-align:center;padding:4rem 1rem">' +
  "<h1>Video not found</h1></body></html>";

function playerPage(code: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    "<title>Video</title>" +
    "<style>html,body{margin:0;height:100%;background:#000}" +
    "video{position:fixed;inset:0;width:100%;height:100%;object-fit:contain;background:#000}</style>" +
    "</head><body>" +
    `<video controls controlsList="nodownload" playsinline preload="metadata" oncontextmenu="return false" src="/v/${code}/video"></video>` +
    "</body></html>"
  );
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function tagJson(tag: db.TagWithVideo) {
  return {
    code: tag.code,
    active: tag.active === 1,
    createdAt: tag.created_at,
    videoId: tag.video_id,
    videoTitle: tag.video_title,
  };
}

// Overwrites the file with zeros, flushes it to disk, then unlinks it, so the
// content is not simply left in freed blocks. A file that is already gone is fine.
async function eraseFile(filePath: string): Promise<void> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(filePath, "r+");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  try {
    const { size } = await handle.stat();
    const zeros = Buffer.alloc(1024 * 1024);
    for (let pos = 0; pos < size; pos += zeros.length) {
      await handle.write(zeros, 0, Math.min(zeros.length, size - pos), pos);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rm(filePath, { force: true });
}

export function createApp(config: Config): express.Express {
  const dataDir = path.resolve(config.dataDir);
  const tmpDir = path.join(dataDir, "tmp");
  const videosDir = path.join(dataDir, "videos");

  // No upload is in flight at startup, so anything left in tmp/ comes from a crash.
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(videosDir, { recursive: true });
  db.initDb(dataDir);

  // Hash both sides so timingSafeEqual always gets equal-length buffers.
  const adminKeyHash = createHash("sha256").update(config.adminKey).digest();

  const upload = multer({
    storage: multer.diskStorage({
      destination: tmpDir,
      filename: (_req, _file, cb) => cb(null, randomUUID()),
    }),
    limits: { fileSize: MAX_UPLOAD_BYTES },
    defParamCharset: "utf8", // so a file name like "vidéo.mov" gives the title "vidéo"
    fileFilter: (_req, file, cb) => {
      if (file.mimetype === "video/mp4") {
        cb(null, true);
      } else {
        cb(httpError(415, "An MP4 file is required (field 'video', mimetype video/mp4)"));
      }
    },
  });

  const app = express();

  // Enable CORS for all origins (allows local html files or remote dashboard to connect).
  // DELETE is listed explicitly: the cors() default already includes it, but this makes it obvious.
  app.use(cors({ methods: ["GET", "HEAD", "POST", "PATCH", "DELETE"] }));

  // ---------- Admin ----------

  // Runs before multer, so unauthenticated requests never write anything to disk.
  app.use("/admin", (req: Request, res: Response, next: NextFunction) => {
    const given = createHash("sha256").update(req.get("X-Admin-Key") ?? "").digest();
    if (timingSafeEqual(given, adminKeyHash)) {
      next();
    } else {
      res.status(401).json({ error: "Missing or invalid X-Admin-Key" });
    }
  });

  app.post("/admin/videos", upload.single("video"), async (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: "A video file is required (field 'video')" });
      return;
    }

    // The video is expected to be already processed (MP4, H.264 + AAC, faststart,
    // see scripts/convert.sh): it is stored as is. tmp/ and videos/ are on the same
    // filesystem, so this is a cheap rename.
    const fileName = `${randomUUID()}.mp4`;
    const outputPath = path.join(videosDir, fileName);
    try {
      await fsp.rename(file.path, outputPath);

      const rawTitle = typeof req.body?.title === "string" ? req.body.title.trim() : "";
      const title = rawTitle || path.parse(file.originalname).name;
      const { videoId, code } = db.createVideoWithTag(title, fileName);

      res.status(201).json({ videoId, code, url: `${config.baseUrl}/v/${code}` });
    } catch (err) {
      await fsp.rm(outputPath, { force: true });
      throw err;
    } finally {
      // No-op once the file has been moved; cleans up tmp/ if the rename failed.
      await fsp.rm(file.path, { force: true });
    }
  });

  // Permanent and irreversible: removes the video, every tag that points to it
  // (their links stop working for good) and the MP4 file itself, which is zeroed
  // and then deleted from disk. The database rows go first, so the public routes
  // answer 404 immediately.
  app.delete("/admin/videos/:id", async (req: Request, res: Response) => {
    const rawId = String(req.params.id);
    if (!/^\d+$/.test(rawId)) {
      res.status(400).json({ error: "Video id must be a positive integer" });
      return;
    }

    const removed = db.deleteVideo(Number(rawId));
    if (!removed) {
      res.status(404).json({ error: "Video not found" });
      return;
    }

    try {
      await eraseFile(path.join(videosDir, removed.fileName));
    } catch (err) {
      console.error(`tagplay: could not erase ${removed.fileName}`, err);
      res.status(500).json({
        error: "Video removed from the database, but its file could not be erased from disk",
      });
      return;
    }

    res.json({ deleted: true, videoId: Number(rawId), removedTags: removed.codes });
  });

  app.get("/admin/tags", (_req: Request, res: Response) => {
    res.json(db.listTags().map(tagJson));
  });

  app.patch("/admin/tags/:code", express.json(), (req, res) => {
    const code = req.params.code.toUpperCase();
    const { active, videoId } = (req.body ?? {}) as { active?: unknown; videoId?: unknown };

    if (active !== undefined && typeof active !== "boolean") {
      res.status(400).json({ error: "'active' must be a boolean" });
      return;
    }
    if (videoId !== undefined && (typeof videoId !== "number" || !Number.isInteger(videoId))) {
      res.status(400).json({ error: "'videoId' must be an integer" });
      return;
    }
    if (active === undefined && videoId === undefined) {
      res.status(400).json({ error: "Provide 'active' and/or 'videoId'" });
      return;
    }
    if (!db.findTag(code)) {
      res.status(404).json({ error: "Tag not found" });
      return;
    }
    if (videoId !== undefined && !db.videoExists(videoId)) {
      res.status(404).json({ error: "Video not found" });
      return;
    }

    db.updateTag(code, { active, videoId });
    res.json(tagJson(db.findTag(code)!));
  });

  // ---------- Public ----------

  function sendNotFound(res: Response): void {
    res.status(404).set("Cache-Control", "no-store").type("html").send(NOT_FOUND_HTML);
  }

  app.get("/v/:code", (req, res) => {
    const tag = db.findTag(req.params.code.toUpperCase());
    if (!tag || tag.active !== 1) {
      sendNotFound(res);
      return;
    }
    res.set("Cache-Control", "no-store").type("html").send(playerPage(tag.code));
  });

  // res.sendFile handles HTTP Range requests (206), which Safari/iPhone require.
  app.get("/v/:code/video", (req, res, next) => {
    const tag = db.findTag(req.params.code.toUpperCase());
    if (!tag || tag.active !== 1) {
      sendNotFound(res);
      return;
    }
    res.sendFile(
      tag.file_name,
      {
        root: videosDir,
        cacheControl: false,
        headers: {
          "Content-Type": "video/mp4",
          "Content-Disposition": "inline",
          "Cache-Control": "no-store",
        },
      },
      (err) => {
        if (!err || res.headersSent) return; // success, or the client went away mid-stream
        if ((err as { status?: number }).status === 404) sendNotFound(res);
        else next(err);
      },
    );
  });

  // ---------- Errors ----------

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    let status = 500;
    let message = "Internal server error";
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        status = 413;
        message = `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`;
      } else {
        status = 400;
        message = err.message;
      }
    } else if (err instanceof Error && "status" in err && typeof err.status === "number") {
      status = err.status;
      message = err.message;
    } else {
      console.error(err);
    }
    res.status(status).json({ error: message });
  });

  return app;
}

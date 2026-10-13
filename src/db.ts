import Database from "better-sqlite3";
import { randomInt } from "node:crypto";
import path from "node:path";

export interface VideoRow {
  id: number;
  title: string;
  file_name: string;
  created_at: string;
}

export interface TagRow {
  id: number;
  code: string;
  video_id: number;
  active: number; // 1 = active, 0 = deactivated
  created_at: string;
}

// A tag joined with the video it points to.
export interface TagWithVideo extends TagRow {
  video_title: string;
  file_name: string;
}

const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CODE_LENGTH = 8;

let db: Database.Database;

export function initDb(dataDir: string): void {
  db = new Database(path.join(dataDir, "tagplay.db"));
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      file_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      video_id INTEGER NOT NULL REFERENCES videos(id),
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL
    );
  `);
}

function generateCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

// Inserts the video and its tag in one transaction. The code is regenerated on
// collision (better-sqlite3 is synchronous, so check-then-insert cannot race).
export function createVideoWithTag(
  title: string,
  fileName: string,
): { videoId: number; code: string } {
  const run = db.transaction(() => {
    const now = new Date().toISOString();
    const result = db
      .prepare("INSERT INTO videos (title, file_name, created_at) VALUES (?, ?, ?)")
      .run(title, fileName, now);
    const videoId = Number(result.lastInsertRowid);

    for (;;) {
      const code = generateCode();
      if (db.prepare("SELECT 1 FROM tags WHERE code = ?").get(code)) continue;
      db.prepare("INSERT INTO tags (code, video_id, created_at) VALUES (?, ?, ?)").run(
        code,
        videoId,
        now,
      );
      return { videoId, code };
    }
  });
  return run();
}

const TAG_SELECT = `
  SELECT t.id, t.code, t.video_id, t.active, t.created_at,
         v.title AS video_title, v.file_name
  FROM tags t JOIN videos v ON v.id = t.video_id
`;

export function listTags(): TagWithVideo[] {
  return db.prepare(`${TAG_SELECT} ORDER BY t.id DESC`).all() as TagWithVideo[];
}

export function findTag(code: string): TagWithVideo | undefined {
  return db.prepare(`${TAG_SELECT} WHERE t.code = ?`).get(code) as TagWithVideo | undefined;
}

export function videoExists(id: number): boolean {
  return db.prepare("SELECT 1 FROM videos WHERE id = ?").get(id) !== undefined;
}

export function updateTag(code: string, patch: { active?: boolean; videoId?: number }): void {
  db.transaction(() => {
    if (patch.active !== undefined) {
      db.prepare("UPDATE tags SET active = ? WHERE code = ?").run(patch.active ? 1 : 0, code);
    }
    if (patch.videoId !== undefined) {
      db.prepare("UPDATE tags SET video_id = ? WHERE code = ?").run(patch.videoId, code);
    }
  })();
}

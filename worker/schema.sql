CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_slug TEXT NOT NULL,
  title TEXT NOT NULL,
  post_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_reply_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threads_board ON threads(board_slug, last_reply_at DESC);

CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ip_hash TEXT
);

CREATE INDEX IF NOT EXISTS idx_posts_thread ON posts(thread_id, created_at ASC);

CREATE TABLE IF NOT EXISTS rate_limits (
  ip_hash TEXT PRIMARY KEY,
  last_post_at TEXT NOT NULL,
  post_count_today INTEGER NOT NULL DEFAULT 0,
  day TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER,
  post_id INTEGER,
  reason TEXT,
  created_at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0
);

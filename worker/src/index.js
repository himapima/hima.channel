/**
 * 匿名雑談掲示板のAPI(Cloudflare Worker + D1)。
 *
 * GET    /api/boards                       -> 板一覧(コード内のBOARDS定義を返す)
 * GET    /api/boards/:slug/threads         -> その板のスレッド一覧(新着レス順)
 * POST   /api/boards/:slug/threads         -> {title, name, body} でスレッドを新規作成(先頭レス込み)
 * GET    /api/threads/:id                  -> スレッド詳細+レス一覧
 * POST   /api/threads/:id/posts            -> {name, body} でレスを追加
 * POST   /api/reports                      -> {thread_id?, post_id?, reason} で通報を記録(削除依頼の受付窓口)
 * DELETE /api/threads/:id                  -> 管理者用(X-Admin-Token一致時のみ、レス含め削除)
 * DELETE /api/posts/:id                    -> 管理者用(X-Admin-Token一致時のみ削除)
 * GET    /api/reports                      -> 管理者用(未対応の通報一覧)
 *
 * IPアドレスは平文で保存せず、salt付きハッシュにしてスパム対策のレート制限のみに使う。
 * 「出会い」目的の投稿を防ぐため、出会い系・年齢を偽った誘引を示す語をNGワードに含めている。
 */

const MAX_TITLE_LENGTH = 100;
const MAX_NAME_LENGTH = 30;
const MAX_BODY_LENGTH = 1000;
const MAX_REASON_LENGTH = 300;
const RATE_LIMIT_SECONDS = 15;
const MAX_POSTS_PER_DAY = 200;
const THREAD_LIST_LIMIT = 100;
const POST_LIST_LIMIT = 1000;

const BOARDS = [
  { slug: "chat", name: "雑談", description: "なんでも雑談板" },
  { slug: "youtube", name: "YouTube・動画", description: "YouTubeや動画配信の話題" },
  { slug: "game", name: "ゲーム", description: "ゲーム全般の話題" },
  { slug: "anime", name: "アニメ・漫画", description: "アニメ・漫画の話題" },
  { slug: "sports", name: "スポーツ", description: "スポーツ全般の話題" },
  { slug: "news", name: "ニュース・時事", description: "ニュース・時事ネタの雑談" },
];

// 違法・重大な迷惑行為につながる投稿を機械的にはじくための最低限のNGワード。
// 出会い系サイト規制法の対象になる「出会い」目的の投稿(特に年齢を伴う誘引)は明確に禁止する。
const NG_PATTERNS = [
  /出会い(系|募集|求む)/,
  /(男|女)性(募集|探して|求む)/,
  /個人撮影.{0,5}(売買|販売)/,
  /援助交際|パパ活|ママ活/,
  /児童ポルノ|ロリ.{0,3}(募集|販売|売買)/,
  /(未成年|jc|js|jk).{0,10}(募集|出会い|エッチ|セックス)/i,
  /セフレ(募集|探し)/,
  /(覚醒剤|大麻|MDMA|違法薬物).{0,5}(売|買|譲|販売)/,
  /拳銃.{0,5}(売|譲|販売)/,
  /殺す.{0,10}(予告|してやる)/,
  /死ね.{0,5}(住所|特定)/,
];

function boardBySlug(slug) {
  return BOARDS.find((b) => b.slug === slug);
}

function corsHeaders(origin, allowedOrigin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
  };
  if (origin === allowedOrigin) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function json(data, status, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

async function hashIp(ip, salt) {
  const enc = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function containsNgWord(text) {
  return NG_PATTERNS.some((re) => re.test(text));
}

async function checkRateLimit(env, ipHash) {
  const today = new Date().toISOString().slice(0, 10);
  const row = await env.DB.prepare("SELECT last_post_at, post_count_today, day FROM rate_limits WHERE ip_hash = ?")
    .bind(ipHash)
    .first();

  if (row) {
    const elapsed = (Date.now() - new Date(row.last_post_at).getTime()) / 1000;
    if (elapsed < RATE_LIMIT_SECONDS) {
      return { ok: false, reason: "too many requests" };
    }
    const countToday = row.day === today ? row.post_count_today : 0;
    if (countToday >= MAX_POSTS_PER_DAY) {
      return { ok: false, reason: "daily limit reached" };
    }
    await env.DB.prepare(
      "UPDATE rate_limits SET last_post_at = ?, post_count_today = ?, day = ? WHERE ip_hash = ?"
    )
      .bind(new Date().toISOString(), countToday + 1, today, ipHash)
      .run();
  } else {
    await env.DB.prepare(
      "INSERT INTO rate_limits (ip_hash, last_post_at, post_count_today, day) VALUES (?, ?, 1, ?)"
    )
      .bind(ipHash, new Date().toISOString(), today)
      .run();
  }
  return { ok: true };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const headers = corsHeaders(origin, env.ALLOWED_ORIGIN);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    // GET /api/boards
    if (url.pathname === "/api/boards" && request.method === "GET") {
      return json({ boards: BOARDS }, 200, headers);
    }

    // GET /api/boards/:slug/threads
    let m = url.pathname.match(/^\/api\/boards\/([a-z0-9_-]+)\/threads$/);
    if (m && request.method === "GET") {
      const board = boardBySlug(m[1]);
      if (!board) return json({ error: "board not found" }, 404, headers);

      const { results } = await env.DB.prepare(
        "SELECT id, title, post_count, created_at, last_reply_at FROM threads WHERE board_slug = ? ORDER BY last_reply_at DESC LIMIT ?"
      )
        .bind(board.slug, THREAD_LIST_LIMIT)
        .all();

      return json({ board, threads: results }, 200, headers);
    }

    // POST /api/boards/:slug/threads
    if (m && request.method === "POST") {
      const board = boardBySlug(m[1]);
      if (!board) return json({ error: "board not found" }, 404, headers);

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid json" }, 400, headers);
      }

      const honeypot = (body.honeypot || "").toString();
      if (honeypot) return json({ error: "rejected" }, 400, headers);

      const title = (body.title || "").toString().trim().slice(0, MAX_TITLE_LENGTH);
      let name = (body.name || "").toString().trim().slice(0, MAX_NAME_LENGTH);
      const text = (body.body || "").toString().trim().slice(0, MAX_BODY_LENGTH);

      if (!title || !text) return json({ error: "title and body are required" }, 400, headers);
      if (!name) name = "名無しさん";

      if (containsNgWord(title) || containsNgWord(text)) {
        return json({ error: "この内容は投稿できません" }, 400, headers);
      }

      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const ipHash = await hashIp(ip, env.IP_SALT);
      const rl = await checkRateLimit(env, ipHash);
      if (!rl.ok) return json({ error: rl.reason }, 429, headers);

      const now = new Date().toISOString();
      const safeTitle = escapeHtml(title);
      const safeName = escapeHtml(name);
      const safeText = escapeHtml(text);

      const thread = await env.DB.prepare(
        "INSERT INTO threads (board_slug, title, post_count, created_at, last_reply_at) VALUES (?, ?, 1, ?, ?) RETURNING id"
      )
        .bind(board.slug, safeTitle, now, now)
        .first();

      await env.DB.prepare(
        "INSERT INTO posts (thread_id, name, body, created_at, ip_hash) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(thread.id, safeName, safeText, now, ipHash)
        .run();

      return json({ id: thread.id, title: safeTitle }, 201, headers);
    }

    // GET /api/threads/:id
    m = url.pathname.match(/^\/api\/threads\/(\d+)$/);
    if (m && request.method === "GET") {
      const threadId = m[1];
      const thread = await env.DB.prepare(
        "SELECT id, board_slug, title, post_count, created_at, last_reply_at FROM threads WHERE id = ?"
      )
        .bind(threadId)
        .first();
      if (!thread) return json({ error: "thread not found" }, 404, headers);

      const { results } = await env.DB.prepare(
        "SELECT id, name, body, created_at FROM posts WHERE thread_id = ? ORDER BY created_at ASC LIMIT ?"
      )
        .bind(threadId, POST_LIST_LIMIT)
        .all();

      return json({ thread, board: boardBySlug(thread.board_slug), posts: results }, 200, headers);
    }

    // POST /api/threads/:id/posts
    m = url.pathname.match(/^\/api\/threads\/(\d+)\/posts$/);
    if (m && request.method === "POST") {
      const threadId = m[1];
      const thread = await env.DB.prepare("SELECT id FROM threads WHERE id = ?").bind(threadId).first();
      if (!thread) return json({ error: "thread not found" }, 404, headers);

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid json" }, 400, headers);
      }

      const honeypot = (body.honeypot || "").toString();
      if (honeypot) return json({ error: "rejected" }, 400, headers);

      let name = (body.name || "").toString().trim().slice(0, MAX_NAME_LENGTH);
      const text = (body.body || "").toString().trim().slice(0, MAX_BODY_LENGTH);
      if (!text) return json({ error: "body is required" }, 400, headers);
      if (!name) name = "名無しさん";

      if (containsNgWord(text)) {
        return json({ error: "この内容は投稿できません" }, 400, headers);
      }

      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const ipHash = await hashIp(ip, env.IP_SALT);
      const rl = await checkRateLimit(env, ipHash);
      if (!rl.ok) return json({ error: rl.reason }, 429, headers);

      const now = new Date().toISOString();
      const safeName = escapeHtml(name);
      const safeText = escapeHtml(text);

      const post = await env.DB.prepare(
        "INSERT INTO posts (thread_id, name, body, created_at, ip_hash) VALUES (?, ?, ?, ?, ?) RETURNING id"
      )
        .bind(threadId, safeName, safeText, now, ipHash)
        .first();

      await env.DB.prepare(
        "UPDATE threads SET post_count = post_count + 1, last_reply_at = ? WHERE id = ?"
      )
        .bind(now, threadId)
        .run();

      return json({ id: post.id, name: safeName, body: safeText, created_at: now }, 201, headers);
    }

    // POST /api/reports (削除依頼・通報の受付。管理者がGET /api/reportsで確認する)
    if (url.pathname === "/api/reports" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "invalid json" }, 400, headers);
      }
      const threadId = body.thread_id ? Number(body.thread_id) : null;
      const postId = body.post_id ? Number(body.post_id) : null;
      const reason = (body.reason || "").toString().trim().slice(0, MAX_REASON_LENGTH);
      if (!threadId && !postId) return json({ error: "thread_id or post_id is required" }, 400, headers);

      await env.DB.prepare(
        "INSERT INTO reports (thread_id, post_id, reason, created_at) VALUES (?, ?, ?, ?)"
      )
        .bind(threadId, postId, escapeHtml(reason), new Date().toISOString())
        .run();

      return json({ ok: true }, 201, headers);
    }

    // GET /api/reports (管理者用)
    if (url.pathname === "/api/reports" && request.method === "GET") {
      const adminToken = request.headers.get("X-Admin-Token") || "";
      if (!env.ADMIN_TOKEN || adminToken !== env.ADMIN_TOKEN) {
        return json({ error: "unauthorized" }, 401, headers);
      }
      const { results } = await env.DB.prepare(
        "SELECT id, thread_id, post_id, reason, created_at, resolved FROM reports WHERE resolved = 0 ORDER BY created_at DESC LIMIT 200"
      ).all();
      return json({ reports: results }, 200, headers);
    }

    // DELETE /api/threads/:id (管理者用)
    m = url.pathname.match(/^\/api\/threads\/(\d+)$/);
    if (m && request.method === "DELETE") {
      const adminToken = request.headers.get("X-Admin-Token") || "";
      if (!env.ADMIN_TOKEN || adminToken !== env.ADMIN_TOKEN) {
        return json({ error: "unauthorized" }, 401, headers);
      }
      await env.DB.prepare("DELETE FROM posts WHERE thread_id = ?").bind(m[1]).run();
      await env.DB.prepare("DELETE FROM threads WHERE id = ?").bind(m[1]).run();
      return json({ ok: true }, 200, headers);
    }

    // DELETE /api/posts/:id (管理者用)
    m = url.pathname.match(/^\/api\/posts\/(\d+)$/);
    if (m && request.method === "DELETE") {
      const adminToken = request.headers.get("X-Admin-Token") || "";
      if (!env.ADMIN_TOKEN || adminToken !== env.ADMIN_TOKEN) {
        return json({ error: "unauthorized" }, 401, headers);
      }
      await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(m[1]).run();
      return json({ ok: true }, 200, headers);
    }

    return json({ error: "not found" }, 404, headers);
  },
};

const API_BASE = "https://anon-bbs.tigeregg80.workers.dev";

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

async function apiGet(path) {
  const res = await fetch(API_BASE + path);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "取得に失敗しました");
  return res.json();
}

async function apiPost(path, body) {
  const res = await fetch(API_BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "投稿に失敗しました");
  return data;
}

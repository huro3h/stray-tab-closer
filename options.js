import { DEFAULTS, getSettings, normalizeDomain } from "./rules.js";

const $ = (id) => document.getElementById(id);

const BOOKMARKS = { permissions: ["bookmarks"] };

// テキストエリアの1行1ドメイン。空行・重複・書式ゆれはここで吸収する。
function parseList(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const domain = normalizeDomain(line);
    if (domain && !out.includes(domain)) out.push(domain);
  }
  return out;
}

async function load() {
  const settings = await getSettings();
  $("sourceDomains").value = settings.sourceDomains.join("\n");
  $("allowDomains").value = settings.allowDomains.join("\n");
  $("watchAllSources").checked = settings.watchAllSources;
  // 設定だけ同期されてきて、この端末では権限が無い場合はオフとして見せる。
  $("allowBookmarked").checked =
    settings.allowBookmarked && (await chrome.permissions.contains(BOOKMARKS));
  $("graceSec").value = Math.round(settings.graceMs / 1000);
}

async function save() {
  const sourceDomains = parseList($("sourceDomains").value);
  const allowDomains = parseList($("allowDomains").value);
  const sec = Number($("graceSec").value);
  const graceMs = Number.isFinite(sec)
    ? Math.min(60, Math.max(1, Math.round(sec))) * 1000
    : DEFAULTS.graceMs;

  await chrome.storage.sync.set({
    sourceDomains,
    allowDomains,
    watchAllSources: $("watchAllSources").checked,
    allowBookmarked: $("allowBookmarked").checked,
    graceMs,
  });

  // 正規化した結果を画面に戻す。何が実際に保存されたかを見せるため。
  $("sourceDomains").value = sourceDomains.join("\n");
  $("allowDomains").value = allowDomains.join("\n");
  $("graceSec").value = graceMs / 1000;

  const status = $("status");
  status.textContent = "保存しました";
  setTimeout(() => (status.textContent = ""), 1800);
}

// permissions.request はユーザー操作の中でしか呼べないので、保存ボタンではなく
// チェックした瞬間に求める。断られたらチェックを戻す。
// オフにしたときは権限も返す (使わない権限を持ち続けない)。
$("allowBookmarked").addEventListener("change", async (e) => {
  const box = e.target;
  if (box.checked) {
    box.checked = await chrome.permissions.request(BOOKMARKS).catch(() => false);
  } else {
    await chrome.permissions.remove(BOOKMARKS).catch(() => {});
  }
});

$("save").addEventListener("click", save);
load();

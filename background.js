import {
  getSettings,
  decide,
  isWatchedSource,
  hostOf,
  registrableDomain,
  bookmarkedDomains,
} from "./rules.js";

const LOG_LIMIT = 20;

// ── ツールバーアイコン ───────────────────────────────────
// setIcon の path には getURL で解決した絶対URLを渡す。service worker から
// 相対パスを渡すと解決先が変わって "Failed to fetch" になることがある。
function iconSet(suffix) {
  return {
    16: chrome.runtime.getURL(`icons/icon16${suffix}.png`),
    32: chrome.runtime.getURL(`icons/icon32${suffix}.png`),
    48: chrome.runtime.getURL(`icons/icon48${suffix}.png`),
    128: chrome.runtime.getURL(`icons/icon128${suffix}.png`),
  };
}

const ICON_ON = iconSet("");
const ICON_OFF = iconSet("-off");

async function refreshActionIcon() {
  const { enabled } = await getSettings();
  chrome.action.setIcon({ path: enabled ? ICON_ON : ICON_OFF });
  chrome.action.setTitle({
    title: enabled ? "Stray Tab Closer — 監視中" : "Stray Tab Closer — 停止中",
  });
}

// ── 監視中のタブ ─────────────────────────────────────────
// tabId -> { openerUrl, createdAt }。開かれた直後の数秒だけ持つ一時的な状態。
// service worker は頻繁に落ちるので storage.session にミラーする
// (session はディスクに書かれず、ブラウザ終了で消える。タブ ID は
// セッションを跨ぐと無意味になるので session が正しい置き場所)。
let watching = null;

async function ensureWatching() {
  if (watching) return watching;
  const stored = await chrome.storage.session.get({ watching: {} });
  watching = stored.watching;
  return watching;
}

function persistWatching() {
  chrome.storage.session.set({ watching });
}

async function untrack(tabId) {
  const map = await ensureWatching();
  if (map[tabId] === undefined) return;
  delete map[tabId];
  persistWatching();
}

// ── 閉じたタブの記録 ─────────────────────────────────────
// 「勝手に閉じられた」で終わらせないための履歴。ポップアップから開き直せる。
async function recordClosed(entry) {
  const { closedLog = [], unseenCount = 0 } = await chrome.storage.session.get({
    closedLog: [],
    unseenCount: 0,
  });
  closedLog.unshift(entry);
  const next = unseenCount + 1;
  await chrome.storage.session.set({
    closedLog: closedLog.slice(0, LOG_LIMIT),
    unseenCount: next,
  });
  // バッジは「ポップアップで見ていない件数」。履歴の件数とは別に数える。
  chrome.action.setBadgeText({ text: String(next) });
  chrome.action.setBadgeBackgroundColor({ color: "#D93025" });
}

// ── ブックマーク ─────────────────────────────────────────
// bookmarks は任意権限。設定がオンでも、権限が無ければ (別の端末から設定だけ
// 同期されてきた場合など) 使わない。
// 判定のたびにツリー全体を辿らないよう、登録可能ドメインの Set をメモリに持ち、
// ブックマークが変わったら捨てる。SW が落ちれば消えるが、作り直すだけでよい。
let bookmarkCache = null;
let bookmarkListening = false;

function invalidateBookmarks() {
  bookmarkCache = null;
}

function listenBookmarks() {
  if (bookmarkListening || !chrome.bookmarks) return;
  bookmarkListening = true;
  for (const event of ["onCreated", "onRemoved", "onChanged", "onImportEnded"]) {
    chrome.bookmarks[event].addListener(invalidateBookmarks);
  }
}

async function getBookmarked(settings) {
  if (!settings.allowBookmarked) return null;
  if (!(await chrome.permissions.contains({ permissions: ["bookmarks"] }))) return null;
  listenBookmarks();
  if (bookmarkCache) return bookmarkCache;

  const urls = [];
  const walk = (nodes) => {
    for (const node of nodes) {
      if (node.url) urls.push(node.url);
      if (node.children) walk(node.children);
    }
  };
  walk(await chrome.bookmarks.getTree());
  bookmarkCache = bookmarkedDomains(urls);
  return bookmarkCache;
}

chrome.permissions.onAdded.addListener(invalidateBookmarks);
chrome.permissions.onRemoved.addListener(invalidateBookmarks);
listenBookmarks();

// ── 判定と実行 ───────────────────────────────────────────
async function evaluate(tabId, url, status) {
  const map = await ensureWatching();
  const entry = map[tabId];
  if (!entry) return;

  const settings = await getSettings();
  if (!settings.enabled) {
    untrack(tabId);
    return;
  }

  // 開かれた直後の判定だけに限定する。これが無いと、残したタブの中で
  // ユーザーが後から踏んだ別ドメインへのリンクまで閉じてしまう。
  if (Date.now() - entry.createdAt > settings.graceMs) {
    untrack(tabId);
    return;
  }

  const bookmarked = await getBookmarked(settings);
  const { action, reason } = decide(url, entry.openerUrl, settings, bookmarked);

  if (action === "close") {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.pinned) {
      untrack(tabId);
      return;
    }
    // 手前に出てきたタブを閉じたときだけ、ジャンプ元へ戻す。裏で開いたタブなら
    // ユーザーは別の場所を見ているので、フォーカスを動かさない。
    const stoleFocus = tab.active;
    await untrack(tabId);
    await chrome.tabs.remove(tabId).catch(() => {});
    if (stoleFocus) await restoreOpener(entry.openerTabId);
    await recordClosed({
      url,
      host: hostOf(url),
      domain: registrableDomain(hostOf(url)),
      openerUrl: entry.openerUrl,
      openerHost: hostOf(entry.openerUrl),
      at: Date.now(),
    });
    return;
  }

  // 読み込みが終わった時点で残す判断になっているなら、そこから先はユーザーの操作。
  // about:blank は complete を通過するので、"wait" のうちは監視を続ける
  // (window.open('') してから location を書き換える広告を取り逃さないため)。
  if (action === "keep" && status === "complete") {
    untrack(tabId);
  }
}

// 閉じたあとにジャンプ元のタブへ戻す。Chrome も隣のタブを選び直すが、広告が
// 別ウィンドウで開いた場合など、必ずしも元の場所には戻らないため明示的に指定する。
async function restoreOpener(openerTabId) {
  if (openerTabId === undefined) return;
  const opener = await chrome.tabs.get(openerTabId).catch(() => null);
  if (!opener) return;
  await chrome.tabs.update(openerTabId, { active: true }).catch(() => {});
  await chrome.windows.update(opener.windowId, { focused: true }).catch(() => {});
}

// ── タブの発生を捕まえる ─────────────────────────────────
chrome.tabs.onCreated.addListener(async (tab) => {
  // openerTabId が無いタブ = ユーザーが自分で開いた新しいタブ。対象外。
  if (tab.openerTabId === undefined) return;

  const settings = await getSettings();
  if (!settings.enabled) return;

  const opener = await chrome.tabs.get(tab.openerTabId).catch(() => null);
  const openerUrl = opener?.url;
  if (!isWatchedSource(openerUrl, settings)) return;

  const map = await ensureWatching();
  map[tab.id] = { openerUrl, openerTabId: tab.openerTabId, createdAt: Date.now() };
  persistWatching();

  // onCreated の時点で行き先が入っていることがある (target=_blank のリンクなど)。
  evaluate(tab.id, tab.pendingUrl || tab.url, tab.status);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url === undefined && changeInfo.status === undefined) return;
  evaluate(tabId, tab.url || tab.pendingUrl, changeInfo.status ?? tab.status);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  untrack(tabId);
});

// ── ポップアップからの操作 ───────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "clearBadge") {
    chrome.action.setBadgeText({ text: "" });
    chrome.storage.session.set({ unseenCount: 0 });
    sendResponse({ ok: true });
  }
  return false;
});

// ── 状態の同期 ───────────────────────────────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.enabled) refreshActionIcon();
});

// 既定値は getSettings() の chrome.storage.sync.get(DEFAULTS) が毎回補うので、
// インストール時に storage へ書き込む必要はない。書き込むと、直後にユーザーや
// 別コンテキストが行う設定変更と競合して上書きしてしまう。
chrome.runtime.onInstalled.addListener(refreshActionIcon);
chrome.runtime.onStartup.addListener(refreshActionIcon);

// service worker は落ちて起き直るので、起き直すたびに現在の状態へ揃える。
refreshActionIcon();

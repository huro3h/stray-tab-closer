import { DEFAULTS, getSettings, hostOf, isHttpUrl, registrableDomain, domainMatches } from "./rules.js";

const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULTS };
let currentDomain = null;

// バッジは「見ていない件数」なので、ポップアップを開いた時点で消す。
chrome.runtime.sendMessage({ type: "clearBadge" }).catch(() => {});

async function load() {
  settings = await getSettings();
  $("enabled").checked = settings.enabled;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // 新しいタブや chrome-extension:// のページはドメインを持たない扱いにする
  // (拡張ID や "newtab" を監視対象として登録できてしまうため)。
  currentDomain = isHttpUrl(tab?.url) ? registrableDomain(hostOf(tab?.url)) : null;
  renderSite(hostOf(tab?.url));
  await renderLog();
}

// ── 現在のサイトを監視対象にするトグル ───────────────────
function renderSite(host) {
  const box = $("watchThisSite");
  const state = $("siteState");

  if (settings.watchAllSources) {
    box.checked = true;
    box.disabled = true;
    state.textContent = "詳細設定で「すべてのサイトを監視」が有効です。";
    return;
  }

  if (!currentDomain) {
    box.checked = false;
    box.disabled = true;
    state.textContent = "このページは対象にできません (http/https のみ)。";
    return;
  }

  const matched = settings.sourceDomains.filter((p) => domainMatches(host, p));
  const wildcards = matched.filter((p) => p.includes("*"));

  // ワイルドカード経由で監視されている場合、ここで外すと他のサイトまで巻き込む。
  // トグルは無効にして、詳細設定へ誘導する。
  if (wildcards.length) {
    box.checked = true;
    box.disabled = true;
    state.textContent = `${wildcards.join(" / ")} で監視中。解除は詳細設定から。`;
    return;
  }

  box.disabled = false;
  box.checked = matched.length > 0;
  state.textContent = box.checked
    ? `${currentDomain} から開かれたタブを監視します。`
    : `${currentDomain} は監視していません。`;
}

$("watchThisSite").addEventListener("change", async (e) => {
  if (!currentDomain) return;
  const set = new Set(settings.sourceDomains);
  if (e.target.checked) set.add(currentDomain);
  else {
    // サブドメイン指定で登録されている場合も含めて、一致する記述を全部外す。
    // ワイルドカードはここには来ない (トグルを無効にしてある)。
    for (const p of set) {
      if (p.includes("*")) continue;
      if (domainMatches(currentDomain, p) || domainMatches(p, currentDomain)) set.delete(p);
    }
  }
  settings.sourceDomains = [...set];
  await chrome.storage.sync.set({ sourceDomains: settings.sourceDomains });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  renderSite(hostOf(tab?.url));
});

$("enabled").addEventListener("change", async (e) => {
  settings.enabled = e.target.checked;
  await chrome.storage.sync.set({ enabled: settings.enabled });
});

// ── 閉じたタブの履歴 ─────────────────────────────────────
function timeLabel(at) {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

async function renderLog() {
  const { closedLog = [] } = await chrome.storage.session.get({ closedLog: [] });
  const list = $("log");
  list.textContent = "";
  $("logEmpty").hidden = closedLog.length > 0;
  $("clearLog").hidden = closedLog.length === 0;

  for (const entry of closedLog) {
    const li = document.createElement("li");

    const host = document.createElement("span");
    host.className = "host";
    host.textContent = `${timeLabel(entry.at)}  ${entry.host ?? entry.url}`;
    host.title = entry.url;
    li.append(host);

    const from = document.createElement("span");
    from.className = "from";
    from.textContent = `← ${entry.openerHost ?? "不明"}`;
    li.append(from);

    const actions = document.createElement("div");
    actions.className = "actions";

    const reopen = document.createElement("button");
    reopen.className = "link";
    reopen.textContent = "開き直す";
    reopen.addEventListener("click", () => {
      chrome.tabs.create({ url: entry.url });
      window.close();
    });
    actions.append(reopen);

    if (entry.domain) {
      const allow = document.createElement("button");
      allow.className = "link";
      allow.textContent = "今後は許可";
      allow.addEventListener("click", async () => {
        const set = new Set(settings.allowDomains);
        set.add(entry.domain);
        settings.allowDomains = [...set];
        await chrome.storage.sync.set({ allowDomains: settings.allowDomains });
        allow.textContent = "許可しました";
        allow.disabled = true;
      });
      actions.append(allow);
    }

    li.append(actions);
    list.append(li);
  }
}

$("clearLog").addEventListener("click", async () => {
  await chrome.storage.session.set({ closedLog: [] });
  renderLog();
});

$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

load();

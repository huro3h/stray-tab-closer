import { DEFAULTS, getSettings, normalizeDomain } from "./rules.js";

const $ = (id) => document.getElementById(id);

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

$("save").addEventListener("click", save);
load();

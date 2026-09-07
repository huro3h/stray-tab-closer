// 設定のデフォルトと、「この新しいタブを閉じてよいか」の判定。
// background / popup / options の3か所から読むので chrome API に依存させない
// (Node から直接 import して単体テストできる状態を保つ)。

export const DEFAULTS = {
  enabled: true,
  // ジャンプ元(監視対象)のドメイン。ここに挙げたページから開かれたタブだけを判定する。
  // 空のまま watchAllSources が false なら、拡張は何もしない。
  sourceDomains: [],
  // ジャンプ元を限定せず、どのページから開かれたタブも判定対象にする。
  watchAllSources: false,
  // 行き先の許可リスト。ジャンプ元と別ドメインでも、ここに一致すれば閉じない。
  allowDomains: [],
  // タブが開かれてから何ミリ秒までを「開かれた直後」とみなすか。
  // この時間を過ぎたタブは、以後どこへ遷移しても触らない。
  graceMs: 10000,
};

export async function getSettings() {
  return chrome.storage.sync.get(DEFAULTS);
}

// ── パターンの正規化 ─────────────────────────────────────
// 設定欄には URL を貼られることもテキストを打たれることもあるので、
// どちらもホスト名だけに寄せる。ワイルドカード `*` はそのまま残す。
export function normalizeDomain(input) {
  if (typeof input !== "string") return null;
  let s = input.trim().toLowerCase();
  if (!s || s.startsWith("#")) return null;

  // スキームが書かれている場合、http(s) 以外は受け付けない。
  // chrome-extension://<id>/… や chrome://newtab を貼られると、ホスト部
  // (拡張ID や "newtab") がドメインとして登録されてしまうため。
  // これらは判定側でも常に対象外なので、設定に入っても混乱を生むだけ。
  const scheme = s.match(/^([a-z][a-z0-9+.-]*):/);
  if (scheme && !/^https?$/.test(scheme[1])) return null;

  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // スキーム
  s = s.replace(/^[^/@]*@/, ""); // user:pass@
  s = s.split(/[/?#]/)[0]; // パス以降
  s = s.replace(/:\d+$/, ""); // ポート
  s = s.replace(/^\.+/, "").replace(/\.+$/, ""); // 前後のドット
  s = s.replace(/\*{2,}/g, "*"); // ** は * と同じ
  if (!s || s === "*") return null; // 全ホスト一致は watchAllSources でやること
  if (!/^[a-z0-9.*-]+$/.test(s)) return null;
  return s;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

// ── 登録可能ドメイン (eTLD+1) の簡易判定 ───────────────────
// 拡張から公開サフィックスリスト (PSL) を引く API は無いので自前の近似。
// 完全一致を求める用途ではなく「同一サイトとみなすか」の判定なので、
// ずれた場合は許可リストで拾えばよい、という割り切り。

// 2文字 ccTLD の直前に来たらサフィックスの一部とみなすラベル。
// 例: co.jp / ne.jp / com.br / co.uk / ac.uk
const SECOND_LEVEL = new Set([
  "co", "com", "ne", "net", "or", "org", "ac", "ad", "ed", "go", "gr", "lg",
  "gov", "edu", "mil", "int", "biz", "info", "name", "sch", "nom", "gen",
  "firm", "ind", "res", "web", "plc", "ltd", "me", "tv", "in", "k12",
]);

// ccTLD の規則では拾えない、実質サフィックスとして扱いたいホスティング。
const MULTI_SUFFIX = new Set([
  "github.io", "gitlab.io", "pages.dev", "workers.dev", "vercel.app",
  "netlify.app", "herokuapp.com", "web.app", "firebaseapp.com",
  "appspot.com", "blogspot.com", "s3.amazonaws.com", "cloudfront.net",
]);

export function registrableDomain(host) {
  if (!host) return null;
  // IP アドレスとホスト名1つだけ (localhost 等) はそのまま
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) return host;
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 1) return host;

  for (let i = 1; i < parts.length - 1; i++) {
    if (MULTI_SUFFIX.has(parts.slice(i).join("."))) {
      return parts.slice(i - 1).join(".");
    }
  }

  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  if (parts.length >= 3 && tld.length === 2 && SECOND_LEVEL.has(sld)) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

export function isSameDomain(urlA, urlB) {
  const a = registrableDomain(hostOf(urlA));
  const b = registrableDomain(hostOf(urlB));
  return a !== null && a === b;
}

// パターンの書き方は2通り。
//
//   ワイルドカード無し … そのドメイン自身とサブドメインに一致 (従来どおり)
//     example.com    →  example.com / www.example.com / a.b.example.com
//
//   `*` を含む       … `*` を「任意の文字列 (ドットを含む)」としてホスト名全体に一致
//     *.example.com  →  www.example.com / a.b.example.com  (example.com 自身は不一致)
//     *example.com   →  example.com / notexample.com       (前方の部分一致)
//     *ad*           →  ads.foo.com / foo.adnet.jp         (部分一致)
//     news.*.co.jp   →  news.a.co.jp
//
// ワイルドカード無しを「サブドメインも含む」ままにしてあるのは、既存の設定と
// 「ドメインを1つ書けば済む」直感を壊さないため。厳密に絞りたいときは `*` を使う。
const globCache = new Map();

function globToRegExp(pattern) {
  let re = globCache.get(pattern);
  if (re) return re;
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  re = new RegExp(`^${source}$`);
  globCache.set(pattern, re);
  return re;
}

export function domainMatches(host, pattern) {
  if (!host || !pattern) return false;
  if (pattern.includes("*")) return globToRegExp(pattern).test(host);
  return host === pattern || host.endsWith(`.${pattern}`);
}

export function matchesAny(url, patterns) {
  const host = hostOf(url);
  if (!host) return false;
  return patterns.some((p) => domainMatches(host, p));
}

// ── 判定 ─────────────────────────────────────────────────

// 遷移の途中状態。まだ行き先が確定していないので結論を出さない。
const BLANK_URL = /^(about:|chrome:\/\/newtab|chrome:\/\/new-tab-page)/i;

// 判定対象にするスキーム。chrome:// や拡張ページを閉じにいくことはしない。
const TARGET_SCHEME = /^https?:$/i;

// http(s) のページか。chrome-extension:// / chrome://newtab / file:// などは
// ジャンプ元にも行き先にもならないので、UI 側もこれで足切りする。
export function isHttpUrl(url) {
  try {
    return TARGET_SCHEME.test(new URL(url).protocol);
  } catch {
    return false;
  }
}

// ジャンプ元として監視するページか。
export function isWatchedSource(openerUrl, settings) {
  const host = hostOf(openerUrl);
  if (!host) return false;
  if (!isHttpUrl(openerUrl)) return false;
  if (settings.watchAllSources) return true;
  return settings.sourceDomains.some((p) => domainMatches(host, p));
}

// 開かれた直後のタブをどう扱うか。
//   "close" 閉じる / "keep" 見逃す (以後このタブは触らない) / "wait" まだ決めない
export function decide(targetUrl, openerUrl, settings) {
  if (!targetUrl || BLANK_URL.test(targetUrl)) return { action: "wait" };

  // chrome-extension:// や chrome:// のページは閉じにいかない。
  if (!isHttpUrl(targetUrl)) return { action: "keep", reason: "scheme" };

  // ジャンプ元が分からない (タブが閉じられた等) なら判断材料が無いので残す。
  if (!hostOf(openerUrl)) return { action: "keep", reason: "no-opener" };

  if (isSameDomain(targetUrl, openerUrl)) {
    return { action: "keep", reason: "same-domain" };
  }
  if (matchesAny(targetUrl, settings.allowDomains)) {
    return { action: "keep", reason: "allowed" };
  }
  return { action: "close", reason: "stray" };
}

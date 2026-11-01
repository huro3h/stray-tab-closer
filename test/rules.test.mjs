// rules.js は chrome API に触れないので Node から直接読める。
// node --test test/rules.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS,
  isHttpUrl,
  normalizeDomain,
  registrableDomain,
  isSameDomain,
  domainMatches,
  isWatchedSource,
  decide,
  bookmarkedDomains,
} from "../rules.js";

const settings = (over = {}) => ({ ...DEFAULTS, ...over });

test("normalizeDomain: ワイルドカードは残す", () => {
  assert.equal(normalizeDomain("*.example.com"), "*.example.com");
  assert.equal(normalizeDomain("HTTPS://*.Example.com/path"), "*.example.com");
  assert.equal(normalizeDomain("*ad*"), "*ad*");
  assert.equal(normalizeDomain("**ad**"), "*ad*");
  // 全ホスト一致は watchAllSources でやるべきなので受け付けない
  assert.equal(normalizeDomain("*"), null);
});

test("domainMatches: ワイルドカードと部分一致", () => {
  // サブドメインのみ (ドメイン自身は含まない)
  assert.ok(domainMatches("www.example.com", "*.example.com"));
  assert.ok(domainMatches("a.b.example.com", "*.example.com"));
  assert.ok(!domainMatches("example.com", "*.example.com"));
  // 部分一致
  assert.ok(domainMatches("ads.foo.com", "*ad*"));
  assert.ok(domainMatches("foo.adnet.jp", "*ad*"));
  assert.ok(!domainMatches("foo.example.com", "*ad*"));
  // 途中のワイルドカード
  assert.ok(domainMatches("news.a.co.jp", "news.*.co.jp"));
  assert.ok(!domainMatches("news.co.jp", "news.*.co.jp"));
  // 正規表現のメタ文字はエスケープされる
  assert.ok(!domainMatches("aXbexample.com", "a.b*"));
  assert.ok(domainMatches("a.bexample.com", "a.b*"));
});

test("normalizeDomain: URL でもホスト名でも同じ結果になる", () => {
  for (const input of [
    "example.com",
    " Example.COM ",
    "https://example.com/path?q=1",
    "http://user:pw@example.com:8080/",
    ".example.com.",
  ]) {
    assert.equal(normalizeDomain(input), "example.com", input);
  }
  assert.equal(normalizeDomain(""), null);
  assert.equal(normalizeDomain("# コメント"), null);
  assert.equal(normalizeDomain("日本語"), null);
});

test("registrableDomain: 多段サフィックスを吸収する", () => {
  assert.equal(registrableDomain("www.example.com"), "example.com");
  assert.equal(registrableDomain("a.b.example.co.jp"), "example.co.jp");
  assert.equal(registrableDomain("shop.example.co.uk"), "example.co.uk");
  assert.equal(registrableDomain("example.com"), "example.com");
  assert.equal(registrableDomain("localhost"), "localhost");
  assert.equal(registrableDomain("127.0.0.1"), "127.0.0.1");
  // ホスティングはユーザーごとに別サイト扱い
  assert.equal(registrableDomain("me.github.io"), "me.github.io");
});

test("isSameDomain: サブドメイン違いは同一サイト", () => {
  assert.ok(isSameDomain("https://www.example.com/a", "https://shop.example.com/b"));
  assert.ok(!isSameDomain("https://example.com", "https://example.net"));
  // http/https の違いはドメイン判定では無視する
  assert.ok(isSameDomain("http://example.com", "https://example.com"));
});

test("domainMatches: サブドメインまで含む", () => {
  assert.ok(domainMatches("www.example.com", "example.com"));
  assert.ok(domainMatches("example.com", "example.com"));
  assert.ok(!domainMatches("notexample.com", "example.com"));
  assert.ok(!domainMatches("example.com", "www.example.com"));
});

test("normalizeDomain: http(s) 以外のスキームは受け付けない", () => {
  // ホスト部が拡張IDや "newtab" になってドメイン扱いされるのを防ぐ
  assert.equal(normalizeDomain("chrome-extension://abcdefghij/page.html"), null);
  assert.equal(normalizeDomain("chrome://newtab"), null);
  assert.equal(normalizeDomain("about:blank"), null);
  assert.equal(normalizeDomain("file:///Users/me/a.html"), null);
  assert.equal(normalizeDomain("https://example.com/x"), "example.com");
});

test("isHttpUrl: http(s) だけを対象にする", () => {
  assert.ok(isHttpUrl("http://example.com"));
  assert.ok(isHttpUrl("https://example.com"));
  assert.ok(!isHttpUrl("chrome-extension://abc/page.html"));
  assert.ok(!isHttpUrl("chrome://newtab"));
  assert.ok(!isHttpUrl("file:///a/b.html"));
  assert.ok(!isHttpUrl(undefined));
});

test("chrome-extension / 新しいタブ はジャンプ元にも行き先にもならない", () => {
  const all = settings({ watchAllSources: true });
  assert.ok(!isWatchedSource("chrome-extension://abcdefghij/newtab.html", all));
  assert.ok(!isWatchedSource("chrome://newtab", all));

  const from = "https://example.com/watch";
  // 行き先が拡張ページ → 触らない
  assert.equal(decide("chrome-extension://abcdefghij/x.html", from, all).action, "keep");
  // 新しいタブページ → 結論を出さない (遷移途中の可能性がある)
  assert.equal(decide("chrome://newtab", from, all).action, "wait");
});

test("isWatchedSource: ワイルドカード指定も効く", () => {
  const s = settings({ sourceDomains: ["*matome*"] });
  assert.ok(isWatchedSource("https://matome.example.jp/1", s));
  assert.ok(isWatchedSource("https://www.example-matome.com/", s));
  assert.ok(!isWatchedSource("https://example.com/", s));
});

test("decide: 許可リストのワイルドカードも効く", () => {
  const s = settings({ allowDomains: ["*.google.com"] });
  const from = "https://example.com/watch";
  assert.equal(decide("https://accounts.google.com/x", from, s).action, "keep");
  assert.equal(decide("https://google.com/x", from, s).action, "close");
});

test("isWatchedSource: リストに無いジャンプ元は監視しない", () => {
  const s = settings({ sourceDomains: ["example.com"] });
  assert.ok(isWatchedSource("https://news.example.com/a", s));
  assert.ok(!isWatchedSource("https://other.com/a", s));
  assert.ok(!isWatchedSource(undefined, s));
  // 拡張ページや chrome:// はジャンプ元にしない
  assert.ok(!isWatchedSource("chrome://newtab", s));

  const all = settings({ watchAllSources: true });
  assert.ok(isWatchedSource("https://other.com/a", all));
  assert.ok(!isWatchedSource("chrome://newtab", all));
});

test("decide: 同一ドメインと許可リストは残す", () => {
  const s = settings({ allowDomains: ["accounts.google.com"] });
  const from = "https://example.com/watch";

  assert.equal(decide("https://shop.example.com/x", from, s).action, "keep");
  assert.equal(decide("https://accounts.google.com/signin", from, s).action, "keep");
  assert.equal(decide("https://ad-network.example.net/click", from, s).action, "close");
});

test("decide: 行き先が確定していない間は結論を出さない", () => {
  const from = "https://example.com/watch";
  assert.equal(decide(undefined, from, settings()).action, "wait");
  assert.equal(decide("about:blank", from, settings()).action, "wait");
  assert.equal(decide("chrome://newtab", from, settings()).action, "wait");
});

test("decide: 判断材料が無いときは残す", () => {
  // ジャンプ元が取れない (元タブが閉じられた等)
  assert.equal(decide("https://ad.example.net/", undefined, settings()).action, "keep");
  // http(s) 以外は触らない
  assert.equal(
    decide("chrome-extension://abc/page.html", "https://example.com", settings()).action,
    "keep",
  );
});

test("bookmarkedDomains: http(s) だけを登録可能ドメインにまとめる", () => {
  const set = bookmarkedDomains([
    "https://www.example.com/a",
    "http://shop.example.co.jp/",
    "chrome://settings",
    "javascript:alert(1)",
    "file:///a.html",
  ]);
  assert.deepEqual([...set].sort(), ["example.co.jp", "example.com"]);
});

test("decide: ブックマークにあるサイトは残す", () => {
  const from = "https://matome.example.jp/1";
  const bookmarked = bookmarkedDomains(["https://www.shop.com/"]);
  // サブドメイン違いも同じサイトとして残す
  assert.equal(decide("https://sale.shop.com/x", from, settings(), bookmarked).action, "keep");
  assert.equal(decide("https://ads.example.net/", from, settings(), bookmarked).action, "close");
  // 渡さなければ従来どおり
  assert.equal(decide("https://sale.shop.com/x", from, settings()).action, "close");
});

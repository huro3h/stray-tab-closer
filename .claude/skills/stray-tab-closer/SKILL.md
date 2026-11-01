---
name: stray-tab-closer
description: Stray Tab Closer (広告などで勝手に開く別ドメインのタブを自動で閉じる Chrome 拡張) を改修・デバッグするときに使う。タブの捕まえ方、誤爆を防ぐ猶予の設計、却下した実装案、テスト手順を記録している。
---

# Stray Tab Closer 開発メモ

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `background.js` | service worker。新しいタブの監視・判定・クローズ・履歴 |
| `rules.js` | 設定のデフォルトとドメイン判定。chrome API に依存しない (Node から単体テストする) |
| `popup.*` | ツールバーUI。オン/オフ、表示中サイトの監視トグル、閉じたタブの履歴 |
| `options.*` | 監視対象・許可リスト・猶予秒数の編集。`options.css` は `popup.css` を `@import` している |
| `icons/icon.svg` | アイコンの原本 (タブ枠に×)。OFF はここから色だけ差し替えて生成する |

## 中心にある設計判断

### 「ジャンプ元」を設定に持たせたのが要件の核

初期の相談は「別ドメインのタブが開いたら閉じる」だったが、そのままだと外部リンクを
すべて巻き込む。ユーザーからの追加要望で **ジャンプ元 (openerTabId のタブ) のドメインを
設定できる** 形にした。結果、既定値は「何もしない」に近く、広告が出るサイトを
明示的に登録して初めて動く。安全側に倒れているのが正しい。

`watchAllSources` は「全サイトで有効」の逃げ道として残してあるが既定はオフ。

### 判定は3層

`rules.js` の `decide()` が `"close" | "keep" | "wait"` を返す。

- **`wait`** — `about:blank` / `chrome://newtab` / URL 未確定。まだ結論を出さない。
  `window.open('')` してから `location` を書き換える広告があるため、ここで
  `keep` を返すと取り逃がす。実機テストで再現・確認済み。
- **`keep`** — 同一ドメイン / 許可リスト / `http(s)` 以外のスキーム / ジャンプ元不明。
  ジャンプ元が取れないときに閉じないのは重要 (元タブが先に閉じられた場合など、
  判断材料が無い状態で閉じにいかない)。
- **`close`** — それ以外。

### 閉じたあとフォーカスをどうするか

閉じたタブが**手前に出ていたときだけ** `restoreOpener()` でジャンプ元のタブを
`active: true` にし、そのウィンドウを `focused: true` にする。判定は
`chrome.tabs.remove()` を呼ぶ前に読んだ `tab.active`。

Chrome も閉じたタブの隣を選び直すので同一ウィンドウなら大抵は元に戻るが、
**広告が別ウィンドウ (ポップアップ) で開いた場合**はタブを閉じるとウィンドウごと
消え、どこにフォーカスが行くかは保証されない。明示的に戻している理由はここ。

裏で開かれたタブでは**何もしない**。ユーザーは別の場所を見ているので、
そこへフォーカスを飛ばすと拡張の方が邪魔になる。`chrome.windows` は
permission 不要なので、この機能で権限は増えていない。

### 誤爆を防ぐ二重の打ち切り

タブ ID で監視しているので、**残したタブの中でユーザーが後から踏んだリンク**まで
判定してしまう危険がある。次の2つで打ち切る。

1. `graceMs` (既定10秒) 経過で監視をやめる
2. `keep` の判断のまま `status === "complete"` に達したら監視をやめる

2 が主で、1 は保険。`about:blank` も `complete` を通過するので、**`wait` のうちは
2 を発動させない**のがポイント (これを間違えると `window.open('')` 型の広告を全部逃す)。

取り逃がすケース: `complete` に達した後で JS が別ドメインへ飛ばす広告。
誤爆を減らす方を優先した結果であり、意図通り。

### webNavigation ではなく tabs API

`pinned-tab-lock` は `webNavigation` を使っているが、この拡張は
**`tabs.onCreated` + `tabs.onUpdated`** で足りる。`webNavigation` を使うと
`host_permissions: ["<all_urls>"]` が必須になるため、権限を
`["tabs", "storage"]` だけに抑えられるこちらを選んだ。`tabs` 権限があれば
`tab.url` / `tab.pendingUrl` は読める。

`onCreated` の時点で `pendingUrl` が入っていることがある (target=_blank のリンク)
ので、そこでも一度 `evaluate()` している。

### service worker が落ちる前提の状態管理

監視中のタブは メモリ上の `watching` を主に使い `chrome.storage.session` にミラー。
`session` はディスクに書かれずブラウザ終了で消えるので、タブ ID の置き場所として正しい。
閉じたタブの履歴 (`closedLog`) とバッジ用の `unseenCount` も同じく `session`。
履歴を永続化しないのは、閉じた URL がディスクに残る方が嫌だろうという判断。

### `onInstalled` で既定値を storage に書かない (踏んだ罠)

初版は `onInstalled` で「未設定のキーだけ DEFAULTS で埋める」処理を入れていたが、
`storage.sync.get(null)` → `set()` の間に別コンテキストの設定変更が挟まると
**それを上書きして消す**。E2E の1回目で `sourceDomains` が空に戻る形で再現した。

`getSettings()` が `chrome.storage.sync.get(DEFAULTS)` で毎回既定値を補うので、
**そもそも書き込む必要が無い**。`onInstalled` はアイコンの初期化だけにした。

### ドメインのパターン記法

`domainMatches(host, pattern)` の仕様は2系統。

- **`*` を含まない** … 完全一致 + サブドメイン (`example.com` → `www.example.com` も)
- **`*` を含む** … `*` を「任意の文字列 (ドットを含む)」としてホスト名全体にマッチ

`*` 無しをサブドメイン込みのままにしたのは、既存の設定と「ドメインを1つ書けば済む」
直感を壊さないため。厳密に絞りたい人が `*.example.com` (サブドメインのみ) や
`*ad*` (部分一致) を書けばよい、という切り分け。

実装は glob → 正規表現。`*` で split して各パートを正規表現エスケープし `.*` で
連結する。**エスケープを忘れるとパターン中の `.` が任意文字になって誤爆する**
(`a.b*` が `aXbexample.com` に当たらないことを単体テストで固定してある)。
コンパイル結果は `globCache` に持つ。タブが開くたびに評価されるため。

`normalizeDomain()` は `*` を残すよう変更した。以前は `*.` を剥がしていたので、
そのままだと `*.example.com` が `example.com` に化ける。素通しの `*` 単独だけは
`null` にして弾く (全ホスト一致は `watchAllSources` でやること)。

ポップアップの「このサイトを監視する」トグルは、**ワイルドカード経由で監視されている
ときは無効化**して詳細設定へ誘導する。ここで外すと `*ad*` のような広いパターンごと
消えて他のサイトまで巻き込むため。

### http(s) 以外を設定に入れさせない

判定側 (`isWatchedSource` / `decide`) は最初から `http(s)` 以外を対象外にしていたが、
**設定に入る経路が塞がっていなかった**。

- ポップアップの「このサイトを監視する」は `registrableDomain(hostOf(tab.url))` を
  そのまま登録していたので、拡張ページを開いた状態だと**拡張ID**が、新しいタブでは
  **`newtab`** がドメインとして登録できてしまう
- 詳細設定に `chrome-extension://<id>/…` を貼ると、`normalizeDomain()` がスキームを
  剥がして同じくホスト部だけ残す

どちらも判定側で使われることは無い (常に対象外) が、設定画面に意味のない行が残るのは
混乱のもとなので入口で塞いだ。`isHttpUrl()` を rules.js から export し、
ポップアップの足切りと `normalizeDomain()` のスキーム検査の両方で使っている。

`normalizeDomain()` は**スキームが書かれている場合だけ**検査する。`newtab` のように
スキーム無しで打たれた文字列は普通のホスト名と区別できないので通すが、
`http(s)` のホストとしか照合されないので実害は無い。

### ブックマークの除外は任意権限にした

「ブックマークにあるサイトは閉じない」(`allowBookmarked`) は `bookmarks` 権限が要る。
必須にするとインストール時に「ブックマークの読み取りと変更」の警告が出て、
`["tabs", "storage"]` に抑えてきた方針が崩れるので **`optional_permissions`** にし、
詳細設定でチェックした瞬間に `permissions.request()` する (ユーザー操作の中でしか
呼べないので保存ボタンではない)。オフにしたら `permissions.remove()` で返す。

- 判定の粒度は同一ドメイン判定と同じ eTLD+1。`www.shop.com` をブックマークしていれば
  `sale.shop.com` へのタブも残る。`decide()` の第4引数に `bookmarkedDomains()` の Set を渡す
- background はドメインの Set をメモリにキャッシュし、`bookmarks.on*` と
  `permissions.on*` で捨てる。SW が落ちたら作り直すだけ
- 設定は sync で他端末に行くが権限は行かない。だから**設定値と権限の両方**を見る
  (`getBookmarked()` / 詳細設定の表示)

## 設定

`rules.js` の `DEFAULTS` が唯一の定義。`sourceDomains` / `watchAllSources` /
`allowDomains` / `allowBookmarked` / `graceMs` / `enabled`。

ドメイン設定は `normalizeDomain()` で URL でもホスト名でも受ける (貼り付けた URL が
そのまま通る)。マッチは `domainMatches()` = 完全一致 + サブドメイン。

## eTLD+1 の簡易判定

拡張から公開サフィックスリストを引く API は無いので `registrableDomain()` は近似:

- `MULTI_SUFFIX` — `github.io` `pages.dev` など、ユーザーごとに別サイトとして扱いたいホスティング
- `SECOND_LEVEL` + 2文字 ccTLD — `co.jp` `ne.jp` `co.uk` `com.br` などを吸収

ずれても許可リストで拾えるので完全性は追わない、という割り切り。
`pinned-tab-lock` は同じ理由でドメイン判定そのものを捨てて `scheme://host` の完全一致に
したが、こちらは**サブドメイン違いを同一サイト扱いしたい**ので採用している
(`www` → `shop` へ飛ぶ正規のリンクを閉じたくない)。

## アイコン

タブ枠に × の線画。`pinned-tab-lock` / `yt-live-helper` に合わせて **fill を使わず
stroke だけ**で描き、**色でオン/オフを表す** (オン `#1A73E8` / オフ `#6E6E6E`)。
SVG は1枚だけ持ち、OFF は色を置換して書き出す。

```bash
for s in 16 32 48 128; do
  rsvg-convert -w $s -h $s icons/icon.svg -o icons/icon$s.png
  sed 's/#1A73E8/#6E6E6E/g' icons/icon.svg | rsvg-convert -w $s -h $s -o icons/icon$s-off.png
done
```

`chrome.action.setIcon` の `path` には `chrome.runtime.getURL()` の絶対URLを渡す
(service worker から相対パスを渡すと "Failed to fetch" になることがある)。
`refreshActionIcon()` は **SW の起動ごとに毎回呼ぶ** — イベント経由だけだと
SW が落ちて起き直したときに状態とアイコンがずれる。

## テスト

### 判定ロジックの単体テスト

`rules.js` は chrome API に触れないので Node から直接 import できる。

```bash
node --test test/rules.test.mjs
```

### 実機テスト (Playwright + Brave Browser Nightly)

ワークスペース共通の `browser-testing` skill に従う。リリース版 Chrome は
`--load-extension` を無視するので使わない。ドライバスクリプトはスクラッチパッドに置く。

要点:

- 別ドメインの用意にネットワークは不要。`http.createServer` を `0.0.0.0` に1つ立て、
  **`localhost` と `127.0.0.1` を別ドメインとして使い分ける**
  (`registrableDomain()` はどちらもそのまま返すので別サイト扱いになる)
- 設定の投入は service worker 経由:
  `sw.evaluate((v) => chrome.storage.sync.set(v), settings)`
- 閉じられたかの判定は `context.waitForEvent('page')` で掴んだ Page の `isClosed()`。
  クリック後 2.5 秒ほど待ってから見る
- `chrome.storage.session` の中身も `sw.evaluate()` で読める (履歴の検証に使う)
- **`chrome.tabs.create({ openerTabId })` で広告タブを再現してはいけない。**
  こうして作ったタブは `tabs.onCreated` イベントの時点で `openerTabId` が
  `undefined` になる (あとから `tabs.query` すると入っている)。拡張は
  `onCreated` の `openerTabId` で対象を決めるので、テストだけが素通りして
  「閉じない」と誤診する。裏で開くタブは**中クリック** (`page.click(sel,
  { button: 'middle' })`) で作ること
- フォーカスを奪わない挙動を試すには、広告側の応答をサーバーで遅延させて
  (例: 1.5秒)、コミット前に別タブを `bringToFront()` する時間を作る
- ポップアップを**タブとして開いて撮影**するときは、`chrome.tabs.query({active:true})`
  が自分自身を指してしまう。対象サイトのタブを `bringToFront()` してから
  ポップアップのタブを `reload()` すると、実際の見え方で撮れる

- **任意権限の許可ダイアログは自動で押せない。** ブックマーク関連の実機テストは、
  拡張をスクラッチパッドへコピーして manifest の `permissions` に `bookmarks` を足した版で行い、
  `sw.evaluate(() => chrome.bookmarks.create(...))` でブックマークを作る。本物の manifest では
  「権限が無ければ設定オンでも閉じる」ことを確かめる

ブックマーク除外 (1.1.0) で追加確認したケース (実機8件 / 単体17件):
ブックマーク済みドメインは残す / 設定オフなら閉じる / ブックマーク削除後は閉じる /
権限が無ければ設定オンでも閉じる / 詳細設定は権限が無ければオフ表示。

1.0.0 時点で確認済みのケース (実機21件 / 単体15件):

- 監視対象から別ドメイン → 閉じる / 同一ドメイン → 残る
- `window.open('')` + 後から `location` 変更 → 閉じる
- 閉じたタブが履歴に残る
- 許可リストのドメイン → 残る
- 監視対象外のサイトからのタブ → 触らない
- 拡張オフ → 触らない
- `watchAllSources` なら監視対象リストが空でも閉じる
- **残したタブ内で自分で踏んだ別ドメインのリンク → 閉じない** (誤爆の主要ケース)
- 手前に開いた広告を閉じた後、ジャンプ元がアクティブに戻る
- 別ウィンドウで開いた広告を閉じた後、ジャンプ元のウィンドウへ戻る
- 裏で開かれた広告も閉じるが、フォーカスは動かない
- 部分一致 `*local*` で監視対象になる
- `*.localhost` は `localhost` 自身には一致しない
- 許可リストのワイルドカードで残る
- `chrome-extension:` のページ / 新しいタブページでは「このサイトを監視する」が
  無効になる (拡張ID や `newtab` を登録できない)
- `popup.html` / `options.html` が JS エラーなく描画される

## README のスクリーンショット

`docs/popup.png` は実寸 (body 320px) + `deviceScaleFactor: 2`。`fullPage` はビューポート高を
下回れないので、`document.body` の実高さを測って `setViewportSize()` してから撮る。
履歴の中身は**実際に拡張が閉じたタブ**で埋める (架空の値を書き込まない)。
UI を変えたら撮り直すこと。

## Versioning & release notes

`CHANGELOG.md` (Keep a Changelog 日本語版) + SemVer。冒頭に `## [Unreleased]` を置き、
ユーザー向けの変更を入れるたびに該当バケットへ1行追記する。
リリース時に `[Unreleased]` を `## [x.y.z] - YYYY-MM-DD` へ繰り上げ、`manifest.json` の
`"version"` を同じ番号にしてコミット → 注釈付きタグ (`git tag -a x.y.z -m ...`、
**`v` プレフィックスなし**) → `git push origin x.y.z`。
`--follow-tags` は軽量タグを送らないのでタグ名を明示する。

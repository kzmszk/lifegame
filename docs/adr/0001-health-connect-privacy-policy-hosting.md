# 1. Health Connect 用プライバシーポリシーの公開方法

- ステータス: 採用
- 日付: 2026-08-08
- 関連: `lifegame-c0v.4`、`docs/research/health-connect-integration.md`

## 文脈

Health Connect の権限画面（`ACTION_SHOW_PERMISSIONS_RATIONALE`）と、将来の Play Store listing の
両方から、同一のプライバシーポリシーへ到達できる必要がある。Play はポリシーを **認証なしで開ける
公開 URL** として要求するため、端末内の rationale Activity だけでは足りない。

一方、本番ホスト `https://lifegame.tachicoma.com` は Cloudflare Access がホスト全体を保護している。
SPA route を足しても未認証では 302 になり、公開にはならない（`scripts/smoke.mjs` が `/`・`/health`・
`/reading` の 302 を不変条件として押さえている）。Bypass されているのは OAuth プロトコル用の
`/mcp`・`/.well-known/*`・`/register`・`/token`・`/csp-report` だけで、いずれも人が読む文書の置き場では
ない。

現状のアプリは端末内 `PermissionsRationaleActivity` に要約テキストを直書きしており、Play に出す前に
「正はどこか」を決めないと、アプリ内・権限画面・listing の三箇所で文言がずれる。

## 決定

### 1. 公開 URL

正規 URL は **`https://lifegame.tachicoma.com/privacy`** とする。

製品と同じホストに置く。Play listing・Android アプリ・権限画面がすべてこの 1 本を指し、提供者の
同一性（アプリの API ホストとポリシーのホストが同じ）がドメインだけで示せる。

### 2. 公開方式

Cloudflare Access の **Bypass ポリシー**で公開する。

- 対象 path は **`/privacy` と `/privacy/*` の 2 つだけ**。
- OAuth プロトコル用の Bypass アプリケーションとは**別の Access アプリケーション**として作る。
  片方は「プロトコルの都合で認証を通せない」、もう片方は「意図して一般公開する」で、寿命も
  見直し理由も違う。混ぜると、どちらかを触ったときにもう片方の露出範囲が動く。
- `ACCESS_AUD` は本体用アプリの AUD のまま**変更しない**。Bypass 用アプリの AUD と取り違えると、
  未認証 smoke test では検出できない認可の穴になる（`docs/HANDOFF.md` の不変条件）。

### 3. 実体の置き場

静的 asset として `web/public/privacy/index.html` に置く。

- `public/` は vite の出力先で、`.gitignore` 済みかつ `emptyOutDir: true`。**直接置くと消える**。
  リポジトリ上の正は `web/public/` 側。
- `wrangler.jsonc` の `run_worker_first` には**追加しない**。Worker を経由させる理由がなく、
  経由させないほうが Access 以外の認可経路が増えない。

### 4. 単一の正と参照のしかた

**`/privacy` の HTML を唯一の正**とする。

| 参照元                         | 表示するもの                                            |
| ------------------------------ | ------------------------------------------------------- |
| Play Store listing             | `https://lifegame.tachicoma.com/privacy` をそのまま登録 |
| 権限画面（rationale Activity） | 3 点の要約 ＋「全文を開く」ボタン                       |
| アプリ内（設定など）           | 同じボタンで同じ URL                                    |

rationale Activity に要約を残すのは、権限を判断するその場で読めることに意味があるため。ただし
画面上で「全文は Web 側が正」と明示し、要約は次の 3 点に固定して、細部の更新で乖離しないようにする。

1. 読み取るのは体重測定・運動実績・睡眠実績の 3 種類だけ
2. 端末外へ送信しない
3. 第三者提供・広告・分析に使わない

全文は `ACTION_VIEW` でブラウザに渡す。Intent 起動に `INTERNET` 権限は要らないので、アプリを
ネットワーク権限なしのまま保てる。

### 5. 記載内容

Health Connect と Play Data safety の要求を満たすため、最低限これを書く。

- アプリ名、提供者、**公開連絡先** — `privacy@tachicoma.com`（詳細は §7）
- 読み取る Health Connect データ型と、型ごとの利用目的
- 送信先の有無 — 現時点は「端末外に送信しない」
- 保存と保持期間 — 現時点は「端末内の表示中のみ。保存しない」
- 第三者提供・広告・分析に使わないこと
- 利用者による停止・削除の方法（Health Connect 側の権限取消、アプリ削除）
- 最終更新日

### 6. 更新規則

- 末尾に最終更新日を置き、改訂履歴は git に残す。
- **ネットワーク送信が入る時点で必ず改訂する。** 今の内容は「送信しない」が前提なので、pairing と
  foreground sync を実装するチケットは、コードと同じ PR でこの文書を更新しないと嘘になる。
- Play Data safety の申告と本文は同時に見直す。

### 7. 公開連絡先

**`privacy@tachicoma.com`** を Cloudflare Email Routing の転送専用エイリアスとして用意し、
`kazumasa@gmail.com` へ転送する。

個人アドレスを直接載せない。ポリシーと Play listing に載せた連絡先は一度公開すると回収できず、
迷惑メールの宛先として残り続ける。エイリアスなら転送先の変更・停止がリポジトリにもアプリにも
影響しない。ホストがアプリと同じ `tachicoma.com` なので、提供者の同一性も連絡先だけで示せる。

- 受信専用。この住所から送信はしない（Email Routing は転送のみで、送信経路を作らない）。
  外形監視のために実際に1通投げたくなったら Email Sending の onboard が要るので、その時点で
  この「受信専用」を見直す。ついでに足さない。
- **catch-all は無効のままにする。** `privacy@` の routing rule が先に評価されるので、catch-all の
  対象は「どのルールにも一致しない宛先」だけになる。公開アドレスはドメインごと収集されるため、
  転送にすると無関係な迷惑メールが個人の受信箱へ流れ込み、エイリアスにした意味が消える。Drop は
  迷惑メールこそ止まるが無言で破棄するので、問い合わせ側の打ち間違いも消える。無効なら SMTP の
  段階で拒否され、送信者にバウンスが返って送り直せる。到達性が唯一の仕事の住所では、無言の
  取りこぼしのほうが害が大きい。
- 有効化と転送先の確認はダッシュボード作業。転送先アドレスの検証メールは本人しか押せない。
  2026-08-08 時点で MX x3・SPF・DKIM (`cf2024-1._domainkey`) を権威 NS で確認済み。
- **転送先の Gmail から自分でテスト送信しても、受信箱には出てこない。** 転送で戻ってきたメールは
  Sent にある元のメールと Message-ID が同じなので、Gmail が重複として抑止する。受信箱の有無で
  判断すると経路が生きていても失敗と誤診する。確認は Email Routing の Activity log、または
  Cloudflare が出す `Missing email from ... to ...?` 通知で行う。第三者からの実際の問い合わせでは
  この抑止は起きない。

## 採らなかった案

- **別ホスト（`privacy.tachicoma.com` や Cloudflare Pages）** — Access の設定ミスで本体を開けてしまう
  事故からは遠ざかるが、DNS と deploy 経路が増え、URL が 2 系統になる。将来 pairing 用の公開ページが
  必要になったら再検討する価値はある。
- **GitHub Pages / Gist** — 確実に公開できるが、ドメインが製品と一致せず、更新経路もリポジトリの
  deploy から外れる。
- **Access を外して Worker 側で認証** — 影響範囲が公開ポリシー 1 枚に対して大きすぎる。

## 実装時に踏みやすい落とし穴

- `not_found_handling` が `single-page-application` なので、`/privacy/*` の存在しない path は 404 では
  なく SPA shell が 200 で返る。smoke test は 200 だけでなく**本文の目印文字列**まで確認する。
- 実体が `privacy/index.html` なので、Assets の `html_handling`（既定の `auto-trailing-slash`）が
  **`/privacy` を `/privacy/` へ 307 で正規化する**。正規 URL である `/privacy` を叩いて 200 が返る
  わけではない。Bypass に `/privacy/*` を含めるのはこの飛び先のためで、`/privacy` だけにすると
  リダイレクト先が Access の内側に残り導線が切れる。smoke test は**自ホスト内のホップだけ**追う
  （別ホストへ飛んだら Access のログインなので、そこで失敗させる）。
- Bypass を足したあと、`/` と `/api/*` が 302 のままであることを smoke で再確認する。path を広げすぎる
  と本体が露出する。
- service worker は現状 pass-through なのでキャッシュ干渉はない。将来キャッシュを入れるなら
  `/privacy` を対象外にする。
- 静的 asset には Worker の CSP header が付かない。必要になったら `_headers` で足す。

## 影響

- `docs/HANDOFF.md` の「システムの境界」に `/privacy` の Bypass を追記する。
- `scripts/smoke.mjs` に `/privacy` の 200 と本文確認を追加する。ここが 302 に戻ったら Play 審査と
  権限画面の導線が同時に壊れる。

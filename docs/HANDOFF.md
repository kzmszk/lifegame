# 引き継ぎメモ (最終更新: 2026-08-04)

Phase 4 (MCP連携) を実装し、本番稼働させた時点の状態と、次に着手すべきことをまとめる。
設計の背景は [DESIGN.md](DESIGN.md)、セットアップ手順は [../README.md](../README.md) を参照。

## 1. 現在地

Phase 4 のタスク分解のうち **1(MCPサーバー + OAuth)、2(ツール一式)、3(朝のブリーフィング)が完了し、
本番で動作中**。Claude アプリから `lifegame.tachicoma.com/mcp` に接続してタスクの読み書きができる。
残るはタスク4(自動ブリーフィング)のみ。

| 項目                   | 状態                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------- |
| MCPサーバー `/mcp`     | 稼働中(Streamable HTTP, `McpAgent` + Durable Object)                               |
| OAuth (DCR, PKCE S256) | 稼働中。`workers-oauth-provider` が Worker のエントリポイント                      |
| ツール5種              | `get_daily_summary` / `list_tasks` / `create_task` / `update_task` / `delete_task` |
| Cloudflare Access      | 設定済み。`/authorize` は保護、OAuthプロトコル用パスはBypass。JWTをWorker内で検証  |
| 接続の一覧と切断       | 稼働中。設定画面(ヘッダー右上の `●`)から `/api/connections`                        |
| ブリーフィングスキル   | claude.ai に登録済み。アプリのチャットで起動を確認した                             |

テストは 76 件。デプロイ前は `npm run check`(format / lint / typecheck / test / build)を通す。
CI も PR と main への push で同じものを回す。

⚠️ **リポジトリと本番は一致していない**。main は PR #14(Access JWT 検証)をマージ済みだが、
**まだデプロイしていない**。本番で動いているのは PR #12 マージ後の版(migration 0002 適用済み)。
`/csp-report` は 204、`/api/connections` は未認証で 302 を返す。

PR #14 は fail closed なので、デプロイするとき `ACCESS_AUD` の取り違えがあれば `/authorize` と
`/api/*` が全部落ちる。デプロイ直後にブラウザで `/` を開いて画面が出ることを確認すること。

## 2. 本番環境の構成

- URL: `https://lifegame.tachicoma.com`(カスタムドメイン。DNSレコードは `custom_domain: true` で自動生成)
- `workers.dev` と Preview URL は **無効化している**。Access の外に出る入口を作らないため
- D1 / KV の ID と `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` は `wrangler.jsonc` にコミット済み
  (識別子でありシークレットではない。リポジトリは非公開)
- `ALLOWED_EMAIL` は `wrangler secret` に保存。リポジトリには無い
- Access アプリは2種類
  - 本体用: ホスト名全体、Action = Allow、Emails に自分のアドレス
  - Bypass用: `/mcp`、`/.well-known/*`、`/register`、`/token`、`/csp-report`

`/authorize` を Bypass に **入れてはいけない**。「クライアント登録は誰でもできるが、承認できるのは
Access を通った自分だけ」という設計の要になっている。

`ACCESS_AUD` は**本体用アプリ**の AUD タグ。Bypass 用のものを入れても JWT の検証自体は通るため、
取り違えても気づきにくい(別アプリのトークンを受け入れる状態になる)。AUD タグはアプリの設定画面を
下にスクロールした「詳細設定」にある。ブラウザの `CF_Authorization` cookie をデコードして
`aud` を読むのが、実際に届く JWT から取れるぶん確実。

## 3. 次にやること

### 3.1 まず: PR #14 のデプロイ

上記のとおり main が本番より進んでいる。`npx wrangler deploy` で揃える。

### 3.2 テストの盲点: ブラウザE2E

CSPやcookie属性は「ブラウザへの指示」なので、サーバー側のテストでは効果を検証できない。
`form-action` の不具合(後述)はこれで見逃した。現在 `SameSite=Lax` と `frame-ancestors 'none'` は
**文字列としてしか検証されていない**。Playwright で `wrangler dev` に対して承認フローを1本通すのが
本当の解決策。CI整備のタイミングで一緒にやるのが自然。

盲点はCSPに限らない。PR #7 のクイック追加の不具合(`＋` が装飾用の `<span>` で、フォームに
submit ボタンが1つも無かった)は、API が正常なのでサーバー側テストは全部通っていた。
**UIの操作可能性はサーバーテストでは検出できない**。E2Eを入れるときはCSPと一緒に拾いたい。

### 3.3 Phase 4 タスク4: 自動ブリーフィング

claude.ai のスケジュールタスクによる自動化。実運用の手応えを見てからで十分。

## 4. 調べ方(デバッグの入口)

Cloudflare の MCP プラグインがセッションに接続されていれば、Worker一覧・D1へのSQL・KV操作が
そこから直接できる(デプロイ機能は無い)。`wrangler` でも同じことができる。

```sh
npx wrangler tail lifegame --format json    # リクエストとログの監視
npx wrangler d1 migrations list lifegame --remote
npx wrangler kv key list --namespace-id <OAUTH_KVのid> --remote
```

KV のキーの意味:

- `client:*` — DCRで登録されたクライアント(7日TTL)
- `grant:<email>:*` — 承認済みの権限付与
- `token:*` — 発行済みアクセストークン(1時間)。リフレッシュトークンは既定30日

切断の記録だけは KV ではなく **D1 の `revoked_grants`** にある。理由は「切断したのに使える」を
調べるときに効いてくるので下に書く。

```sh
npx wrangler d1 execute lifegame --remote --command "SELECT * FROM revoked_grants"
```

### 接続の切断はどう効いているか

ライブラリの `revokeGrant()` はトークンを消してから grant を消す。ところが refresh は
**読んだ grant を書き戻す**ので、切断と競合すると grant が復活し、新しいトークンも残る。
この書き込みはライブラリ内部で起きるため、こちら側で直列化できない。

そこで多層で受け止めている。

1. 切断時、`revoke` の**前**に `revoked_grants` へ記録する
2. `tokenExchangeCallback` が refresh 時にそれを見て `invalid_grant` を投げる(発行させない)
3. MCPツール5種が毎回それを見て拒否する(**生き残ったトークンでもタスクに触れない**)
4. 一覧は記録済みの grant を除外する(復活したものを表示しない)

記録が **KV ではなく D1** なのは、KV の書き込みが拠点間で結果整合のため。切断が成功を返した後も
別拠点では最大1分ほど「記録なし」に見え、閉じたはずの窓がそこで開く。D1 は単一プライマリで
読み取りレプリカも使っていないので、次のリクエストから見える。行に期限は持たせていない
(期限付きだと、競合で発行されたトークンより先に切れる恐れがある)。

外形確認は curl が速い。未認証だと `/` と `/api/*` は Access ログインへリダイレクトされ、
`/mcp` は 401、`/.well-known/*` は 200 が正しい状態。

## 5. ハマったところ(再発しやすい順)

**マイグレーションの `--remote` 忘れ**
付け忘れるとローカルDBに適用され、本番は空のまま。症状は「サーバーでエラーが発生しました」。
`wrangler d1 migrations list lifegame --remote` で未適用が残っていないか確認する。

**承認画面が無反応になる (CSP)**
`form-action 'self'` は**フォーム送信後のリダイレクトにも適用される**(Chromeは遮断、Firefoxは
遮断しない。仕様は未確定)。承認は成功してKVにgrantが残るのに、クライアントへ戻れず画面は無反応。
再クリックすると使用済みcookieで CSRF に落ち "Invalid consent form" が出るので、
**CSRFが原因に見えるが実際は違う**。承認画面のCSPを触るときは
`consent CSP permits the redirect it will issue` のテストを消さないこと。

**`wrangler dev` 起動中にフロントを再ビルドすると画面が真っ白になる**
アセットのマニフェストが起動時のまま古いので、新しいハッシュ付きJSへのリクエストが
SPAフォールバックで index.html を返し、`Content-Type: text/html` のためモジュールが実行されない。
コンソールにエラーも出ないので原因が見えにくい。**再ビルドしたら dev サーバーを再起動する**。

**コネクタのURL**
Claude に登録するURLは末尾に `/mcp` が必要。付け忘れると「サーバーに接続できませんでした」。

**`wrangler d1 create` が設定を書き足す**
既存のバインディングを見ずに追記するため、`d1_databases` が重複することがある。
実行後は `wrangler.jsonc` の差分を必ず確認する。

**クライアント名は登録不要**
DCR により Claude 側が自動で登録する。設定に必要なのはURLだけ。

## 6. 開発フロー

このリポジトリで確立している進め方。

1. 実装は Codex に委譲(`--model gpt-5.6-luna --effort xhigh`)
2. レビューも Codex(`--model gpt-5.6-sol --effort xhigh`)、指摘は Critical/Major/Minor すべて対応
3. 数行で済む小さな修正は Claude が直接行う
4. 変更は必ず PR にする。GitHub の Codex ボットが自動レビューするので、その指摘にも対応してからマージ。
   ただし**このファイルの更新は PR にせず main へ直接 push する**(レビューする相手がいないため)
5. コミット前に `npm run check`(format / lint / typecheck / test / build)。husky が staged 分を見る。
   CI も PR と main への push で同じものを回す

補足:

- Codex のサンドボックスは `npm install` と `git commit` ができない。依存追加・検証・コミットは
  Claude 側で行う
- Codex ジョブは実行中に静かに死ぬことがある(statusは running のままプロセスだけ消える)。
  PID の生存確認で監視し、死んでいたら `cancel` してから `--resume-last` で再開する
- **`codex exec` をバックグラウンド(TTY なし)で回すときは `< /dev/null` を付ける**。
  付けないと、プロンプトを引数で渡していても標準入力からの追加入力を待ち続けて固まる。
  プロセスは生きたままで、ログは `Reading additional input from stdin...` の1行で止まる。
  死んだときと見分けがつきにくいので、生存確認だけでなくログが伸びているかも見ること

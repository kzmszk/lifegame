# lifegame

## 背景

人生はできるだけ楽しむためのゲームだ．

今の世の中、AIに人類が追い抜かれようとしている、そんなバカバカしさの真っ只中で犬死しないための方法序説としてこのレポジトリを準備する．

自分は自分の人生をできるだけコントロールし、楽しく健康ですごしたい．そのためのツールを準備する

## 構想

- おれの秘書
  - おれのタスク管理
  - おれの健康管理
  - おれの運動管理
  - おれの情報収集支援

## 要件

- 無料で利用できるWEBサービスとして最初は開発する
  - cloudflare worker を利用
  - typescript を使う
  - スマホでもPCでも利用できること
  - 音声入力に対応できること
- 利用できるのは自分だけ

## 設計

設計の詳細は [docs/DESIGN.md](docs/DESIGN.md) を参照．
Phase 1 のタスク管理、Phase 4 の MCP と朝のブリーフィング、Phase 5 の Google Calendar 連携、
Phase 6 の繰り返しタスク、Phase 2 初版の体重測定・運動実績は開発・本番反映済み．
Phase 2 のグラフと習慣トラッキングは、実際の記録が蓄積してから検討する．
Phase 3 初版は、外部 URL の手動保存・読むリスト・アーカイブと Android 共有を実装済みで、
本番反映済み．RSS、自動取得、全文保存、AI要約は初版に含めない．

### Android から保存リンクを共有する

Phase 3 初版では、外部 URL を「読むリスト」へ手動保存できる。Android の共有先として使う場合は、
Chrome で本番の lifegame を開き、メニューの「アプリをインストール」から PWA をインストールする。
その後、ブラウザなどの共有メニューで lifegame を選ぶと `/reading/share` の確認フォームが開く。

以前に「ホーム画面に追加」で作ったショートカットがある場合は、いったんホーム画面から削除してから
Chrome で lifegame を開き直し、「アプリをインストール」を実行する。Web Share Target はインストール時に
Android の共有先へ登録されるため、既存ショートカットには後から追加した共有設定が反映されない。
インストール後も共有先に出ない場合は Chrome を終了して開き直し、もう一度共有メニューを確認する。

共有された URL と題名はフォームへ入るだけで、自動保存されない。内容を確認して
「読むリストに保存」を押した時点で保存する。共有先に lifegame が表示されないブラウザや未インストール時は、
`/reading` の URL 欄へ手動で貼り付ける。Web Share Target は GET で確認画面を開くため、共有した URL は
最初のリクエストや Cloudflare Access のログに残り得る。機密 URL には使用しない。

## ローカル開発とデプロイ

ローカルでは、git 管理外の `.dev.vars` に `AUTH_REQUIRED=false` を設定して認証を無効化する。本番の `wrangler.jsonc` は `AUTH_REQUIRED=true` が既定なので、Cloudflare Access JWTの検証設定と `ALLOWED_EMAIL` が必要になる。

初回デプロイ時は D1 を作成し、コマンドの出力に含まれる ID で `wrangler.jsonc` の全ゼロの `database_id` を置き換える。

```sh
npx wrangler d1 create lifegame
# wrangler.jsonc の database_id を上記コマンドの ID に置換
npx wrangler d1 migrations apply lifegame --remote
npx wrangler secret put ALLOWED_EMAIL
npm run deploy
```

通常の本番リリースは、クリーンで `origin/main` と一致した `main` から次を実行する。

```sh
npm run release:check # 本番を変更せず、品質・認証・migration・dry-run・現在の本番を確認
npm run release       # 品質確認 → 本番D1 migration → deploy → smoke
```

`release` はブランチ、未コミット・未追跡ファイル、`origin/main` とのずれを検出すると停止する。
本番D1 migrationを先に適用してから `npm run deploy` を呼び、デプロイ後のsmokeまで一続きにする。
`npm run deploy` はmigrationを適用しない低水準コマンドなので、通常のリリースには直接使わない。
未認証のsmokeでは `ACCESS_AUD` の取り違えを検出できないため、デプロイ後にAccess認証を通した
ブラウザでもJWT検証と変更した画面の主要操作を確認する。

`wrangler.jsonc` の `vars` にある `ACCESS_TEAM_DOMAIN` と `ACCESS_AUD` のプレースホルダは、デプロイ前に置き換える。
`ACCESS_TEAM_DOMAIN` はCloudflare Zero Trustのチームドメイン（Access JWTの `iss`、通常は
`https://<team-name>.cloudflareaccess.com`）で、`ACCESS_AUD` は Zero Trust > Access controls > Applications
から対象アプリを開き、Configure > Additional settings の Application Audience (AUD) Tag で確認できる。
ローカルの認証バイパスではJWT検証を行わないため、`.dev.vars` で `AUTH_REQUIRED=false` にする場合はこれらの値を設定しなくてよい。

`wrangler deploy` は設定済みの `npm run build` を先に実行するため、クリーン checkout でも `public/` 以下の SPA アセットが生成される。

### コード品質チェック

ローカルでは次のコマンドを使う。`npm run check` は CI と同じチェックをまとめて実行する。

```sh
npm run format       # Oxfmt で整形
npm run lint         # Oxlint
npm run typecheck    # TypeScript の型チェック
npm test             # Vitest
npm run check        # 上記のチェックと本番ビルドを一括実行
```

`npm install` 後は Husky の pre-commit hook が有効になり、commit 対象を Oxfmt で整形する。JavaScript / TypeScript が含まれる場合だけ Oxlint も実行し、その後にプロジェクト全体を型チェックする。いずれかが失敗した場合は commit を中止する。

## Phase 4: MCP と Claude

Remote MCP は `@cloudflare/workers-oauth-provider`、Cloudflare Agents の `McpAgent`、
`@modelcontextprotocol/sdk`、`zod` を使う。依存関係は `package.json` に固定している。
`McpAgent` は現在のAgents SDKではレガシー互換の位置づけだが、Phase 4の設計どおり
Streamable HTTPとDurable Objectを使うために採用している。

初回デプロイ前にOAuth用KVとMCP用Durable Objectを準備する。KVのIDを
`wrangler.jsonc` の全ゼロの `OAUTH_KV.id` に置き換え、D1のIDも同様に置き換える。
Durable Objectのクラスとmigrationは設定済みなので、追加の手動作成は不要。

`workers.dev` とPreview URLはAccessの対象外になりうるため無効化してある。そのため公開ホスト名は
`wrangler.jsonc` の `routes` で明示する必要がある。`lifegame.example.com` のプレースホルダを
Cloudflareに登録済みの自分のドメインへ置き換えてからデプロイすること
(置き換えないままデプロイすると、公開ホスト名を持たないWorkerになる)。

```sh
npx wrangler kv namespace create OAUTH_KV
# wrangler.jsonc の OAUTH_KV.id に上記コマンドのIDを設定
# wrangler.jsonc の routes[0].pattern を自分のカスタムドメインに設定
npx wrangler d1 migrations apply lifegame --remote
npm run deploy
```

Cloudflare Zero TrustのAccessアプリでは、MCPのOAuthプロトコルをAccessのログイン画面で
遮らないよう、次のパスをPublic/BYPASSのパスルールに追加する。

- `/mcp`
- `/.well-known/*`
- `/register`
- `/token`
- `/csp-report`（承認画面のCSP違反レポートの送信先。ブラウザからの無認証POSTなので除外が必要）

`/authorize` は除外しない。認可画面はAccess配下に残り、Worker側でも
`Cf-Access-Jwt-Assertion` をJWKSで検証し、JWTの `email` claimと `ALLOWED_EMAIL` を比較する。`/mcp` のタスクデータは
Cloudflare OAuthのBearer tokenが必須で、DCR・メタデータ・tokenエンドポイントだけが公開される。
既存の `/api/*` とSPAの保護設定は変更しない。

公開するホスト名は、カスタムドメインを含めてすべてCloudflare Accessアプリの対象にする。
`wrangler.jsonc` では意図しない `workers.dev` とPreview URLも無効化している。AccessのBYPASSは
上記のOAuthプロトコル用パスだけに限定すること。Workerは `Cf-Access-Jwt-Assertion` の署名を
Cloudflare AccessのJWKSエンドポイント（`<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs`）で検証し、issuer、audience、
有効期限も確認する。認証が有効なとき、ユーザーのメールアドレスはJWTの `email` claimだけを信頼し、
`Cf-Access-Authenticated-User-Email` ヘッダーは認証に使用しない。

### 承認画面のCSPを変更するときの注意

承認画面のCSPはブラウザ側でしか効果が現れないため、サーバーのテストでは壊れたことが分からない。
実際に `form-action 'self'` がフォーム送信後のリダイレクト（Chromeは遮断、Firefoxは遮断しない）を
止めてしまい、承認しても無反応になる不具合が起きた。以下で再発を抑える。

- `src/oauth.test.ts` の「consent CSP permits the redirect it will issue」が、GETで返すCSPと
  承認POSTが返す `Location` の整合をテスト側の独立した評価器で突き合わせている。CSPを触るときは
  このテストを消さないこと
- 違反は `report-uri` / `report-to` で `/csp-report` に送られ、Workerのログに出る
  （`npx wrangler tail` で確認できる）。画面にもサーバーのエラーにも出ない失敗を拾うための唯一の手段
- ディレクティブを追加・厳格化するときは、まず `Content-Security-Policy-Report-Only` で出して
  違反レポートが出ないことを確認してから強制に切り替えるのが安全

公開DCRの悪用を抑えるため、Cloudflareダッシュボード側で `/register` にIP単位のレート制限/WAFルールを
設定する（例: POSTを1分あたり10件でchallengeまたはblock）。コード側でもメタデータの文字列・配列サイズを
制限し、登録クライアントのTTLを7日に短縮している。可能なら、運用するClaude等の既知のコールバックURIだけを
許可するルールもダッシュボードまたは登録ポリシーに追加する。

デプロイ後、Claudeアプリの設定からカスタムコネクタ/Integrationsとして
`https://<workerのホスト名>/mcp` を追加する。OAuthの登録・ログイン・同意画面が順に開くので、
lifegameの接続を許可する。Claude Codeでは次のようにHTTP MCPサーバーとして登録する。

```sh
claude mcp add --transport http lifegame https://<workerのホスト名>/mcp
```

その後Claude Codeを起動し、`/mcp` を実行して `lifegame` を選び、ブラウザのOAuth認証を完了する。

Codex CLIからも同じサーバーに接続できる(Streamable HTTP + OAuth)。

```sh
codex mcp add lifegame --url https://<workerのホスト名>/mcp
codex mcp login lifegame
```

接続後は、`get_daily_summary`、`list_tasks`、`create_task`、`update_task`、`delete_task` が使える。
朝の定型文は [skills/morning-briefing/](skills/morning-briefing/) にある。クライアントごとの導入手順は
[INSTALL.md](skills/morning-briefing/INSTALL.md) を参照。claude.ai 用のZIPは次で作れる。

```sh
npm run skill:zip    # dist/morning-briefing.zip
```

# lifegame

## 背景
人生はできるだけ楽しむためのゲームだ．

今の世の中、AIに人類が追い抜かれようとしている、そんなバカバカしさの真っ只中で犬死しないための方法序説としてこのレポジトリを準備する．

自分は自分の人生をできるだけコントロールし、楽しく健康ですごしたい．そのためのツールを準備する

## 構想

* おれの秘書
  * おれのタスク管理
  * おれの健康管理
  * おれの運動管理
  * おれの情報収集支援

## 要件

* 無料で利用できるWEBサービスとして最初は開発する
  * cloudflare worker を利用
  * typescript を使う
  * スマホでもPCでも利用できること
  * 音声入力に対応できること
* 利用できるのは自分だけ

## 設計

設計の詳細は [docs/DESIGN.md](docs/DESIGN.md) を参照．
Phase 1 (タスク管理 MVP) は開発済み．次は Phase 4 (MCP サーバー + Claude スキルによる秘書のAI化) を進める．

## ローカル開発とデプロイ

ローカルでは、git 管理外の `.dev.vars` に `AUTH_REQUIRED=false` を設定して認証を無効化する。本番の `wrangler.jsonc` は `AUTH_REQUIRED=true` が既定なので、Cloudflare Access の認証ヘッダーと `ALLOWED_EMAIL` が必要になる。

初回デプロイ時は D1 を作成し、コマンドの出力に含まれる ID で `wrangler.jsonc` の全ゼロの `database_id` を置き換える。

```sh
npx wrangler d1 create lifegame
# wrangler.jsonc の database_id を上記コマンドの ID に置換
npx wrangler d1 migrations apply lifegame --remote
npx wrangler secret put ALLOWED_EMAIL
npx wrangler deploy
```

`wrangler deploy` は設定済みの `npm run build` を先に実行するため、クリーン checkout でも `public/` 以下の SPA アセットが生成される。

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
npx wrangler deploy
```

Cloudflare Zero TrustのAccessアプリでは、MCPのOAuthプロトコルをAccessのログイン画面で
遮らないよう、次のパスをPublic/BYPASSのパスルールに追加する。

- `/mcp`
- `/.well-known/*`
- `/register`
- `/token`
- `/csp-report`（承認画面のCSP違反レポートの送信先。ブラウザからの無認証POSTなので除外が必要）

`/authorize` は除外しない。認可画面はAccess配下に残り、Worker側でも
`Cf-Access-Authenticated-User-Email` と `ALLOWED_EMAIL` を検証する。`/mcp` のタスクデータは
Cloudflare OAuthのBearer tokenが必須で、DCR・メタデータ・tokenエンドポイントだけが公開される。
既存の `/api/*` とSPAの保護設定は変更しない。

公開するホスト名は、カスタムドメインを含めてすべてCloudflare Accessアプリの対象にする。
`wrangler.jsonc` では意図しない `workers.dev` とPreview URLも無効化している。AccessのBYPASSは
上記のOAuthプロトコル用パスだけに限定すること。WorkerはAccessの前段検証を設計契約としており、
`Cf-Access-Jwt-Assertion` の署名・issuer・audienceをWorker内で再検証する処理は将来のハードニング課題として残している。

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

接続後は、`get_daily_summary`、`list_tasks`、`create_task`、`update_task`、`delete_task` が使える。
朝の定型文は [skills/morning-briefing/SKILL.md](skills/morning-briefing/SKILL.md) を含むフォルダをZIPにして
claude.aiのSkills設定からアップロードする。

```sh
cd skills && zip -r ../morning-briefing.zip morning-briefing
```

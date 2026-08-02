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

```sh
npx wrangler kv namespace create OAUTH_KV
# wrangler.jsonc の OAUTH_KV.id に上記コマンドのIDを設定
npx wrangler d1 migrations apply lifegame --remote
npx wrangler deploy
```

Cloudflare Zero TrustのAccessアプリでは、MCPのOAuthプロトコルをAccessのログイン画面で
遮らないよう、次のパスをPublic/BYPASSのパスルールに追加する。

- `/mcp`
- `/.well-known/*`
- `/register`
- `/token`

`/authorize` は除外しない。認可画面はAccess配下に残り、Worker側でも
`Cf-Access-Authenticated-User-Email` と `ALLOWED_EMAIL` を検証する。`/mcp` のタスクデータは
Cloudflare OAuthのBearer tokenが必須で、DCR・メタデータ・tokenエンドポイントだけが公開される。
既存の `/api/*` とSPAの保護設定は変更しない。

デプロイ後、Claudeアプリの設定からカスタムコネクタ/Integrationsとして
`https://<workerのホスト名>/mcp` を追加する。OAuthの登録・ログイン・同意画面が順に開くので、
lifegameの接続を許可する。Claude Codeでは次のようにHTTP MCPサーバーとして登録する。

```sh
claude mcp add --transport http lifegame https://<workerのホスト名>/mcp
```

接続後は、`get_daily_summary`、`list_tasks`、`create_task`、`update_task`、`delete_task` が使える。
朝の定型文は [skills/morning-briefing/SKILL.md](skills/morning-briefing/SKILL.md) をClaudeのスキルとして登録する。

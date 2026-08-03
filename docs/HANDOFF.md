# 引き継ぎメモ (最終更新: 2026-08-03)

Phase 4 (MCP連携) を実装し、本番稼働させた時点の状態と、次に着手すべきことをまとめる。
設計の背景は [DESIGN.md](DESIGN.md)、セットアップ手順は [../README.md](../README.md) を参照。

## 1. 現在地

Phase 4 のタスク分解のうち **1(MCPサーバー + OAuth)と 2(ツール一式)が完了し、本番で動作中**。
Claude アプリから `lifegame.tachicoma.com/mcp` に接続してタスクの読み書きができる。

| 項目 | 状態 |
|------|------|
| MCPサーバー `/mcp` | 稼働中(Streamable HTTP, `McpAgent` + Durable Object) |
| OAuth (DCR, PKCE S256) | 稼働中。`workers-oauth-provider` が Worker のエントリポイント |
| ツール5種 | `get_daily_summary` / `list_tasks` / `create_task` / `update_task` / `delete_task` |
| Cloudflare Access | 設定済み。`/authorize` は保護、OAuthプロトコル用パスはBypass |
| ブリーフィングスキル | ファイルは `skills/morning-briefing/` にあるが **claude.ai に未登録** |

テストは 51 件。`npm test` / `npm run typecheck` / `npm run build` が通ることを常に確認してからデプロイする。

## 2. 本番環境の構成

- URL: `https://lifegame.tachicoma.com`(カスタムドメイン。DNSレコードは `custom_domain: true` で自動生成)
- `workers.dev` と Preview URL は **無効化している**。Access の外に出る入口を作らないため
- D1 / KV の ID は `wrangler.jsonc` にコミット済み(識別子でありシークレットではない)
- `ALLOWED_EMAIL` は `wrangler secret` に保存。リポジトリには無い
- Access アプリは2種類
  - 本体用: ホスト名全体、Action = Allow、Emails に自分のアドレス
  - Bypass用: `/mcp`、`/.well-known/*`、`/register`、`/token`、`/csp-report`

`/authorize` を Bypass に **入れてはいけない**。「クライアント登録は誰でもできるが、承認できるのは
Access を通った自分だけ」という設計の要になっている。

## 3. 次にやること(未反映の作業が1つある)

### 3.1 最優先: `/csp-report` を本番に反映する

PR #6 がマージ済みだが **まだデプロイしていない**。リポジトリと本番のコードが一致していない状態。

```sh
npx wrangler deploy
```

デプロイ後、Access の Bypass アプリに `/csp-report` を追加すること。追加しないと違反レポートが
ログイン画面にリダイレクトされて失われ、可視化が機能しない。
反映後、承認画面を一度開いて `npx wrangler tail` に違反が出ないことを確認するとよい。

### 3.2 すぐできる: 朝のブリーフィング(Phase 4 タスク3)

`skills/morning-briefing/` を ZIP 化して claude.ai にスキルとして登録する。
登録後、朝に「今日のブリーフィングをして」と話しかけて実運用テストする。

### 3.3 運用上の穴: 接続クライアントの失効手段

現状、**接続中のOAuthクライアントを一覧・切断する手段がない**。ライブラリ側には
`deleteClient()`(関連する権限付与とトークンを連鎖失効させる)があるが、それを呼ぶ入口が無い。
繋ぎ先が増える前に、SPAの設定画面か管理用ルートを用意しておきたい。

デバッグ中の失敗した試行でクライアント登録が溜まることがある。7日で自動的に期限切れになるが、
状況は KV で確認できる(下記「調べ方」参照)。

### 3.4 保険: Access JWT 検証

Worker は `Cf-Access-Authenticated-User-Email` ヘッダーを署名検証せずに信頼している。
現構成では Access の外に出る入口が無いので実害は無いが、**将来ルートを足したり
`workers.dev` を戻したときに、この前提が静かに崩れる**。`Cf-Access-Jwt-Assertion` の
署名・issuer・audience を検証すれば、構成ミスに依存しなくなる。Cloudflare も検証を推奨している。

### 3.5 テストの盲点: ブラウザE2E

CSPやcookie属性は「ブラウザへの指示」なので、サーバー側のテストでは効果を検証できない。
`form-action` の不具合(後述)はこれで見逃した。現在 `SameSite=Lax` と `frame-ancestors 'none'` は
**文字列としてしか検証されていない**。Playwright で `wrangler dev` に対して承認フローを1本通すのが
本当の解決策。CI整備のタイミングで一緒にやるのが自然。

### 3.6 Phase 4 タスク4: 自動ブリーフィング

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
4. 変更は必ず PR にする。GitHub の Codex ボットが自動レビューするので、その指摘にも対応してからマージ

補足:

- Codex のサンドボックスは `npm install` と `git commit` ができない。依存追加・検証・コミットは
  Claude 側で行う
- Codex ジョブは実行中に静かに死ぬことがある(statusは running のままプロセスだけ消える)。
  PID の生存確認で監視し、死んでいたら `cancel` してから `--resume-last` で再開する

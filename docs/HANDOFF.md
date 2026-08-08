# 引き継ぎメモ

最終更新: 2026-08-07

この文書は、次の担当者が作業を再開するための入口である。設計や手順の全文、完了済み作業の履歴は
ここへ複製しない。作業状態は Beads、設計判断は `docs/DESIGN.md`、セットアップ手順は `README.md`
を正とする。

## 最初に読むもの

1. `AGENTS.md` を読み、`bd prime` を実行する。
2. `bd ready` と `bd list --status=in_progress` で現在の作業を確認する。
3. 変更対象に応じて次の文書を読む。
   - 全体設計・ロードマップ: [`DESIGN.md`](DESIGN.md)
   - ローカル開発・Cloudflare・OAuth: [`README.md`](../README.md)
   - Google Calendar の初期設定: [`GCAL_SETUP.md`](GCAL_SETUP.md)
   - Beads の運用: [`agents/issue-tracker.md`](agents/issue-tracker.md)

## 現在地

- Phase 1（タスク管理）、Phase 4（MCP）、Phase 5（Google Calendar）、Phase 6（繰り返しタスク）は実装済み。
- MCP は `/mcp` で公開し、OAuth、タスク用ツール5種、接続一覧と切断を実装している。
- Google Calendar は `private` カレンダーの表示と予定作成だけを担う。更新・削除や双方向同期は行わない。
- 繰り返しタスクは「完了時に次の1件だけを生成」する。期限と実行予定日は migration 0004 で分離した。
- migration 0004 は 2026-08-05 22:10:52 UTC に本番 D1 へ適用済みで、対応する Worker version 17 は
  同日 22:11:12 UTC にデプロイ済み。smoke と Access 認証済みブラウザで確認している
  （根拠: `lifegame-6bo`）。
- 本番の繰り返しタスクは、完了時に正しい実行予定日の子を1件だけ生成し、リロード後も保持され、
  次回タスクで繰り返しを停止できるところまで受け入れ済み（根拠: `lifegame-vtr`）。
- Phase 4 の自動ブリーフィングは任意。サーバー側の cron や LLM 呼び出しは作らず、必要になった時に
  クライアント側のスケジュール機能を使う。

作業候補をこの文書へ固定しない。`bd ready` が空なら、次の優先順位を設計相談の起点にする。

1. Phase 2（健康・運動ログ、`lifegame-160`）を、まず体重と運動の最小スコープから設計する。

## 作業場所と sling

- コードの正は特定のチェックアウトではなく `origin/main` とする。
- 人の作業用チェックアウトと Gas Town の agent worktree は分離する。agent は polecat worktree で作業し、
  人の作業用チェックアウトを直接変更しない。
- sling の前に、人の作業用チェックアウトに対象ファイルの未コミット変更がないことを確認する。
  重なる変更があれば、先にコミットまたは stash してから投入する。
- `.beads/metadata.json`、redirect、role用ファイルなどの Beads/Gas Town 実行時設定はローカル管理とし、
  プロダクトの変更としてコミットしない。

## システムの境界

- 本番 URL は `https://lifegame.tachicoma.com`。`workers.dev` と Preview URL は無効。
- Cloudflare Access がブラウザと `/api/*` を保護する。
- `/mcp`、`/.well-known/*`、`/register`、`/token`、`/csp-report` は OAuth プロトコルのため Bypass。
  `/authorize` は必ず Access 配下に残す。
- `/privacy` と `/privacy/*` は公開プライバシーポリシーのため、OAuth 用とは**別の** Access アプリケーション
  として Bypass する。Play listing・Health Connect の権限画面・アプリ内が同じ URL を指す。実体は
  `web/public/privacy/index.html`（`public/` は vite の出力先で gitignore 済み）。`ACCESS_AUD` は本体用
  アプリの AUD のまま変えない。詳細は `docs/adr/0001-health-connect-privacy-policy-hosting.md`。
- D1 がタスクと切断記録を、KV が OAuth クライアント・grant・token を保持する。
- Google の認証情報と `ALLOWED_EMAIL` は Worker secret に置く。値を文書やリポジトリへ記録しない。

## 壊してはいけない不変条件

### 認証と認可

- `ACCESS_AUD` は本体用 Access アプリの AUD を使う。Bypass 用 AUD との取り違えは未認証 smoke test では
  検出できないため、Access 認証済みブラウザで `/` が開けることまで確認する。
- OAuth スコープの唯一の定義は `src/oauth.ts` の `SUPPORTED_SCOPES`。新しいデータ源を MCP に出す前に、
  誰が読めるかを決めてからスコープを追加または据え置く。
- Google Calendar のデータは `calendar:read` がある接続だけに返す。権限がない場合は予定関連キーを
  空配列にせず、レスポンスから省略する。
- `/authorize` の CSP では、フォーム送信後の callback 先も `form-action` に許可する。関連テストは
  `src/oauth.test.ts` と `e2e/consent.spec.ts` にある。
- 接続切断は競合対策として、revoke 前に D1 の `revoked_grants` へ記録する。refresh と競合して KV の
  grant や token が残っても、token exchange と MCP ツールの両方で拒否する設計を維持する。

### タスクと予定

- `due_*` は期限、`scheduled_*` は実行予定。今日ビューと繰り返しの基点は `scheduled_*` を使う。
- `repeat_rule` を持てるのは、open かつ `scheduled_date` があり、`due_date` / `due_time` がない行だけ。
- 繰り返しを完了するとルールを親から消し、生成した子へ移す。この状態を migration 0004 の CHECK 制約で
  強制している。詳細は `DESIGN.md` のセクション13を参照する。
- Google Calendar API の一覧取得では `singleEvents=true` と `orderBy=startTime` を維持し、ページを最後まで
  たどる。予定取得に失敗してもタスク表示を巻き込まない。

## 検証と運用

通常の変更は次を通す。

```sh
npm run check
npm run e2e
```

- `npm run check`: format / lint / typecheck / unit test / build
- `npm run e2e`: ローカル D1・KV と `wrangler dev` を使うブラウザ E2E。Cloudflare Access 層は対象外
- `npm run smoke`: デプロイ後に未認証で見える Access / Bypass 境界と OAuth discovery を確認

本番 migration の確認では必ず `--remote` を付ける。

```sh
npx wrangler d1 migrations list lifegame --remote
```

テーブルを再作成する migration の前には D1 を export する。migration 0004 はテーブル再作成を含むため、
未適用ならバックアップ後に適用する。適用・デプロイはユーザーの明示的な許可を得て行う。

ローカル E2E の注意点:

- `playwright.config.ts` と `e2e:server` のホスト・ポートを揃える。
- `wrangler dev` 起動後にフロントを再ビルドしたら、古い asset manifest を捨てるためサーバーを再起動する。
- Vitest が `e2e/**/*.spec.ts` を収集しないよう、`vitest.config.ts` の除外設定を維持する。

## Suggested skills

- `beads`: 作業の確認、claim、依存関係、完了記録。
- `domain-modeling`: Phase 2 の用語・境界・不変条件を設計するとき。
- `codebase-design`: 新しいデータ源やモジュールのインターフェースを決めるとき。
- `tdd`: API、DB 制約、再現可能な不具合を実装するとき。
- `code-review`: PR を仕様とリポジトリ標準の両面で確認するとき。
- `handoff`: 別セッション、別ディレクトリ、別担当者へ作業途中の文脈を渡すとき。

## 引き継ぎを更新するとき

- 作業の残件や担当状態は Beads に記録し、この文書には再開方法と判断材料だけを残す。
- 設計判断は `DESIGN.md` へ置き、この文書から参照する。
- コマンドや構成は設定ファイルから分かるなら複製せず、環境から読み取る。
- 秘密情報、個人情報、ローカル専用パスを記録しない。
- 完了済み PR の時系列や一時的なデバッグ経緯は削り、再発防止に必要な不変条件だけを残す。

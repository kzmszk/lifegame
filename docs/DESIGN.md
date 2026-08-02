# lifegame 設計ドキュメント

「おれの秘書」= 自分専用のライフマネジメントWEBアプリ。
本ドキュメントは MVP(Phase 1: タスク管理)を中心とした全体設計をまとめる。

## 1. コンセプト

- 4つのモジュール(タスク・健康・運動・情報収集)を1つのアプリに統合する
- まずタスク管理を完成させ、同じ基盤の上に他モジュールを積み増す
- スマホのホーム画面から秘書に話しかけるように使える(音声入力・PWA)
- 利用者は自分ひとり。運用コストはゼロ(Cloudflare無料枠に収める)

## 2. ロードマップ

| Phase | 内容 |
|-------|------|
| 1 (MVP) | タスク管理: CRUD + 今日ビュー + 音声入力(音声→タスク化、ルールベースの日付解析) |
| 2 | 健康・運動ログ: 体重・運動などの日次記録とグラフ、繰り返しタスク・習慣トラッキング |
| 3 | 情報収集支援: RSS・ブックマークの収集と閲覧 |
| 4 | 秘書のAI化: MCP サーバーを公開し、Claude 等のAIアシスタントからタスクを読み書き(追加含む)。朝のブリーフィングは Claude 側のスキルで生成 |

自前の LLM 呼び出し(Workers AI / Claude API)は導入しない。AI 機能(自然言語の解釈・要約・対話)は
MCP で接続した Claude 等のアシスタントに任せ、サーバーはデータの記録と提供に徹する(セクション10)。
Phase 1 完了後は Phase 4 を先に進め、Phase 2・3 は後回しにする。

## 3. 技術スタック

| 層 | 採用技術 | 備考 |
|----|---------|------|
| ランタイム | Cloudflare Workers | 無料枠 10万リクエスト/日で個人利用には十分 |
| バックエンド | Hono | 1つのWorkerでAPIと静的アセットを配信 |
| フロントエンド | React + Vite (SPA) | Workerから静的配信。API分離構造なのでUI層はいつでも乗り換え可能 |
| 言語 | TypeScript | |
| DB | Cloudflare D1 (SQLite) | 無料枠 5GB |
| 音声入力 | Web Speech API (ブラウザ標準) | 追加インフラ不要・無料。iOS Safari / Android Chrome 対応 |
| 認証 | Cloudflare Access (Zero Trust) | アプリコード側は認証を書かない。自分のGoogleアカウントのみ許可 |
| デプロイ | wrangler | `wrangler deploy` のみ。CIは後で GitHub Actions 化 |

### フロントエンドの方針: React SPA 一本

React + Vite の SPA を1本作り、Worker から静的アセットとして配信する。

- 選定理由: 先のフェーズほどUIがインタラクティブになる(Phase 2 グラフ)。
  チャットUIは作らない(Phase 4 では Claude アプリ自体がチャットUIになる)。
  自分専用アプリなので SSR の強み(SEO・JS無効対応)は活きない。
  毎日スマホのホーム画面から使うため、画面遷移のないアプリらしい操作感を優先する
- 乗り換え保険: UI と API (`/api/*`)・D1・パーサーを分離しておくことで、
  万一UI技術を変えたくなってもビュー層だけ捨てれば済む構造を維持する
- 完了トグルは楽観的更新(タップで即時反映→裏でAPI)、追加も画面遷移なし
- PWA: `manifest.json` を配信してホーム画面に追加可能にする。オフライン対応(Service Worker)は Phase 2 以降

## 4. アーキテクチャ

```
[ブラウザ (スマホ/PC, PWA)]
   │  静的アセット取得 / fetch (JSON API)
   ▼
[Cloudflare Access]  ← 自分のアカウントだけ通す
   ▼
[Worker: Hono アプリ]
   ├─ /api/*   JSON API
   └─ /        React SPA (ビルド済み静的アセット, SPAフォールバック)
                + manifest.json, icons
   ▼
[D1 (SQLite)]
```

### ディレクトリ構成(予定)

```
src/                 # Worker 本体 (API専用)
  index.ts           # Hono アプリのエントリ
  routes/
    api.ts           # /api/* (JSON API)
  db/                # D1 アクセス(クエリ関数)
  lib/
    parse.ts         # 音声テキストの日付・時刻パーサー
  shared/
    types.ts         # Task 型・APIリクエスト/レスポンス型 (Worker と SPA で共有)
web/                 # React SPA (Vite プロジェクト)
  src/
  vite.config.ts     # ビルド出力を public/ へ
public/              # 配信アセット (SPAビルド成果物, manifest.json, icons)
migrations/          # D1 マイグレーション SQL
wrangler.jsonc
```

- wrangler の assets 設定で `run_worker_first: ["/api/*"]` とし、それ以外は静的配信
  (Phase 4 で `/mcp` と OAuth 系パスを `run_worker_first` に追加する。セクション10)。
  `not_found_handling: "single-page-application"` で SPA のルーティングにフォールバックさせる
- `wrangler.jsonc` の `build.command` (`npm run build`) でデプロイ前に `public/` 全体を生成する。
  `public/` は生成物として git 管理せず、入力となる SPA ソースは `web/` に置く
- API のリクエスト/レスポンス型は `src/shared/types.ts` に置き、SPA からも import して型を揃える

## 5. データモデル (Phase 1)

```sql
CREATE TABLE tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'done'
  due_date     TEXT,                           -- 'YYYY-MM-DD' (なければ Inbox 扱い)
  due_time     TEXT,                           -- 'HH:MM' 任意
  priority     INTEGER NOT NULL DEFAULT 0,     -- 0:通常 1:高
  tags         TEXT NOT NULL DEFAULT '',       -- MVPはカンマ区切り
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX idx_tasks_status_due ON tasks(status, due_date);
```

Phase 2 で健康・運動を追加する際は、種別つきの汎用ログテーブルを足す:

```sql
CREATE TABLE logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  date    TEXT NOT NULL,      -- 'YYYY-MM-DD'
  kind    TEXT NOT NULL,      -- 'weight' | 'sleep' | 'run' | ...
  value   REAL,
  unit    TEXT,
  note    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## 6. 画面設計 (Phase 1)

| パス | 画面 | 内容 |
|------|------|------|
| `/` | 今日 | 期限が今日以前の未完了タスク + 今日完了したタスク。最上部にクイック追加(テキスト+音声ボタン) |
| `/inbox` | Inbox | 期限なしの未完了タスク |
| `/all` | 一覧 | 全タスク(完了含む、新しい順) |
| `/tasks/:id` | 詳細/編集 | タイトル・メモ・期限・優先度・タグの編集、削除 |

- パスは SPA のクライアントサイドルーティング
- モバイルファーストのシンプルな1カラムUI。下部タブで 今日 / Inbox / 一覧 を切替
- 完了チェックはタップで即時反映(楽観的更新)し、裏で API を呼ぶ。失敗時は元に戻してトースト表示

## 7. API (Phase 1)

SPA が利用する JSON API。

| メソッド/パス | 役割 |
|---------------|------|
| `GET /api/tasks?view=today\|inbox\|all` | タスク一覧の取得 |
| `GET /api/tasks/:id` | タスク1件の取得 |
| `POST /api/tasks/parse` | テキスト解析のみ(**保存しない**)。`{ text }` を受け取り `TaskDraft` を返す。音声入力の確認UI用 |
| `POST /api/tasks` | タスク作成。`{ text }` を受け取りパーサーで期限抽出、または構造化済み `{ title, due_date, ... }` |
| `PATCH /api/tasks/:id` | 更新(完了トグル含む) |
| `DELETE /api/tasks/:id` | 削除 |

### API契約の補足

- **`completed_at` は `status` と連動させる**: `PATCH` で `status` を `done` にする際は同一UPDATE文の中で
  `completed_at` に現在時刻を設定し、`open` に戻す際は `NULL` にクリアする(クライアントからは送らせない)。
  今日ビューの「今日完了したタスク」はこの `completed_at` で判定するため、この契約がないと完了タスクが再読み込みで消える
- **「今日」の判定は Asia/Tokyo の日付境界で行う**: `view=today` の期限カットオフ(`due_date <= 今日`)と
  完了日時の当日判定の両方に適用する。D1/SQLite の `date('now')` は UTC のため使わず、
  Worker 側で JST の「今日」を計算してクエリパラメータとして渡す(UTCのままだと 00:00〜08:59 JST に当日タスクが表示されない)

- **月日だけの過去日付は翌年に繰り上げる**: たとえば 8 月 2 日に「8 月 1 日」と指定した場合は、翌年の 8 月 1 日として扱う。
  その繰り上げ後の対象年で実在日付かどうかを検証する

## 8. 音声入力の設計

1. クイック追加の🎤ボタン → Web Speech API (`SpeechRecognition`, `lang: 'ja-JP'`) で認識
2. 認識テキストを `POST /api/tasks/parse` に送信(**この時点ではまだ保存しない**)
3. サーバー側 `lib/parse.ts` がルールベースで期限を抽出し、`TaskDraft` を返す
   - 例: 「明日の15時に歯医者」→ `{ title: '歯医者', due_date: <明日>, due_time: '15:00' }`
   - 対応パターン: 今日 / 明日 / 明後日 / ◯曜日 / 来週 / ◯月◯日 / ◯時(半)
   - 「来週」は月曜始まりで計算する。日曜日に「来週の月曜」と言った場合は翌日の月曜を指す
   - 解析できない部分はそのままタイトルに残す(壊れない設計)
4. 確認UIに `TaskDraft` を表示し、誤認識はその場で修正 → 確定操作で `POST /api/tasks` に送信して保存する

日付パーサーはタイムゾーン(Asia/Tokyo)を固定して判定する。
このパーサーは Phase 4 以降も SPA のクイック追加用としてそのまま残す。自然言語での柔軟な操作は
MCP 経由の Claude が担うため、パーサーの LLM 差し替えは行わない(セクション10)。

## 9. 認証・セキュリティ

- Cloudflare Access で Worker への全リクエストを保護し、自分のアカウントのみ許可する
- アプリ側では認証コードを書かない(Access が JWT を検証済みの前提)
- 念のため `Cf-Access-Authenticated-User-Email` ヘッダを検証するミドルウェアを1枚入れる
- 例外: Phase 4 では `/mcp` と OAuth プロトコル用エンドポイントを Access の保護対象から外し、
  MCP 標準の OAuth で保護する。認可画面 `/authorize` だけは Access 配下に残す(セクション10)

## 10. Phase 4: MCP 連携の設計

方針: **サーバーはデータの記録と提供に徹し、解釈・要約・対話は Claude 側に任せる**。
Worker に MCP サーバー(`/mcp`)を追加し、Claude アプリ・Claude Code 等からタスクを読み書きできるようにする。
チャットUI・自前の LLM 呼び出し・cron によるブリーフィング生成は作らない。

```
[Claude アプリ / Claude Code / (ChatGPT)]
   │  MCP (Streamable HTTP + OAuth)
   ▼
[Worker: /mcp]  ← 既存の db/tasks.ts・lib/time.ts をツール実装として再利用
   ▼
[D1 (SQLite)]
```

### MCP ツール (read/write 両対応)

| ツール | 種別 | 役割 |
|--------|------|------|
| `get_daily_summary` | read | 今日のタスク・期限切れ・Inbox 件数・今日完了分を1回の呼び出しで返す集約ビュー(ブリーフィング用) |
| `list_tasks` | read | `view=today\|inbox\|all` 相当の一覧取得 |
| `create_task` | write | タスク追加。Claude が日本語を解釈し、構造化済み(`title, due_date, due_time, priority, tags`)で渡す |
| `update_task` | write | 更新(延期・タイトル変更・完了/未完了トグル) |
| `delete_task` | write | 削除 |

- JST の「今日」判定は Phase 1 と同様にサーバー側(`lib/time.ts`)で行い、Claude に日付境界を考えさせない
- `completed_at` と `status` の連動契約(セクション7)は MCP 経由の更新にもそのまま適用する
- write は1ツール1操作に分割し、クライアント側の承認カード(呼び出しごとの確認)を前提に設計する

### 認証

- MCP 標準の OAuth(Dynamic Client Registration)で保護する。実装は Cloudflare の
  `workers-oauth-provider` + agents SDK(`McpAgent`)を利用する
- **Access の除外は `/mcp` だけでは足りない**: クライアントはトークン取得前に OAuth の
  プロトコル用エンドポイントへアクセスするため、`/mcp` に加えて `/.well-known/*`(OAuthメタデータ)・
  `/register`(DCR)・`/token` も Access の保護対象から外す
- **認可画面 `/authorize` だけは Access 配下に残す**: クライアント登録は誰でもできるが、
  認可を承認できるのは Access を通過した自分だけになり、リソースオーナーの認証を Access に委譲できる
- **上記のパスはすべて `wrangler.jsonc` の `run_worker_first` に追加する**: 現状は `/api/*` のみのため、
  追加しないと `/mcp` などへのリクエストは静的アセット配信と SPA フォールバックに吸われて
  Worker のハンドラに到達しない
- 無認証での公開はしない(タスク内容は個人情報そのもの)

### 朝のブリーフィング

- cron・briefings テーブル・LLM API 呼び出しは作らない
- 解釈ロジックは Claude 側のスキルに置く: `skills/morning-briefing/SKILL.md` をリポジトリで管理し、
  claude.ai に登録する。内容は「`get_daily_summary` を呼び、この構成・トーンで要約する」という指示書
- 朝は Claude アプリに「今日のブリーフィングして」と話しかける。自動化したくなったら
  claude.ai のスケジュールタスク(定期実行プロンプト+コネクタ)を検討する
- Phase 2・3 でデータが増えたら、集約ツールとスキルを拡張するだけでブリーフィングに反映できる

### ChatGPT からの接続(オプション)

- 同じ MCP サーバーに ChatGPT のカスタムコネクタ(Developer mode)からも接続できる
- ただし Plus/Pro プランで write ツールを呼べるかは公式ドキュメントの記述が割れているため、
  接続テストで確認する(read はどのプランでも可)。不可なら ChatGPT は読み取り専用として使う
- ChatGPT の音声会話モードはツール呼び出し非対応。音声で使う場合はディクテーション
  (マイク入力→テキストチャット)を使う

## 11. 開発の進め方

### Phase 1 のタスク分解 (完了)

1. プロジェクト雛形: Hono + wrangler + D1 + React (Vite) のセットアップ、ローカル開発環境
2. マイグレーションと DB アクセス層、JSON API (`/api/*`)
3. React SPA: 今日 / Inbox / 一覧 / 詳細 の4画面、完了トグル(楽観的更新)、クイック追加
4. 音声入力 + 日付パーサー
5. PWA 化 (manifest, アイコン) と Cloudflare Access 設定、本番デプロイ

### Phase 4 のタスク分解

1. 最小 MCP サーバー + OAuth: Cloudflare の remote MCP テンプレート(`workers-oauth-provider` + `McpAgent`)を
   ベースに read 1個 + write 1個だけ実装し、`run_worker_first` への `/mcp`・OAuth 系パス追加と
   Access の除外設定(`/authorize` は Access 配下に残す)まで済ませてから、
   Claude アプリ / ChatGPT で接続確認(ChatGPT Plus での write 可否はここで白黒つける)。
   Access 除外より前に OAuth を入れることで、無認証で公開される期間を作らない
2. ツール一式の実装(`get_daily_summary` / `list_tasks` / `create_task` / `update_task` / `delete_task`)
3. ブリーフィング用スキル作成(`skills/morning-briefing/`)と実運用テスト
4. claude.ai スケジュールタスクによる自動ブリーフィングの検討

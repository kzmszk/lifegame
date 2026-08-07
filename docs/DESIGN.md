# lifegame 設計ドキュメント

「おれの秘書」= 自分専用のライフマネジメントWEBアプリ。
本ドキュメントは MVP(Phase 1: タスク管理)を中心とした全体設計をまとめる。

## 1. コンセプト

- 4つのモジュール(タスク・健康・運動・情報収集)を1つのアプリに統合する
- まずタスク管理を完成させ、同じ基盤の上に他モジュールを積み増す
- スマホのホーム画面から秘書に話しかけるように使える(音声入力・PWA)
- 利用者は自分ひとり。運用コストはゼロ(Cloudflare無料枠に収める)

## 2. ロードマップ

| Phase   | 状態             | 内容                                                                                                                                    |
| ------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1 (MVP) | 本番反映済み     | タスク管理: CRUD + 今日ビュー + 音声入力(音声→タスク化、ルールベースの日付解析)                                                         |
| 2       | 初版本番反映済み | 健康記録: 体重測定・運動実績の入力と履歴。グラフと習慣トラッキングは、記録を実運用して必要な比較が分かってから検討する                  |
| 3       | 初版本番反映済み | 情報収集支援: 外部 URL の手動保存、読むリスト、アーカイブ、Android Web Share Target。RSS と自動取得は初版に含めない                     |
| 4       | 本番反映済み     | 秘書のAI化: MCP サーバーを公開し、Claude 等のAIアシスタントからタスクを読み書き(追加含む)。朝のブリーフィングは Claude 側のスキルで生成 |
| 5       | 本番反映済み     | Google Calendar 連携: 予定を今日ビューに表示し、時刻つきの入力はタスクではなく予定として登録する(セクション12)                          |
| 6       | 本番反映済み     | 繰り返しタスク: 完了した瞬間に次の1件を作る(セクション13)                                                                               |

自前の LLM 呼び出し(Workers AI / Claude API)は導入しない。AI 機能(自然言語の解釈・要約・対話)は
MCP で接続した Claude 等のアシスタントに任せ、サーバーはデータの記録と提供に徹する(セクション10)。
実装は Phase 1 → 4 → 5 → 6 → Phase 2 初版の順で進めた。Phase 5 を健康記録と情報収集より
優先したのは、予定とタスクが分かれたままだと「今日なにをするか」を2つのアプリで確認する
必要があり、毎日使うアプリとしての価値が上がらないため。Phase 6 は元々 Phase 2 の一部だったが、
`tasks` の拡張だけで完結し新しいデータ源も認可スコープも増えないため、健康記録から切り離して
先に出した(セクション13)。Phase 3 初版は、手動保存からアーカイブまでの最小ループを定めて本番へ反映した
(セクション15)。

## 3. 技術スタック

| 層             | 採用技術                       | 備考                                                            |
| -------------- | ------------------------------ | --------------------------------------------------------------- |
| ランタイム     | Cloudflare Workers             | 無料枠 10万リクエスト/日で個人利用には十分                      |
| バックエンド   | Hono                           | 1つのWorkerでAPIと静的アセットを配信                            |
| フロントエンド | React + Vite (SPA)             | Workerから静的配信。API分離構造なのでUI層はいつでも乗り換え可能 |
| 言語           | TypeScript                     |                                                                 |
| DB             | Cloudflare D1 (SQLite)         | 無料枠 5GB                                                      |
| 音声入力       | Web Speech API (ブラウザ標準)  | 追加インフラ不要・無料。iOS Safari / Android Chrome 対応        |
| 認証           | Cloudflare Access (Zero Trust) | アプリコード側は認証を書かない。自分のGoogleアカウントのみ許可  |
| デプロイ       | wrangler                       | `wrangler deploy` のみ。CIは後で GitHub Actions 化              |

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
  due_date     TEXT,                           -- 期限 ('YYYY-MM-DD')
  due_time     TEXT,                           -- 期限時刻 ('HH:MM') 任意
  scheduled_date TEXT,                         -- 実行予定日 ('YYYY-MM-DD') 任意
  scheduled_time TEXT,                         -- 実行予定時刻 ('HH:MM') 任意
  priority     INTEGER NOT NULL DEFAULT 0,     -- 0:通常 1:高
  tags         TEXT NOT NULL DEFAULT '',       -- MVPはカンマ区切り
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
CREATE INDEX idx_tasks_status_due ON tasks(status, due_date);
CREATE INDEX idx_tasks_status_scheduled ON tasks(status, scheduled_date);
```

Phase 2 の健康記録は、用途の決まっていない汎用ログにはせず、種別ごとの不変条件を持つ
`health_entries` として追加する(セクション14)。

## 6. 画面設計 (Phase 1)

| パス         | 画面      | 内容                                                                                         |
| ------------ | --------- | -------------------------------------------------------------------------------------------- |
| `/`          | 今日      | 期限が今日以前の未完了タスク + 今日完了したタスク。最上部にクイック追加(テキスト+音声ボタン) |
| `/inbox`     | Inbox     | 期限なしの未完了タスク                                                                       |
| `/all`       | 一覧      | 全タスク(完了含む、新しい順)                                                                 |
| `/tasks/:id` | 詳細/編集 | タイトル・メモ・期限・優先度・タグの編集、削除                                               |

- パスは SPA のクライアントサイドルーティング
- モバイルファーストのシンプルな1カラムUI。下部タブで 今日 / Inbox / 一覧 を切替
- 完了チェックはタップで即時反映(楽観的更新)し、裏で API を呼ぶ。失敗時は元に戻してトースト表示

## 7. API (Phase 1)

SPA が利用する JSON API。

| メソッド/パス                                                | 役割                                                                                             |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `GET /api/tasks?view=today\|inbox\|all&limit=...&offset=...` | タスク一覧の取得                                                                                 |
| `GET /api/tasks/:id`                                         | タスク1件の取得                                                                                  |
| `POST /api/tasks/parse`                                      | テキスト解析のみ(**保存しない**)。`{ text }` を受け取り `TaskDraft` を返す。音声入力の確認UI用   |
| `POST /api/tasks`                                            | タスク作成。`{ text }` を受け取りパーサーで期限抽出、または構造化済み `{ title, due_date, ... }` |
| `PATCH /api/tasks/:id`                                       | 更新(完了トグル含む)                                                                             |
| `DELETE /api/tasks/:id`                                      | 削除                                                                                             |

### API契約の補足

- **タスク一覧はページングする**: `GET /api/tasks` は `limit` (1〜100、既定値100) と `offset` (0以上、既定値0) を受け付け、`{ tasks, truncated, next_offset }` を返す。`truncated` が `true` のときはレスポンスが上限で打ち切られており、`next_offset` を次の `offset` に指定して続きを取得する。`today` も同じレスポンス形式だが、通常は件数が少ない。並び順は既存のビューごとの順序を維持し、同順位では `id DESC` で安定させる。

- **`completed_at` は `status` と連動させる**: `PATCH` で `status` を `done` にする際は同一UPDATE文の中で
  `completed_at` に現在時刻を設定し、`open` に戻す際は `NULL` にクリアする(クライアントからは送らせない)。
  今日ビューの「今日完了したタスク」はこの `completed_at` で判定するため、この契約がないと完了タスクが再読み込みで消える
- **「今日」の判定は Asia/Tokyo の日付境界で行う**: `view=today` は期限または実行予定日が今日以前
  (`due_date <= 今日 OR scheduled_date <= 今日`)の未完了タスクと、
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

| ツール              | 種別  | 役割                                                                                                                                 |
| ------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `get_daily_summary` | read  | 今日のタスク・期限切れ・Inbox 件数・今日完了分を1回の呼び出しで返す集約ビュー(ブリーフィング用)                                      |
| `list_tasks`        | read  | `view=today\|inbox\|all` 相当の一覧取得。`limit` (既定値100) と `offset` を指定でき、`truncated` と `next_offset` で続きの有無を示す |
| `create_task`       | write | タスク追加。Claude が日本語を解釈し、構造化済み(`title, due_date, due_time, priority, tags`)で渡す                                   |
| `update_task`       | write | 更新(延期・タイトル変更・完了/未完了トグル)                                                                                          |
| `delete_task`       | write | 削除                                                                                                                                 |

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
- Phase 2 の健康記録は初版では MCP とブリーフィングに含めない。将来含める場合は
  専用スコープで再同意を得てから、集約ツールとスキルを拡張する(セクション14)

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

## 12. Phase 5: Google Calendar 連携の設計

方針: **予定は Google Calendar が持ち続け、lifegame は「読んで並べる」と「作る」だけを担う**。
同期はしない。セットアップ手順は [GCAL_SETUP.md](GCAL_SETUP.md) を参照。

### 役割分担: 時刻の有無で分ける

| 入力例                   | 行き先                 | 判定                         |
| ------------------------ | ---------------------- | ---------------------------- |
| 「明日15時に歯医者」     | Google Calendar の予定 | パーサーが `due_time` を返す |
| 「確定申告の書類を出す」 | lifegame の `tasks`    | `due_time` なし              |

既存の `lib/parse.ts` はすでに `due_date` と `due_time` を分けて返すため、
パーサーを変更せずに振り分けられる。実態としては「時刻あり = 人と約束した予定 /
時刻なし = 自分がやること」に一致するので、誤爆はほとんど起きない。
保険としてクイック追加の確認UIに「タスク / 予定」のトグルを置く。

### 対象カレンダー

**`private` (`kazumasa@gmail.com`) 一本**に固定する。

アカウントには `ThingToDo`・`実績`・`work 定常的`・`その他`・`家族` と、
UUID 名の無題カレンダーが20個以上ぶら下がっているが、いずれも直近半年でイベント0件の
死んだカレンダーだった(2026-08-04 時点で調査)。ホワイトリストも設定テーブルも作らない。

- `ThingToDo` は「定例的じゃない作業をこれで管理」という運用が続かなかったもの。
  この役割は lifegame の `tasks` が引き継ぐ
- 日本の祝日カレンダーは今日ビューには並べない(予定ではないため)。
  `get_daily_summary` にだけ含め、ブリーフィングで「今日は山の日」と言えるようにする

### 認証

- 利用者が自分ひとりなので、Worker に OAuth の認可フローは実装しない。
  ローカルで一度だけ同意して refresh token を取り、`wrangler secret` に置く
- Worker は refresh token → access token(有効1時間)に交換し、既存の `OAUTH_KV` にキャッシュする
- スコープは `calendar.events` のみ。購読カレンダーを含めた読み書きがこれ1つで足り、
  カレンダー一覧 API は使わないため `calendarlist` スコープは要求しない
- **OAuth 同意画面は「本番環境」に上げる**: 「テスト」のままだと refresh token が7日で失効し、
  一週間後に静かに壊れる

### API

| メソッド/パス                          | 役割                                                        |
| -------------------------------------- | ----------------------------------------------------------- |
| `GET /api/calendar/events?date=<日付>` | 指定日の予定一覧。既定は今日                                |
| `POST /api/calendar/events`            | 予定の作成。`{ title, date, start_time, end_time?, note? }` |

- **タスクの API とは分ける**。`GET /api/tasks?view=today` にイベントを混ぜ込まず、
  SPA から2本目のリクエストとして取得して後追いで差し込む。
  こうしておけば GCal が遅い・落ちる・トークンが切れたときに、
  これまで動いていたタスク表示まで道連れにしない
- **更新と削除は実装しない**。予定の編集は Google カレンダー側で行う。
  これにより双方向同期・競合解決・削除の伝播がまるごと不要になる
- 終了時刻の指定がない場合は開始から1時間とする

### Google Calendar API を呼ぶときの注意

- **`singleEvents=true` と `orderBy=startTime` を必ず付ける**。付けないと繰り返し予定が
  親イベント1件しか返らず、毎週のピアノやランチ会が今日ビューから消える
- 終日イベントは `start.date`、時刻ありは `start.dateTime` と別フィールドで返る。両方を扱う
- `timeMin` / `timeMax` は既存 `lib/time.ts` の JST 日境界を再利用する
  (Phase 1 の「今日」判定と同じ理由で、UTC 基準だと日付がずれる)
- `status` が `cancelled` の予定と、自分が `declined` した予定は除外する

### MCP への反映

- **`calendar:read` スコープを追加する**。Google Calendar は lifegame の D1 とは別のデータ源で、
  持ち主も別なので、`tasks:read` では読めないようにする。これがないと、
  「lifegame のタスクを読む」としか書かれていない同意画面で発行済みの既存の接続が、
  再同意なしにカレンダーを読めるようになってしまう
- スコープが無い場合、`get_daily_summary` は予定関連のキーを**空ではなく丸ごと省略**する。
  空配列は「予定がない」と読めてしまい、障害時に自由な一日を報告するのと同じ嘘になる
- `get_daily_summary` の戻り値に、その日の予定と祝日を追加する。
  Claude 側も Google Calendar コネクタを持ちうるが、「1回の呼び出しで今日を返す」という
  セクション10の趣旨を保つため、サーバー側で束ねる
- 予定の作成用 MCP ツールは追加しない。Claude から予定を作りたい場合は
  Claude 自身の Google Calendar コネクタを使うほうが自然で、ツールの重複を避ける

### Phase 5 のタスク分解

1. Google Cloud の設定と refresh token 取得 ([GCAL_SETUP.md](GCAL_SETUP.md))、
   トークン交換とKVキャッシュの実装
2. `GET /api/calendar/events` と、今日ビューへの時系列表示
3. `POST /api/calendar/events` と、クイック追加の振り分け・確認UI
4. `get_daily_summary` への予定・祝日の統合と、ブリーフィングスキルの更新

## 13. Phase 6: 繰り返しタスクの設計

方針: **繰り返しはルールではなくタスクそのものが持ち、完了した瞬間に次の1件を作る**。
「将来の予定表」を持たないので、既存の `tasks` テーブルと今日ビューの意味がそのまま通る。

Phase 2 のうち繰り返しタスクだけを切り出して先に作った。健康記録の初版は後から
`health_entries` とブラウザ専用 API として追加し、MCP の認可範囲は広げなかった(セクション14)。
繰り返しは `tasks` の拡張だけで完結し、外部 API もスコープも増えないため、独立して提供できる。

### 13.1 なぜ「次の1件だけ」なのか

案は2つあった。

- **A: 完了したら次を1件生成**(採用)。`tasks` に列を2つ足すだけ。`listTasks` / MCPツール /
  今日ビュー / Google 予定との合流は一切変更しなくて済む。未完了の繰り返しは常に1件なので、
  放置しても今日ビューが同じタスクで埋まらない
- **B: ルールから毎回展開**。`recurring_rules` テーブルを別に持ち、取得時に仮想タスクへ展開する。
  先の予定まで見通せるが、実体のないタスクを完了にするための `completions` テーブルが要り、
  `listTasks`・MCPツール・予定との合流のすべてに手が入る

単一ユーザーの「今日なにをするか」に対して B の見通しは要らない。A を採る。
**A の弱点は先の繰り返しを一覧できないこと**で、必要になったら「次回: 8/12」を詳細画面に
出すところから足す(`repeat_child_id` があるので追加の状態は要らない)。

### 13.2 不変条件: 繰り返しは open な回だけが持つ

**`repeat_rule` があるなら `status = 'open'`、`scheduled_date IS NOT NULL`、
`due_date IS NULL`、`due_time IS NULL`。**
完了時にルールを親から消し、生成した次回へ渡す。

最初の実装ではルールを完了後も残していた。するとレビューで、同じ不具合が4つの経路から出た
(完了状態での作成、完了済みへのルール追加、ルール追加と完了の競合の両順序)。どれも行き先は同じで、
**「done かつ繰り返しかつ次回なし」= 二度と戻ってこない繰り返し**。列ごとにガードを足して
塞いでいたが、不変条件が増えるたびにガードが増える構造で収束しなかった。

原因は、**done になった行の `repeat_rule` が意味を失うのに残り続け、あってはいけない状態が
表現可能だったこと**。ルールを open な回だけが持つようにすると、その状態は表現できなくなる。

副産物として冪等性が無料で手に入る。完了でルールが消えるので、**二度目の完了はもう繰り返しではなく、
生成分岐に入らない**。「完了 → 未完了に戻す → もう一度完了」で増殖する問題も起きない。

**完了を取り消したらどうなるか（そのままにすると決めた）**: 完了済みの親を未完了に戻すと、
親はルートを持たない**ただの単発タスク**として戻り、子はそのまま残る。同じ用事の未完了が2つ並ぶが、
「今日の分を戻した」「明日の分は既にある」であって状態は破綻していない。
**未完了の繰り返しは1件のまま**で、不変条件も成り立つ。再度完了しても生成分岐に入らないので増えない。
子を消すのは破壊的（戻すまでに編集されているかもしれない）、戻すこと自体を禁止するのは
誤タップの救済を塞ぐ。本物の取り消しが要るなら操作履歴の機能として別に考える。

**繰り返しの親を削除しても子には波及させない。** `repeat_child_id` は完了した回から次の
open の回へ向く片方向の履歴・表示用リンクであり、子のライフサイクルを所有しない。親を削除すると
リンク元も消えるので参照切れは残らず、子は独自に持つ `repeat_rule` とともに残って次の回を生成し続ける。
したがって削除は指定された1回だけを対象にし、「シリーズを止める」操作ではない。

トレードオフ: 完了済みの行は「これは毎週のタスクだった」という情報を失う。
`repeat_child_id` が非 NULL であることが「シリーズの一回だった」印になるので、
一覧の `↻` はそれで出せる。履歴からルールの内容までは辿れないが、生きているシリーズを
見れば分かるので実用上困らない。

### 13.3 スキーマ (migration 0004)

```sql
-- 実際には SQLite が既存テーブルへの CHECK 追加をできないため、
-- 新テーブル作成 → コピー → DROP → RENAME で入れ替える。
repeat_rule     TEXT,      -- NULL = 繰り返さない
repeat_child_id INTEGER,   -- 生成した次回。シリーズの一回だった印
scheduled_date  TEXT,      -- 実行予定日。期限とは別の概念
scheduled_time  TEXT,      -- 実行予定時刻
CHECK (scheduled_time IS NULL OR scheduled_date IS NOT NULL)
CHECK (repeat_rule IS NULL OR (
  status = 'open' AND scheduled_date IS NOT NULL AND due_date IS NULL AND due_time IS NULL
))
```

インデックスは足さない。`repeat_rule` で絞る問い合わせが無い(繰り返しは完了時に1件ずつ
たどるだけ)ため。

**CHECK 制約が正しさの担保**で、アプリ側の検証は**エラーメッセージのため**にある。
この2つは役割が違う。検証は「繰り返しには scheduled_date が必要です」のように理由を返すためのもので、
競合で検証をすり抜けた書き込みは制約が拒否する。制約違反を 409 に写すのは**更新の経路だけ**。
新しい行は何とも競合しないので、INSERT で制約が落ちたら「検証とスキーマが食い違っている」という
こちらの不具合であり、再試行のしようがない。そのまま 500 で出す。

制約が守れない種類の問題が1つある。**書き込みが意図した行に当たったかどうか**は状態の妥当性ではない。
`repeat_rule` は完了時に子へ移る唯一の列なので、ルールを書き換える更新は
「それがまだこの行にあるか」を WHERE で確かめる。確かめないと、同時に完了が走ったとき
「繰り返しをやめる」が既にルールを手放した親に当たって成功を返し、子は回り続ける。
保存される値はどれも妥当なので制約には引っかからない。

0004 はテーブルを再作成し、既存の繰り返し行(`repeat_rule` / `repeat_child_id` が非NULL、または
その `repeat_child_id` から参照される停止済みの末尾回)の旧 `due_*` を `scheduled_*` へ**移動**して
`due_*` をNULLにする。id・タイムスタンプ・
AUTOINCREMENT の高水位・インデックスは引き継ぐ。

### 13.3 `repeat_rule` の書式

RRULE (RFC 5545) は採らない。UI で出す選択肢が4種しかないのに、パーサーと未対応構文の
エラー処理を抱えることになる。自前の短い文字列にする。

| 値             | 意味                   |
| -------------- | ---------------------- |
| `daily`        | 毎日                   |
| `weekly:1,3,5` | 指定曜日 (0=日 … 6=土) |
| `monthly:15`   | 毎月15日               |
| `every:3`      | 3日ごと                |

`monthly:31` のように**その月に存在しない日は、その月の末日に丸める**(2月なら28/29日)。
飛ばすと2月と4月と6月と9月と11月に出てこなくなり、月次の請求や記録が抜ける。

検証は `src/lib/repeat.ts` に1箇所で置き、API・MCP・パーサーがそこを参照する
(セクション5章の反省「スコープ一覧は1箇所で定義して他所は参照する」と同じ理由)。
不正な値は 400 で弾き、DB には決して入れない。

### 13.4 次回の日付をどう決めるか

**基点は完了日ではなく、完了したタスクの `scheduled_date`**。毎週月曜のゴミ出しを火曜に片付けても、
次は翌週の月曜であるべきで、翌週の火曜ではない。

ただし基点をそのまま1回だけ進めると、1ヶ月放置していた場合に次回が過去日になり、
今日ビューに「期限切れ」として出た瞬間また過去を指す。そこで
**規則で進めることを、今日より後になるまで繰り返す**。

- 進める回数には**上限 10,000 回**を置き、超えたら 400 で断る。毎日の繰り返しなら約27年分に当たる。
  そこまで古い `scheduled_date` は入力ミスとして扱い、日付を入れ直してもらうほうが、
  黙って何万回も回すより早く気づける。`every:N` を 1〜366 に制限しているのと同じ理由で、
  **検証が通す範囲と計算できる範囲を揃える**ため
- `scheduled_date` が NULL の繰り返しタスク(Inbox の繰り返し)は**作らせない**。基点が無く
  次回を決められない。API と MCP で 400 にする
- `scheduled_time` はそのまま引き継ぐ。子の `due_date` / `due_time` は必ずNULLにする。
  `title` / `note` / `priority` / `tags` / `repeat_rule` も同じ
- `completed_at` は当然引き継がない。次回は `status = 'open'`

### 13.5 生成をどこに置くか

完了の経路は SPA (`PATCH /api/tasks/:id`) と MCP (`update_task`) の2つあるが、
**どちらも `src/db/tasks.ts` の `updateTask()` を通る**。生成はそこに置く。
ルート層や MCP ツール側に置くと、片方だけ繰り返しが回らない状態を作れてしまう。

条件は「`status` が `open` → `done` に変わり、`repeat_rule` がある」。D1 の `batch()` で3文を1回にまとめる。

1. 親を完了にし、**`repeat_rule` を NULL にして** `repeat_child_id = -1` を立てる。
   WHERE は `status = 'open'` と、**次回日付の計算根拠にした `repeat_rule` / `scheduled_date` の一致**
2. `repeat_child_id = -1` の行からコピーして次回を INSERT。ルールと次回日付はバインドで渡す
   (親のルールはもう消えているため)
3. `-1` を実際の子の id に置き換える

WHERE の一致条件は**値が古くなることを防ぐためだけに残している**。状態の正しさは CHECK 制約が
持っているので、ここで守るのは「読んだ `scheduled_date` から計算した次回日付が、その `scheduled_date` が
変わった後に書かれる」という**値の食い違い**のほう。制約では守れない種類の問題なのでこちらに置く。

`-1` のセンチネルは 2 と 3 を 1 に紐付けるためのもの。`batch()` はトランザクショナルなので
外からは見えない。

繰り返しタスクを**削除しても次回は生まれない**(未完了のまま消える)。既に次回を生成した
完了済みの親を削除する場合も、`repeat_child_id` が指す子は削除・更新せず、子が持つルールで
回り続ける。親とともにリンク元が消えるため、孤児化した参照は残らない。
繰り返しを止めたいときは `repeat_rule` を空にする。削除は「この1件を消す」であって
「繰り返しをやめる」ではない、と UI の文言でも分ける。

### 13.6 UI と API

新しいエンドポイントは作らない。既存の `POST /api/tasks` と `PATCH /api/tasks/:id` が
`repeat_rule` を受け取り、`Task` に載せて返すだけ。

- **クイック追加**: パーサー(`src/lib/parse.ts`)に「毎日」「毎週月曜」「毎月15日」「3日ごと」を
  足し、繰り返しなら `scheduled_date` / `scheduled_time`、単発なら `due_date` / `due_time` を
  `TaskDraft` に入れる。Phase 5 で入れた確認ダイアログに繰り返しを
  表示するので、誤爆はそこで直せる
- **詳細画面**: 繰り返しの選択(なし / 毎日 / 毎週(曜日) / 毎月(日) / N日ごと)。有効時は
  期限を「今回の実行日 / 実行時刻」に移して期限列をクリアする。無効化後も実行予定は単発の予定として残す
- **一覧・今日ビュー**: 繰り返しのタスクに `↻` を出す

### 13.7 MCP への影響と認可

`create_task` / `update_task` の入力に `repeat_rule` と `scheduled_date` / `scheduled_time` を足し、`list_tasks` と
`get_daily_summary` の出力に含める。

**新しいスコープは作らない**。繰り返しはタスクの属性であって新しいデータ源ではなく、
`tasks:read` / `tasks:write` の範囲に収まる。Phase 5 で Google Calendar を足したときは
ここを見直さなかったのが最大の反省だったので、今回は「見直した上で増やさない」と記録しておく。

### Phase 6 のタスク分解

1. migration 0003 と `src/lib/repeat.ts`(書式の検証と次回日付の計算)。ユニットテスト
2. `updateTask()` での次回生成、API と MCP ツールへの `repeat_rule` の導線
3. パーサーの繰り返し表現、詳細画面の設定 UI、一覧の `↻`
   (`↻` の条件は `repeat_rule !== null || repeat_child_id !== null`。
   完了済みの回はルールを持たないので、後者が無いと履歴で印が消える)
4. E2E: 繰り返しタスクを作る → 完了 → **リロード** → 次回が今日ビュー/一覧に居る

## 14. Phase 2: 健康記録の設計

方針: **最初は、入力した事実を正しく残して日付順に見返せるところまでに絞る**。
グラフや目標値は、実際の履歴が溜まり、見たい比較が分かってから追加する。

### 14.1 用語と最小スコープ

ドメイン用語はルートの [CONTEXT.md](../CONTEXT.md) に定義する。初版で扱う健康記録は2種類だけ。

- **体重測定 (Weight Measurement)**: kg 単位の正の数。1日1件に制限せず、朝晩など複数の測定を残せる
- **運動実績 (Exercise Session)**: 実施済みの運動。種目名は必須、時間(分)とメモは任意
- **記録対象日 (Occurrence Date)**: 利用者が指定する `YYYY-MM-DD` のローカル暦日。
  `created_at` から推測しないので、日をまたいだ後でも前日分を正しく記録できる

どちらも予定や目標ではなく、既に測定・実施した事実である。同日の記録は集約・上書きせず、
それぞれ独立した履歴として保持する。

### 14.2 データモデルと不変条件

用途の決まっていない `kind/value/unit` の汎用ログにはしない。2種類を判別可能な
`health_entries` にまとめ、種別ごとの値の組み合わせを DB の CHECK 制約でも守る。

```sql
CREATE TABLE health_entries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  kind             TEXT NOT NULL CHECK (kind IN ('weight', 'exercise')),
  occurred_on      TEXT NOT NULL,              -- 'YYYY-MM-DD'
  weight_kg        REAL,
  activity         TEXT,
  duration_minutes INTEGER,
  note             TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (kind = 'weight' AND weight_kg IS NOT NULL AND weight_kg > 0
      AND activity IS NULL AND duration_minutes IS NULL)
    OR
    (kind = 'exercise' AND weight_kg IS NULL AND activity IS NOT NULL
      AND length(trim(activity)) > 0
      AND (duration_minutes IS NULL
        OR duration_minutes BETWEEN 1 AND 1440))
  )
);
CREATE INDEX idx_health_entries_occurred
  ON health_entries(occurred_on DESC, id DESC);
```

日付が実在するか、数値が有限か、文字列長など利用者向けエラーに必要な検証はアプリ側で行い、
DB 制約は競合や実装漏れを含む不正状態の保存を最後に拒否する。単位は体重を kg、時間を分に固定し、
変換可能な `unit` 列は持たない。`kind` は作成後に変更できない。種類を間違えた場合は削除して作り直す。

DB モジュールの公開境界は次の4操作に絞る。SQL、制約エラーの解釈、安定した並び順、
ページングは `src/db/health-entries.ts` の内側に隠し、実 D1 を使うテストをこの境界に対して書く。

- `listHealthEntries({ from?, to?, limit, offset })`
- `createHealthEntry(input)`
- `updateHealthEntry(id, input)`
- `deleteHealthEntry(id)`

作成・更新の入力は `kind` で判別する union とし、体重測定へ運動用フィールドを渡すことや、
運動実績へ体重を渡すことを型と実行時検証の両方で防ぐ。

### 14.3 JSON API

ブラウザ用 API は既存の Cloudflare Access 配下に置く。タスク API と混ぜず、次の独立した境界にする。

| メソッド/パス                                                  | 役割                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `GET /api/health-entries?from=...&to=...&limit=...&offset=...` | 記録対象日の降順、同日内は `id DESC` で一覧。`from` / `to` は両端を含む任意の絞り込み |
| `POST /api/health-entries`                                     | 判別可能な入力で体重測定または運動実績を作成                                          |
| `PATCH /api/health-entries/:id`                                | 記録対象日と、その種類で許された値を修正。`kind` の変更は受け付けない                 |
| `DELETE /api/health-entries/:id`                               | 指定した健康記録を1件削除                                                             |

一覧は既定50件、最大100件とし、タスク一覧と同じ
`{ entries, truncated, next_offset }` 形式でページングする。`from > to`、不正な暦日、
種別と値の不一致は 400、存在しない更新・削除対象は 404 とする。初版には単体取得 API を作らない。

### 14.4 UI と履歴

SPA に `/health` と下部タブ「健康」を追加し、1画面の上から次の順に置く。

1. 体重測定の入力: 記録対象日(既定は今日)、体重 kg、任意メモ
2. 運動実績の入力: 記録対象日(既定は今日)、種目名、任意の時間(分)とメモ
3. 履歴: 記録対象日ごとにまとめ、日付降順・同日内は新しい記録順で表示

保存後は入力結果を履歴へ反映する。履歴の各行から修正・削除でき、続きを読み込む操作は
`next_offset` を使う。初版では「今日」と履歴を別画面に分けず、入力直後の確認と過去の訂正を
同じ場所で完結させる。

### 14.5 所有権、MCP、ブリーフィング

- 健康記録の持ち主は Cloudflare Access で許可された単一利用者。Phase 1 と同じ単一ユーザー前提なので
  `user_id` は追加しない
- **初版の健康記録はブラウザ API だけに公開し、MCP ツールと `get_daily_summary`、
  朝のブリーフィングには含めない**
- 既存の `tasks:read` / `tasks:write` / `calendar:read` は健康記録への権限を与えない。
  将来 MCP から読む場合は `health:read`、書く場合は `health:write` を追加し、既存クライアントに
  再同意を求めてからツールを公開する
- HealthKit、Fitbit、Google Fit など外部サービスへの同期・エクスポートも初版では行わない

健康情報はタスクより慎重に扱うべき別のデータ源であり、「既に接続済みだから」という理由で
同意範囲を暗黙に広げない。

### 14.6 明示的な非目標

- グラフ、増減傾向、目標体重、自己ベスト、ストリーク、カロリー計算
- 睡眠、血圧、体脂肪率、食事など3種類目以降の健康記録
- 運動予定、習慣リマインダー、繰り返しタスクとの自動連携
- ウェアラブルや外部ヘルスサービスからの自動取り込み
- 医療上の評価、助言、異常値判定
- 複数利用者、共有、公開プロフィール
- MCP と朝のブリーフィングからの参照・更新

### Phase 2 初版のタスク分解

実装は、下位の境界が安定してから上位を載せる。

1. `lifegame-160.1`: `health_entries` migration と DB モジュール、実 D1 テスト
2. `lifegame-160.2`: 共有型・検証と Access 配下の JSON API (1 に依存)
3. `lifegame-160.3`: `/health` の入力・履歴・修正・削除 UI (2 に依存)
4. `lifegame-160.4`: ブラウザ E2E と、MCP／ブリーフィングへ健康記録が露出しない契約の回帰確認 (3 に依存)

## 15. Phase 3: 保存リンクの設計

Phase 3 初版は **A: URL を手動で保存し、あとで読む** に絞る。RSS 購読や自動収集から始めず、
「見つけた URL を取り込む → 読むリストで見直す → アーカイブする」という最小ループが
日常的に役立つかを先に確かめる。

### 15.1 用語と利用シナリオ

- **保存リンク (Saved Link)**: 利用者があとで確認するために残した外部 URL。URL、任意の題名、任意のメモを持つ
- **読むリスト (Reading List)**: アーカイブしていない保存リンクの一覧
- **アーカイブ (Archive)**: 保存リンクを読むリストから外し、保持したまま参照可能にする操作

初版で完結させる利用シナリオは次の4つとする。

1. Android の共有メニューから Web ページを lifegame に渡し、内容を確認して保存する
2. 共有が使えない環境では `/reading` に URL を貼り付け、任意で題名・メモを付けて保存する
3. 読むリストから元ページを新しいタブで開き、確認後にアーカイブする
4. アーカイブしたリンクを戻す、題名・メモを直す、または完全に削除する

「Inbox」は既存のタスク Inbox と衝突するため使わない。「既読」も、ページを開いた事実を
自動追跡する設計ではないため使わない。

### 15.2 データモデルと不変条件

```sql
CREATE TABLE saved_links (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  url         TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  archived_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(url) BETWEEN 1 AND 2048),
  CHECK (length(title) <= 300),
  CHECK (length(note) <= 2000)
);
CREATE INDEX idx_saved_links_reading
  ON saved_links(archived_at, created_at DESC, id DESC);
```

- URL は `http:` と `https:` だけを受け付ける。`new URL(input).href` 相当で構文と基本表現を正規化するが、
  query と fragment は内容を識別する場合があるため削らない
- 正規化後の URL は1件だけ保持する。同じ URL が読むリストにあれば既存の保存リンクを返し、
  アーカイブにあれば読むリストへ戻す。再保存で既存のメモを消さず、空の題名だけを新しい題名で補う
- `archived_at` は API がアーカイブ操作時に設定・解除する。クライアントから任意の日時は受け取らない
- 一覧は読むリストを `created_at DESC, id DESC`、アーカイブを `archived_at DESC, id DESC` で安定して並べる
- 外部 URL を Worker から取得しない。題名は共有元から渡された値または利用者入力だけを保存し、
  空なら UI が hostname と URL を表示する。これにより初版には SSRF、スクレイピング失敗、本文の著作権・保存領域を持ち込まない

DB モジュールの公開境界は次の4操作に絞る。SQL、URL 正規化、重複時の再利用、制約エラーの解釈、
安定した並び順とページングは `src/db/saved-links.ts` の内側に隠し、実 D1 を使うテストをこの境界に対して書く。

- `listSavedLinks({ view, limit, offset })`
- `createSavedLink({ url, title?, note? })`
- `updateSavedLink(id, { title?, note?, archived? })`
- `deleteSavedLink(id)`

将来 RSS を追加するときも保存先としてこの境界を再利用できるが、初版では feed、source、publication date、
汎用的な `InformationItem` 抽象を先回りして導入しない。

### 15.3 JSON API

ブラウザ用 API は既存の Cloudflare Access 配下に置き、タスク API と独立させる。

| メソッド/パス                                                     | 役割                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /api/saved-links?view=reading\|archive&limit=...&offset=...` | 読むリストまたはアーカイブの一覧                                               |
| `POST /api/saved-links`                                           | URL と任意の題名・メモから保存リンクを作成。重複なら上記の再保存規則を適用     |
| `PATCH /api/saved-links/:id`                                      | 題名・メモを修正、または `archived: true/false` でアーカイブ／読むリストへ戻す |
| `DELETE /api/saved-links/:id`                                     | 指定した保存リンクを完全に削除                                                 |

一覧は既定50件、最大100件とし、`{ links, truncated, next_offset }` 形式でページングする。
不正な URL・文字数・view・ページングは 400、存在しない更新・削除対象は 404 とする。
POST の応答には `outcome: "created" | "existing" | "restored"` を含め、UI が新規保存、既存、
アーカイブからの復帰を区別できるようにする。

初版は保存リンクを MCP、`get_daily_summary`、朝のブリーフィングへ公開しない。既存の OAuth scope は
保存リンクへの権限を与えない。将来必要になった時点で `links:read` / `links:write` と利用者の再同意を設計する。

### 15.4 UI

SPA に `/reading` と下部タブ「読む」を追加する。画面上部に URL、任意の題名、任意のメモの保存フォーム、
その下に「読むリスト／アーカイブ」の切り替えと一覧を置く。

一覧の各行は、題名（空なら hostname）、URL、メモ、保存日時を表示し、次の操作を持つ。

- 元ページを新しいタブで開く (`target="_blank"`, `rel="noopener noreferrer"`)
- アーカイブ／読むリストへ戻す
- 題名とメモを編集する
- 確認後に完全削除する

現在の下部ナビゲーションは4項目かつ各ボタン `min-width: 82px` なので、5項目化では各項目を等幅、
`min-width: 0` にして 320px 幅でも横にはみ出さないことを UI テストで固定する。保存・更新中の二重操作を防ぎ、
失敗時はその行またはフォームに再試行可能なエラーを表示する。

### 15.5 Android の Web Share Target

インストール済み PWA を Android の共有先として登録するため、manifest に次を追加する。

```json
{
  "share_target": {
    "action": "/reading/share",
    "method": "GET",
    "params": {
      "title": "title",
      "text": "text",
      "url": "url"
    }
  }
}
```

`GET` は DB 更新を行わず、`/reading/share` の確認フォームへ値を入れるだけとする。保存は利用者が確認後に
通常の `POST /api/saved-links` を実行する。初版で service worker に POST body の受け渡し責務を追加せず、
共有と手入力を同じ保存経路へ合流させるための境界である。

共有元によって `url` が空で `text` や `title` に URL が入るため、`url`、`text`、`title` の順に最初の
`http:` / `https:` URL を抽出し、残った title を題名候補にする。値は信頼せず通常の URL・文字数検証を通す。
SPA は値を読み取った直後に `history.replaceState` で query を履歴から除くが、GET の request URL は
ネットワークや Access のログに残り得る。この制約を初版の既知のトレードオフとし、機密 URL には手入力も含め
使わない。共有先として表示されないブラウザや未インストール時のため、通常の貼り付けフォームを常に残す。

Web Share Target 自体は広いブラウザ互換性を前提にせず、受け入れ条件を「対象 Android 端末の Chrome で、
インストールした本番 PWA が URL 共有を確認フォームまで運べること」とする。

### 15.6 セキュリティと検証

- 共有入力、API 入力、DB モジュールでは URL を構文解析して `http:` / `https:` だけを受け付け、
  `javascript:`、`data:`、壊れた URL を拒否する。D1 の `CHECK` でも `http://` / `https://` の形と
  文字列長を独立して強制する（SQLite の `CHECK` だけで URL 構文全体は再実装しない）
- 外部ページをサーバーから取得しない。題名・メモはプレーンテキストとして React に描画する
- JSON API と共有先画面はいずれも Cloudflare Access の既存認証境界内に置く
- 実 D1 テストで作成、正規化、重複、アーカイブ復帰、安定した一覧、修正、削除、制約違反を確認する
- route と component テストで共有パラメータの各配置、不正入力、履歴からの query 除去、320px の5タブを確認する
- ブラウザ E2E で手入力から保存、reload 後の保持、外部リンク、アーカイブ／復帰、編集、削除を確認する
- 本番受け入れでは Android 共有を確認し、対象端末が自動化できない場合は手順と実施結果をリリース記録に残す

### 15.7 明示的な非目標

- RSS/Atom の購読、feed discovery、定期 polling、自動取り込み
- 外部ページの metadata・favicon・OGP・本文の取得、オフライン保存
- タグ、検索、フォルダ、推薦、ソーシャル共有
- AI 要約、分類、優先順位付け
- MCP、朝のブリーフィング、他サービスへの公開
- ファイル・画像・共有テキストだけの保存
- 「開いたら既読」の自動追跡、閲覧履歴、読了率

### Phase 3 初版のタスク分解

下位の保存境界から順に実装する。

1. `lifegame-5yn.1`: `saved_links` migration、DB モジュール、実 D1 テスト
2. `lifegame-5yn.2`: 共有型・検証と Access 配下の JSON API、MCP 非公開の回帰確認 (1 に依存)
3. `lifegame-5yn.3`: `/reading` の手入力・読むリスト・アーカイブ UI と5タブ対応 (2 に依存)
4. `lifegame-5yn.4`: Android Web Share Target と保存前の確認経路 (3 に依存)
5. `lifegame-5yn.5`: ブラウザ E2E、本番 smoke、デプロイ、実 Android での受け入れ確認 (4 に依存)

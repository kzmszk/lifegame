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
| 4 | 秘書のAI化: 自然言語でのタスク操作、朝のブリーフィング生成(Workers AI → 必要ならClaude API) |

AI(LLM)は Phase 4 まで導入しない。まず手動+音声入力で確実に動くものを作る。

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

- 選定理由: 先のフェーズほどUIがインタラクティブになる(Phase 2 グラフ、Phase 4 チャットUI)。
  自分専用アプリなので SSR の強み(SEO・JS無効対応)は活きない。
  毎日スマホのホーム画面から使うため、画面遷移のないアプリらしい操作感を優先する
- 乗り換え保険: UI と API (`/api/*`)・D1・パーサーを分離しておくことで、
  万一UI技術を変えたくなってもビュー層だけ捨てれば済む構造を維持する
- 完了トグルは楽観的更新(タップで即時反映→裏でAPI)、追加も画面遷移なし
- PWA: `manifest.json` を配信してホーム画面に追加可能にする。オフライン対応(Service Worker)は Phase 2 以降

## 4. アーキテクチャ

```
[ブラウザ (スマホ/PC, PWA)]
   │  HTML (SSR) / form POST / fetch
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

- wrangler の assets 設定で `run_worker_first: ["/api/*"]` とし、それ以外は静的配信。
  `not_found_handling: "single-page-application"` で SPA のルーティングにフォールバックさせる
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
| `POST /api/tasks` | タスク作成。`{ text }` を受け取りパーサーで期限抽出、または構造化済み `{ title, due_date, ... }` |
| `PATCH /api/tasks/:id` | 更新(完了トグル含む) |
| `DELETE /api/tasks/:id` | 削除 |

## 8. 音声入力の設計

1. クイック追加の🎤ボタン → Web Speech API (`SpeechRecognition`, `lang: 'ja-JP'`) で認識
2. 認識テキストを `POST /api/tasks` に送信
3. サーバー側 `lib/parse.ts` がルールベースで期限を抽出してタスク化
   - 例: 「明日の15時に歯医者」→ `{ title: '歯医者', due_date: <明日>, due_time: '15:00' }`
   - 対応パターン: 今日 / 明日 / 明後日 / ◯曜日 / 来週 / ◯月◯日 / ◯時(半)
   - 解析できない部分はそのままタイトルに残す(壊れない設計)
4. 登録前に確認UIを一瞬挟み、誤認識はその場で修正できるようにする

日付パーサーはタイムゾーン(Asia/Tokyo)を固定して判定する。
Phase 4 でこのパーサーを LLM に差し替え可能なよう、`parse(text) → TaskDraft` のインターフェースに閉じ込める。

## 9. 認証・セキュリティ

- Cloudflare Access で Worker への全リクエストを保護し、自分のアカウントのみ許可する
- アプリ側では認証コードを書かない(Access が JWT を検証済みの前提)
- 念のため `Cf-Access-Authenticated-User-Email` ヘッダを検証するミドルウェアを1枚入れる

## 10. 開発の進め方 (Phase 1 のタスク分解)

1. プロジェクト雛形: Hono + wrangler + D1 + React (Vite) のセットアップ、ローカル開発環境
2. マイグレーションと DB アクセス層、JSON API (`/api/*`)
3. React SPA: 今日 / Inbox / 一覧 / 詳細 の4画面、完了トグル(楽観的更新)、クイック追加
4. 音声入力 + 日付パーサー
5. PWA 化 (manifest, アイコン) と Cloudflare Access 設定、本番デプロイ

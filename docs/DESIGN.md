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
| バックエンド | Hono | 1つのWorkerでAPI・ページ・静的アセットを全部配信 |
| フロントエンド | 2タイプを並行試作(下記) | UI層だけ2種類作り、使い比べて片方に絞る |
| 言語 | TypeScript | |
| DB | Cloudflare D1 (SQLite) | 無料枠 5GB |
| 音声入力 | Web Speech API (ブラウザ標準) | 追加インフラ不要・無料。iOS Safari / Android Chrome 対応 |
| 認証 | Cloudflare Access (Zero Trust) | アプリコード側は認証を書かない。自分のGoogleアカウントのみ許可 |
| デプロイ | wrangler | `wrangler deploy` のみ。CIは後で GitHub Actions 化 |

### フロントエンドの方針: 2タイプ並行試作

リッチなUIが欲しくなる可能性があるため、**UI層だけ2タイプ作って使い比べる**。
D1・API・日付パーサーはすべて共有し、二重になるのはビューだけに抑える。

| | Type A: SSR版 | Type B: SPA版 |
|--|--------------|---------------|
| 技術 | Hono JSX (サーバーレンダリング) | React + Vite |
| パス | `/` 配下 | `/app` 配下 |
| 特徴 | 軽量・シンプル。form POSTベースで確実に動く | リッチなUI・画面遷移なしの操作感。アニメーションや楽観的更新がやりやすい |
| 音声入力 | 小さなクライアントJSで対応 | Reactコンポーネントとして対応 |

- 両タイプとも同じ `/api/*` (JSON API) を叩く。機能差はつけない
- MVP(今日ビュー+クイック追加+完了トグル)を両方で作り、スマホで1〜2週間使い比べる
- **Phase 2 に進む前にどちらかに絞り、負けた方は削除する**(併存させ続けない)
- PWA: `manifest.json` を配信してホーム画面に追加可能にする。オフライン対応(Service Worker)は Phase 2 以降

## 4. アーキテクチャ

```
[ブラウザ (スマホ/PC, PWA)]
   │  HTML (SSR) / form POST / fetch
   ▼
[Cloudflare Access]  ← 自分のアカウントだけ通す
   ▼
[Worker: Hono アプリ]
   ├─ /api/*   JSON API(両UIで共有)
   ├─ /        Type A: SSR版 UI (Hono JSX)
   ├─ /app/*   Type B: SPA版 UI (React, ビルド済み静的アセット)
   └─ 静的アセット (manifest.json, client.js, icon)
   ▼
[D1 (SQLite)]
```

### ディレクトリ構成(予定)

```
src/                 # Worker 本体
  index.tsx          # Hono アプリのエントリ
  routes/
    api.ts           # /api/* (両UI共有の JSON API)
    pages.tsx        # Type A のページルート
  views/             # Type A の JSX コンポーネント
  db/                # D1 アクセス(クエリ関数)
  lib/
    parse.ts         # 音声テキストの日付・時刻パーサー
  shared/
    types.ts         # Task 型など、Worker と SPA で共有する型
web/                 # Type B: React SPA (Vite プロジェクト)
  src/
  vite.config.ts     # ビルド出力を public/app/ へ
public/              # 静的アセット (client.js, manifest.json, icons, app/)
migrations/          # D1 マイグレーション SQL
wrangler.jsonc
```

- `/api/*` と Type A のページは Worker が処理し、`/app` 配下は静的アセットとして配信する
  (wrangler の assets 設定で `run_worker_first: ["/api/*", "/", "/inbox", ...]` を指定)
- API のリクエスト/レスポンス型は `src/shared/types.ts` に置き、両UIから import して型を揃える

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

- モバイルファーストのシンプルな1カラムUI。下部タブで 今日 / Inbox / 一覧 を切替
- 完了チェックはチェックボックス(JS有効ならfetchで即時反映、無効ならform POST)

## 7. API (Phase 1)

ページ用の form POST とは別に、クライアントJS用の JSON API を用意する。

| メソッド/パス | 役割 |
|---------------|------|
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

1. プロジェクト雛形: Hono + wrangler + D1 セットアップ、ローカル開発 (`wrangler dev`)
2. マイグレーションと DB アクセス層、共有 JSON API (`/api/*`)
3. Type A (SSR版): 今日 / Inbox / 一覧 / 詳細 + クライアントJS(完了トグル、クイック追加)
4. Type B (SPA版): React + Vite で同じ4画面を実装、`/app` 配下に配信
5. 音声入力 + 日付パーサー(両UIに組み込み)
6. PWA 化 (manifest, アイコン) と Cloudflare Access 設定、本番デプロイ
7. 1〜2週間使い比べて Type A / B のどちらかに決定、負けた方を削除して Phase 2 へ

# Google Calendar 連携のセットアップ

Worker から Google Calendar を読み書きするための、初回だけ必要な作業手順。
設計の背景は [DESIGN.md](DESIGN.md) のセクション12を参照。

利用者は自分ひとりなので、Worker 側に OAuth の認可フローは実装しない。
ローカルで一度だけ同意して refresh token を取り、Worker のシークレットとして置くだけで済む。

## 1. Google Cloud プロジェクトと API の有効化

1. [Google Cloud Console](https://console.cloud.google.com/) で新規プロジェクトを作る(名前は `lifegame` など)
2. 「APIとサービス」→「ライブラリ」→ **Google Calendar API** を有効化

## 2. OAuth 同意画面

「APIとサービス」→「OAuth 同意画面」で設定する。

- User Type: **外部** (個人の Gmail アカウントなので「内部」は選べない)
- アプリ名・サポートメール・デベロッパー連絡先: 自分のもの
- スコープ: ここでは追加しなくてよい(認可リクエスト側で指定する)
- テストユーザー: 自分のアカウント (`kazumasa@gmail.com`) を追加

> [!IMPORTANT]
> 設定後、公開ステータスを **「本番環境」(In production)** に変更すること。
> 「テスト」のままだと **refresh token が7日で失効する**。審査は不要で、ボタンを押すだけで移行できる。
>
> これを忘れると「一週間後に突然、しかも静かに壊れる」という一番デバッグしづらい形で出る。
> 未確認アプリの警告画面は出るが、自分のアカウントなら「詳細」→「安全でないページに移動」で通れる。

## 3. OAuth クライアント ID

「APIとサービス」→「認証情報」→「認証情報を作成」→「OAuth クライアント ID」

- アプリケーションの種類: **デスクトップアプリ**
- 発行された **クライアント ID** と **クライアントシークレット** を控える

デスクトップアプリならループバックのリダイレクト URI が無登録で使えるので、
リダイレクト URI の登録作業は不要。

## 4. refresh token を取得する

```bash
GOOGLE_CLIENT_ID=<クライアントID> GOOGLE_CLIENT_SECRET=<シークレット> node scripts/get-google-refresh-token.mjs
```

表示された URL をブラウザで開いて承認すると、ターミナルに refresh token が出力される。

再実行しても refresh token が返らない場合は、
[アカウントのアクセス権](https://myaccount.google.com/permissions) からこのアプリを削除してやり直す
(Google は同じクライアントへの再認可では refresh token を省くことがある)。

## 5. Worker に登録する

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
```

ローカル開発では git 管理外の `.dev.vars` に同じ3つを書く。

```
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
```

## 6. 動作確認

```bash
npm run dev
```

`GET /api/calendar/events` が今日の予定を返せば成功。

```bash
curl -s http://localhost:8787/api/calendar/events
```

日付を指定する場合は `?date=2026-08-05` のように YYYY-MM-DD で渡す
(`today` のような相対表現は受け付けず 400 になる)。

## メンテナンス

refresh token が無効になる条件は以下。いずれも起きたら手順4からやり直す。

- [アカウントのアクセス権](https://myaccount.google.com/permissions) から手動で失効させた
- Google アカウントのパスワードを変更した
- 6か月以上まったく使われなかった
- OAuth 同意画面を「テスト」に戻した(7日で失効する)

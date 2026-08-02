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
まずは Phase 1 (タスク管理 MVP) から開発する．

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

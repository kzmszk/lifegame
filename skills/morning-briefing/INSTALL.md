# 朝のブリーフィングの導入手順

このスキルは [SKILL.md](SKILL.md) の1ファイルだけで完結する。中身はクライアント非依存で、
必要なのは **lifegame の MCP サーバーに接続済みであること** だけ。

MCP サーバーの URL は末尾の `/mcp` まで含める。

```
https://lifegame.tachicoma.com/mcp
```

## すでに接続済みの場合は繋ぎ直す

Google Calendar 連携で `calendar:read` スコープが増えた。**それ以前に作った接続はこの
スコープを持たない**ので、繋いだままではブリーフィングに「予定」が一切出てこない
(`get_daily_summary` の応答から予定関連のキーごと消える。仕様どおりの動作)。

一度切断してから接続し直し、同意画面で `calendar:read` を含めて許可する。

- claude.ai: 設定 → コネクタ → lifegame を削除して再登録
- Claude Code / Codex CLI: `codex mcp login lifegame` などで再認可する

lifegame 側の接続一覧(アプリの設定画面)からも切断できる。

## Claude アプリ / claude.ai

1. ZIP を作る

   ```sh
   npm run skill:zip
   ```

   `dist/morning-briefing.zip` ができる。

2. claude.ai の設定 → Capabilities → Skills からアップロードする
3. コネクタとして上記 URL を登録する(クライアント名は不要。DCR で自動登録される)

## Claude Code

`skills/morning-briefing/` をコピーするだけ。プロジェクト内で使うなら:

```sh
mkdir -p .claude/skills && cp -r skills/morning-briefing .claude/skills/
```

どのリポジトリでも使いたいなら `~/.claude/skills/` に置く。

## Codex CLI

スキルの形式は Claude と同じ。置き場所が `~/.codex/skills/` になるだけ。

```sh
mkdir -p ~/.codex/skills && cp -r skills/morning-briefing ~/.codex/skills/
```

`mkdir -p` を省かないこと。`~/.codex/skills` が存在しない環境では、`cp -r` がそのパスを
コピー先ディレクトリそのものとして作り、`~/.codex/skills/SKILL.md` に置かれてしまう
(正しくは `~/.codex/skills/morning-briefing/SKILL.md`)。この状態だとスキルは認識されない。

MCP サーバーの接続は Codex 側で別途行う(0.145.0 で確認):

```sh
codex mcp add lifegame --url https://lifegame.tachicoma.com/mcp
codex mcp login lifegame
```

`codex mcp login` はブラウザで OAuth を通す。lifegame の `/authorize` は Cloudflare Access の
内側にあるので、**先に Access のログインを済ませておく**とそのまま承認画面に進める。
接続できているかは `codex mcp list` で確認する。

## 動作確認

接続後、「今日のブリーフィングをして」と話しかける。`get_daily_summary` が1回だけ呼ばれ、
SKILL.md の構成で返れば正しい。タスクが1件も無いときは各セクションが「なし」になる。

「予定」の節がまるごと出てこない場合は、`calendar:read` が許可されていない。
上の「すでに接続済みの場合は繋ぎ直す」を実施する。

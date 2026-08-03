# 朝のブリーフィングの導入手順

このスキルは [SKILL.md](SKILL.md) の1ファイルだけで完結する。中身はクライアント非依存で、
必要なのは **lifegame の MCP サーバーに接続済みであること** だけ。

MCP サーバーの URL は末尾の `/mcp` まで含める。

```
https://lifegame.tachicoma.com/mcp
```

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
cp -r skills/morning-briefing ~/.codex/skills/
```

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
SKILL.md の6セクション構成で返れば正しい。タスクが1件も無いときは各セクションが「なし」になる。

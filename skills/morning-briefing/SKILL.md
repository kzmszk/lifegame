---
name: morning-briefing
description: Use when the user asks for today's lifegame briefing or morning task summary.
---

# lifegame 朝のブリーフィング

lifegame の MCP サーバーに接続した状態で使う。「今日のブリーフィングをして」と依頼されたら、
まず `get_daily_summary` を1回だけ呼び出す。クライアントによってはツール名に接続名の接頭辞が付く
(`lifegame__get_daily_summary` など)。名前が一致しなくても、末尾が `get_daily_summary` の
ツールを使う。

日付や「今日」の境界はツールが返す `date` に従い、推測しない。サーバーは JST で判定している。

## 返す形式

日本語・簡潔・実行しやすい調子で、次の固定構成にする。

1. `## 今日（YYYY-MM-DD）` — 今日の全体像を1〜2文
2. `### 期限切れ` — `overdue_tasks` を優先度と期限つきで列挙。なければ「なし」
3. `### 今日の予定` — `due_today_tasks` を時刻順で列挙。なければ「なし」
4. `### Inbox` — `inbox_count` 件。多い場合だけ整理を促す
5. `### 今日の完了` — `completed_today_tasks` を列挙。なければ「なし」
6. `### まずやること` — 重要度と期限から、今すぐ着手する候補を最大3件

`open_tasks` は `overdue_tasks` と `due_today_tasks` を合わせたものなので、別枠で列挙しない
(二重に数えることになる)。

## やらないこと

- タスクのタイトル・期限・メモを勝手に変更しない
- 完了・削除などの書き込みは、ユーザーが明示的に依頼したときだけ行う
- サマリーに無い情報を補わない。空なら「なし」と書く

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SavedLink } from '../../../src/shared/types';
import { BottomTabs } from './BottomTabs';
import { SavedLinkForm, SavedLinkList } from './ReadingPage';

const link: SavedLink = {
  id: 1,
  url: 'https://example.com/article',
  title: '読む記事',
  note: 'あとで確認',
  archived_at: null,
  created_at: '2026-08-07 01:00:00',
  updated_at: '2026-08-07 01:00:00',
};

describe('読むリストのコンポーネント', () => {
  it('URL・題名・メモを確認して保存できるフォームを表示する', () => {
    const html = renderToStaticMarkup(
      <SavedLinkForm onSaved={() => Promise.resolve()} />,
    );

    expect(html).toContain('URL');
    expect(html).toContain('required');
    expect(html).toContain('題名');
    expect(html).toContain('メモ');
    expect(html).toContain('読むリストに保存');
  });

  it('Android 共有の URL と題名を自動保存せず確認フォームへ入れる', () => {
    const html = renderToStaticMarkup(
      <SavedLinkForm
        initialDraft={{
          url: 'https://example.com/shared',
          title: '共有された題名',
        }}
        onSaved={() => Promise.resolve()}
      />,
    );

    expect(html).toContain('value="https://example.com/shared"');
    expect(html).toContain('value="共有された題名"');
    expect(html).toContain('<form');
  });

  it('安全な外部リンクと編集・アーカイブ・削除操作を表示する', () => {
    const html = renderToStaticMarkup(
      <SavedLinkList
        links={[link]}
        view="reading"
        truncated
        loadingMore={false}
        loadMoreError={null}
        onLoadMore={() => undefined}
        onUpdated={() => Promise.resolve()}
        onDeleted={() => Promise.resolve()}
      />,
    );

    expect(html).toContain('href="https://example.com/article"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('編集');
    expect(html).toContain('アーカイブ');
    expect(html).toContain('削除');
    expect(html).toContain('さらに読み込む');
  });

  it('5項目の下部ナビゲーションから読むリストを選べる', () => {
    const html = renderToStaticMarkup(<BottomTabs view="reading" />);

    expect(html.match(/<button/g)).toHaveLength(5);
    expect(html).toContain('読む');
    expect(html).toContain('class="active"');
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { clearShareTargetQuery, parseShareTarget } from './share-target';

describe('Web Share Target', () => {
  it('url、text、title の優先順で Android 共有の URL を取り出す', () => {
    expect(
      parseShareTarget(
        new URLSearchParams({
          title: '記事の題名',
          text: '本文 https://text.example/article',
          url: 'https://url.example/article?x=1#part',
        }),
      ),
    ).toEqual({
      url: 'https://url.example/article?x=1#part',
      title: '記事の題名',
    });
    expect(
      parseShareTarget(
        new URLSearchParams({
          title: 'Android から共有',
          text: 'あとで読む https://text.example/article',
        }),
      ),
    ).toEqual({
      url: 'https://text.example/article',
      title: 'Android から共有',
    });
    expect(
      parseShareTarget(
        new URLSearchParams({ title: 'https://title.example/article' }),
      ),
    ).toEqual({ url: 'https://title.example/article', title: '' });
  });

  it('http/https 以外と壊れた値をフォームへ入れない', () => {
    expect(
      parseShareTarget(
        new URLSearchParams({
          title: '危険な共有',
          url: 'javascript:alert(1)',
          text: 'data:text/html,hello',
        }),
      ),
    ).toEqual({ url: '', title: '危険な共有' });
  });

  it('共有 query をブラウザ履歴から除く', () => {
    const replaceState = vi.fn();
    clearShareTargetQuery({ replaceState });
    expect(replaceState).toHaveBeenCalledWith({}, '', '/reading');
  });

  it('manifest が保存前確認用の GET share_target を登録する', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'),
    ) as Record<string, unknown>;
    expect(manifest.share_target).toEqual({
      action: '/reading/share',
      method: 'GET',
      params: { title: 'title', text: 'text', url: 'url' },
    });
  });
});

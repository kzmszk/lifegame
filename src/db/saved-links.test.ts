import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
  createSavedLink,
  deleteSavedLink,
  listSavedLinks,
  SavedLinkValidationError,
  updateSavedLink,
} from './saved-links';

describe('実 D1 上の保存リンク', () => {
  it('保存したリンクを読むリストから取得できる', async () => {
    const result = await createSavedLink(env.DB, {
      url: 'https://example.com/article?from=share#section',
      title: 'あとで読む記事',
      note: '週末に確認',
    });

    expect(result).toMatchObject({
      outcome: 'created',
      link: {
        id: expect.any(Number),
        url: 'https://example.com/article?from=share#section',
        title: 'あとで読む記事',
        note: '週末に確認',
        archived_at: null,
      },
    });

    const page = await listSavedLinks(env.DB, { view: 'reading' });
    expect(page).toMatchObject({ truncated: false, next_offset: null });
    expect(page.links).toEqual([result.link]);
  });

  it('同じ URL を再利用し、アーカイブ済みならメモを保って読むリストへ戻す', async () => {
    const first = await createSavedLink(env.DB, {
      url: 'HTTPS://EXAMPLE.COM:443/article?x=1#part',
      note: '残しておくメモ',
    });

    const existing = await createSavedLink(env.DB, {
      url: 'https://example.com/article?x=1#part',
      title: '共有された題名',
      note: '上書きしないメモ',
    });
    expect(existing).toMatchObject({
      outcome: 'existing',
      link: {
        id: first.link.id,
        title: '共有された題名',
        note: '残しておくメモ',
      },
    });

    await updateSavedLink(env.DB, first.link.id, { archived: true });
    const restored = await createSavedLink(env.DB, {
      url: 'https://example.com/article?x=1#part',
      title: '別の題名',
      note: '上書きしない別メモ',
    });
    expect(restored).toMatchObject({
      outcome: 'restored',
      link: {
        id: first.link.id,
        title: '共有された題名',
        note: '残しておくメモ',
        archived_at: null,
      },
    });
  });

  it('不正な URL と文字数超過を D1 へ渡す前に拒否する', async () => {
    await expect(
      createSavedLink(env.DB, { url: 'javascript:alert(1)' }),
    ).rejects.toThrow(SavedLinkValidationError);
    await expect(
      createSavedLink(env.DB, {
        url: 'https://example.com',
        title: '題'.repeat(301),
      }),
    ).rejects.toThrow(SavedLinkValidationError);
    await expect(
      createSavedLink(env.DB, {
        url: 'https://example.com',
        note: 'メ'.repeat(2001),
      }),
    ).rejects.toThrow(SavedLinkValidationError);
  });

  it('題名とメモを直してアーカイブし、完全に削除できる', async () => {
    const created = await createSavedLink(env.DB, {
      url: 'https://example.com/edit',
    });

    const archived = await updateSavedLink(env.DB, created.link.id, {
      title: '修正した題名',
      note: '修正したメモ',
      archived: true,
    });
    expect(archived).toMatchObject({
      title: '修正した題名',
      note: '修正したメモ',
      archived_at: expect.any(String),
    });
    expect((await listSavedLinks(env.DB, { view: 'reading' })).links).toEqual(
      [],
    );
    expect((await listSavedLinks(env.DB, { view: 'archive' })).links).toEqual([
      archived,
    ]);

    expect(await deleteSavedLink(env.DB, created.link.id)).toBe(true);
    expect(await deleteSavedLink(env.DB, created.link.id)).toBe(false);
  });

  it('読むリストとアーカイブを安定した順序でページングする', async () => {
    const first = await createSavedLink(env.DB, {
      url: 'https://example.com/first',
    });
    const second = await createSavedLink(env.DB, {
      url: 'https://example.com/second',
    });
    const third = await createSavedLink(env.DB, {
      url: 'https://example.com/third',
    });

    const firstPage = await listSavedLinks(env.DB, {
      view: 'reading',
      limit: 2,
      offset: 0,
    });
    const secondPage = await listSavedLinks(env.DB, {
      view: 'reading',
      limit: 2,
      offset: firstPage.next_offset ?? 0,
    });
    expect(firstPage.links.map((link) => link.id)).toEqual([
      third.link.id,
      second.link.id,
    ]);
    expect(firstPage).toMatchObject({ truncated: true, next_offset: 2 });
    expect(secondPage.links.map((link) => link.id)).toEqual([first.link.id]);
    expect(secondPage).toMatchObject({ truncated: false, next_offset: null });

    await updateSavedLink(env.DB, first.link.id, { archived: true });
    await updateSavedLink(env.DB, second.link.id, { archived: true });
    const archive = await listSavedLinks(env.DB, { view: 'archive' });
    expect(archive.links.map((link) => link.id)).toEqual([
      second.link.id,
      first.link.id,
    ]);
  });

  it('D1 境界でも文字数制約を拒否する', async () => {
    await expect(
      env.DB.prepare('INSERT INTO saved_links (url, title) VALUES (?, ?)')
        .bind('https://example.com/too-long-title', '題'.repeat(301))
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      env.DB.prepare('INSERT INTO saved_links (url, note) VALUES (?, ?)')
        .bind('https://example.com/too-long-note', 'メ'.repeat(2001))
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});

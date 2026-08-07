import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  SavedLink,
  SavedLinkCreateResponse,
  SavedLinkView,
} from '../../../src/shared/types';
import {
  createSavedLink,
  deleteSavedLink,
  fetchSavedLinks,
  updateSavedLink,
} from '../api';
import { ErrorState, Loading } from './feedback';
import type { SharedLinkDraft } from '../share-target';

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

interface SavedLinkFormProps {
  onSaved: (result: SavedLinkCreateResponse) => Promise<void>;
  onError?: (message: string) => void;
  initialDraft?: SharedLinkDraft;
}

export function SavedLinkForm({
  onSaved,
  onError,
  initialDraft,
}: SavedLinkFormProps) {
  const [url, setUrl] = useState(initialDraft?.url ?? '');
  const [title, setTitle] = useState(initialDraft?.title ?? '');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingRef.current) return;
    if (!url.trim()) {
      setError('URL を入力してください');
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await createSavedLink({
        url: url.trim(),
        title,
        note,
      });
      await onSaved(result);
      setUrl('');
      setTitle('');
      setNote('');
    } catch (caught) {
      const message = errorMessage(caught, '保存リンクの保存に失敗しました');
      setError(message);
      onError?.(message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <section className="saved-link-form-card" aria-labelledby="link-form-title">
      <div className="saved-link-heading">
        <p className="eyebrow">SAVE FOR LATER</p>
        <h2 id="link-form-title">リンクを保存</h2>
      </div>
      <form className="saved-link-form" onSubmit={submit}>
        <label>
          <span>URL</span>
          <input
            type="url"
            value={url}
            maxLength={2048}
            required
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="https://example.com/article"
            onChange={(event) => setUrl(event.target.value)}
          />
        </label>
        <label>
          <span>題名（任意）</span>
          <input
            value={title}
            maxLength={300}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label>
          <span>メモ（任意）</span>
          <textarea
            value={note}
            maxLength={2000}
            rows={2}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <button className="button primary" type="submit" disabled={saving}>
          {saving ? '保存中…' : '読むリストに保存'}
        </button>
      </form>
    </section>
  );
}

function displayTitle(link: SavedLink): string {
  if (link.title.trim()) return link.title;
  try {
    return new URL(link.url).hostname;
  } catch {
    return link.url;
  }
}

interface SavedLinkEditorProps {
  link: SavedLink;
  onCancel: () => void;
  onSaved: (link: SavedLink) => Promise<void>;
}

function SavedLinkEditor({ link, onCancel, onSaved }: SavedLinkEditorProps) {
  const [title, setTitle] = useState(link.title);
  const [note, setNote] = useState(link.note);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savingRef = useRef(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSaved(await updateSavedLink(link.id, { title, note }));
    } catch (caught) {
      setError(errorMessage(caught, '保存リンクの修正に失敗しました'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <form className="saved-link-editor" onSubmit={submit}>
      <label>
        <span>題名</span>
        <input
          value={title}
          maxLength={300}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        <span>メモ</span>
        <textarea
          value={note}
          maxLength={2000}
          rows={2}
          onChange={(event) => setNote(event.target.value)}
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="saved-link-editor-actions">
        <button
          className="button secondary"
          type="button"
          disabled={saving}
          onClick={onCancel}
        >
          キャンセル
        </button>
        <button className="button primary" type="submit" disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  );
}

interface SavedLinkListProps {
  links: SavedLink[];
  view: SavedLinkView;
  truncated: boolean;
  loadingMore: boolean;
  loadMoreError: string | null;
  onLoadMore: () => void;
  onUpdated: (link: SavedLink) => Promise<void>;
  onDeleted: (id: number) => Promise<void>;
}

export function SavedLinkList({
  links,
  view,
  truncated,
  loadingMore,
  loadMoreError,
  onLoadMore,
  onUpdated,
  onDeleted,
}: SavedLinkListProps) {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [pendingId, setPendingId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const pendingIdRef = useRef<number | null>(null);

  const archive = async (link: SavedLink) => {
    if (pendingIdRef.current !== null) return;
    pendingIdRef.current = link.id;
    setPendingId(link.id);
    setActionError(null);
    try {
      await onUpdated(
        await updateSavedLink(link.id, { archived: view === 'reading' }),
      );
      if (editingId === link.id) setEditingId(null);
    } catch (caught) {
      setActionError(
        errorMessage(
          caught,
          view === 'reading'
            ? 'アーカイブに失敗しました'
            : '読むリストへの復帰に失敗しました',
        ),
      );
    } finally {
      pendingIdRef.current = null;
      setPendingId(null);
    }
  };

  const remove = async (link: SavedLink) => {
    if (pendingIdRef.current !== null) return;
    if (!window.confirm('この保存リンクを完全に削除しますか？')) return;
    pendingIdRef.current = link.id;
    setPendingId(link.id);
    setActionError(null);
    try {
      await deleteSavedLink(link.id);
      await onDeleted(link.id);
      if (editingId === link.id) setEditingId(null);
    } catch (caught) {
      setActionError(errorMessage(caught, '保存リンクの削除に失敗しました'));
    } finally {
      pendingIdRef.current = null;
      setPendingId(null);
    }
  };

  if (links.length === 0) {
    return (
      <div className="empty-state">
        <p>
          {view === 'reading' ? '読むリンクはありません' : 'アーカイブは空です'}
        </p>
        <small>
          {view === 'reading'
            ? '上の入力欄から URL を保存しましょう。'
            : '読み終えたリンクを残しておけます。'}
        </small>
      </div>
    );
  }

  return (
    <>
      {actionError && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}
      <div className="saved-link-list">
        {links.map((link) => {
          const pending = pendingId === link.id;
          return (
            <article className="saved-link-card" key={link.id}>
              <div className="saved-link-main">
                <a
                  className="saved-link-title"
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {displayTitle(link)}
                </a>
                <p className="saved-link-url">{link.url}</p>
                {link.note && <p className="saved-link-note">{link.note}</p>}
                <p className="saved-link-date">保存 {link.created_at}</p>
              </div>
              <div className="saved-link-actions">
                <button
                  className="button secondary"
                  type="button"
                  disabled={pending}
                  onClick={() => setEditingId(link.id)}
                >
                  編集
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={pending}
                  onClick={() => void archive(link)}
                >
                  {view === 'reading' ? 'アーカイブ' : '読むリストへ戻す'}
                </button>
                <button
                  className="saved-link-delete"
                  type="button"
                  disabled={pending}
                  onClick={() => void remove(link)}
                >
                  削除
                </button>
              </div>
              {editingId === link.id && (
                <SavedLinkEditor
                  link={link}
                  onCancel={() => setEditingId(null)}
                  onSaved={async (updated) => {
                    await onUpdated(updated);
                    setEditingId(null);
                  }}
                />
              )}
            </article>
          );
        })}
      </div>
      {(truncated || loadMoreError) && (
        <div className="task-list-more">
          {loadMoreError && <p role="alert">{loadMoreError}</p>}
          <button type="button" disabled={loadingMore} onClick={onLoadMore}>
            {loadingMore ? '読み込み中…' : 'さらに読み込む'}
          </button>
        </div>
      )}
    </>
  );
}

export function ReadingPage({
  onError,
  initialDraft,
}: {
  onError?: (message: string) => void;
  initialDraft?: SharedLinkDraft;
}) {
  const [view, setView] = useState<SavedLinkView>('reading');
  const [links, setLinks] = useState<SavedLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const generation = useRef(0);

  const load = useCallback(
    async (targetView: SavedLinkView, offset = 0) => {
      const requestGeneration = ++generation.current;
      const appending = offset > 0;
      if (appending) {
        setLoadingMore(true);
        setLoadMoreError(null);
      } else {
        setLoading(true);
        setLoadError(null);
        setLoadMoreError(null);
      }
      try {
        const page = await fetchSavedLinks(targetView, offset);
        if (requestGeneration !== generation.current) return;
        setLinks((current) =>
          appending ? [...current, ...page.links] : page.links,
        );
        setTruncated(page.truncated);
        setNextOffset(page.next_offset);
      } catch (caught) {
        if (requestGeneration !== generation.current) return;
        const message = errorMessage(caught, '保存リンクの取得に失敗しました');
        if (appending) setLoadMoreError(message);
        else setLoadError(message);
        onError?.(message);
      } finally {
        if (requestGeneration === generation.current) {
          if (appending) setLoadingMore(false);
          else setLoading(false);
        }
      }
    },
    [onError],
  );

  useEffect(() => {
    void load(view);
  }, [load, view]);

  const reload = async () => load(view);

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">READING LIST</p>
          <h1>読むリスト</h1>
        </div>
      </header>
      <SavedLinkForm
        onError={onError}
        initialDraft={initialDraft}
        onSaved={async () => {
          if (view !== 'reading') setView('reading');
          else await load('reading');
        }}
      />
      <section className="saved-links" aria-labelledby="saved-links-title">
        <div className="saved-link-heading">
          <div>
            <p className="eyebrow">SAVED LINKS</p>
            <h2 id="saved-links-title">保存リンク</h2>
          </div>
          <span>{links.length}件</span>
        </div>
        <div className="kind-switch" aria-label="保存リンクの表示切り替え">
          {(['reading', 'archive'] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={view === item ? 'is-active' : ''}
              aria-pressed={view === item}
              onClick={() => setView(item)}
            >
              {item === 'reading' ? '読むリスト' : 'アーカイブ'}
            </button>
          ))}
        </div>
        {loading ? (
          <Loading />
        ) : loadError ? (
          <ErrorState message={loadError} onRetry={() => void load(view)} />
        ) : (
          <SavedLinkList
            links={links}
            view={view}
            truncated={truncated}
            loadingMore={loadingMore}
            loadMoreError={loadMoreError}
            onLoadMore={() => {
              if (nextOffset !== null) void load(view, nextOffset);
            }}
            onUpdated={reload}
            onDeleted={reload}
          />
        )}
      </section>
    </>
  );
}

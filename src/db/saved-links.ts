import type { D1Database } from '@cloudflare/workers-types';
import type {
  SavedLink,
  SavedLinkCreateInput,
  SavedLinkCreateOutcome,
  SavedLinkListPage,
  SavedLinkUpdateInput,
  SavedLinkView,
} from '../shared/types';

export type {
  SavedLink,
  SavedLinkCreateInput,
  SavedLinkCreateOutcome,
  SavedLinkListPage,
  SavedLinkUpdateInput,
  SavedLinkView,
} from '../shared/types';

export const DEFAULT_SAVED_LINK_LIST_LIMIT = 50;
export const MAX_SAVED_LINK_LIST_LIMIT = 100;
export const MAX_SAVED_LINK_URL_LENGTH = 2048;
export const MAX_SAVED_LINK_TITLE_LENGTH = 300;
export const MAX_SAVED_LINK_NOTE_LENGTH = 2000;

export interface SavedLinkListOptions {
  view: SavedLinkView;
  limit?: number;
  offset?: number;
}

export interface SavedLinkCreateResult {
  link: SavedLink;
  outcome: SavedLinkCreateOutcome;
}

interface SavedLinkRow {
  id: number;
  url: string;
  title: string;
  note: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

const SAVED_LINK_COLUMNS =
  'id, url, title, note, archived_at, created_at, updated_at';

export class SavedLinkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SavedLinkValidationError';
  }
}

function invalid(message: string): never {
  throw new SavedLinkValidationError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function normalizeUrl(value: unknown): string {
  if (typeof value !== 'string') invalid('url は文字列で指定してください');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    invalid('url は有効な URL で指定してください');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    invalid('url は http または https で指定してください');
  }
  if (url.href.length > MAX_SAVED_LINK_URL_LENGTH) {
    invalid(`url は ${MAX_SAVED_LINK_URL_LENGTH} 文字以内で指定してください`);
  }
  return url.href;
}

function normalizeText(value: unknown, field: 'title' | 'note'): string {
  if (typeof value !== 'string') invalid(`${field} は文字列で指定してください`);
  const maxLength =
    field === 'title'
      ? MAX_SAVED_LINK_TITLE_LENGTH
      : MAX_SAVED_LINK_NOTE_LENGTH;
  if (value.length > maxLength) {
    invalid(`${field} は ${maxLength} 文字以内で指定してください`);
  }
  return value;
}

function normalizeCreateInput(input: unknown): SavedLinkCreateInput {
  if (!isRecord(input))
    invalid('保存リンクは JSON オブジェクトで指定してください');
  if (!hasOnlyFields(input, ['url', 'title', 'note']))
    invalid('保存リンクに未対応の項目が含まれています');
  return {
    url: normalizeUrl(input.url),
    title: normalizeText(input.title ?? '', 'title'),
    note: normalizeText(input.note ?? '', 'note'),
  };
}

function normalizeUpdateInput(input: unknown): SavedLinkUpdateInput {
  if (!isRecord(input))
    invalid('保存リンクは JSON オブジェクトで指定してください');
  if (!hasOnlyFields(input, ['title', 'note', 'archived']))
    invalid('保存リンクに未対応の項目が含まれています');
  const normalized: SavedLinkUpdateInput = {};
  if ('title' in input) normalized.title = normalizeText(input.title, 'title');
  if ('note' in input) normalized.note = normalizeText(input.note, 'note');
  if ('archived' in input) {
    if (typeof input.archived !== 'boolean')
      invalid('archived は真偽値で指定してください');
    normalized.archived = input.archived;
  }
  if (Object.keys(normalized).length === 0)
    invalid('変更する項目を1つ以上指定してください');
  return normalized;
}

function toSavedLink(row: SavedLinkRow): SavedLink {
  return {
    id: Number(row.id),
    url: row.url,
    title: row.title,
    note: row.note,
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getSavedLink(
  db: D1Database,
  id: number,
): Promise<SavedLink | null> {
  const row = await db
    .prepare(`SELECT ${SAVED_LINK_COLUMNS} FROM saved_links WHERE id = ?`)
    .bind(id)
    .first<SavedLinkRow>();
  return row ? toSavedLink(row) : null;
}

async function getSavedLinkByUrl(
  db: D1Database,
  url: string,
): Promise<SavedLink | null> {
  const row = await db
    .prepare(`SELECT ${SAVED_LINK_COLUMNS} FROM saved_links WHERE url = ?`)
    .bind(url)
    .first<SavedLinkRow>();
  return row ? toSavedLink(row) : null;
}

async function reuseSavedLink(
  db: D1Database,
  current: SavedLink,
  title: string,
): Promise<SavedLinkCreateResult> {
  const outcome = current.archived_at === null ? 'existing' : 'restored';
  const fillsTitle = current.title === '' && title !== '';
  if (outcome === 'restored' || fillsTitle) {
    await db
      .prepare(
        `UPDATE saved_links
         SET title = CASE WHEN title = '' AND ? != '' THEN ? ELSE title END,
             archived_at = NULL,
             updated_at = datetime('now')
         WHERE id = ?`,
      )
      .bind(title, title, current.id)
      .run();
  }
  const link = (await getSavedLink(db, current.id)) ?? current;
  return { link, outcome };
}

export async function listSavedLinks(
  db: D1Database,
  options: SavedLinkListOptions,
): Promise<SavedLinkListPage> {
  if (options.view !== 'reading' && options.view !== 'archive') {
    invalid('view は reading または archive で指定してください');
  }
  const limit = options.limit ?? DEFAULT_SAVED_LINK_LIST_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_SAVED_LINK_LIST_LIMIT
  ) {
    invalid(
      `limit は 1 以上 ${MAX_SAVED_LINK_LIST_LIMIT} 以下の整数で指定してください`,
    );
  }
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) {
    invalid('offset は 0 以上の整数で指定してください');
  }
  const archived = options.view === 'archive';
  const order = archived
    ? 'archived_at DESC, id DESC'
    : 'created_at DESC, id DESC';
  const result = await db
    .prepare(
      `SELECT ${SAVED_LINK_COLUMNS} FROM saved_links
       WHERE archived_at IS ${archived ? 'NOT ' : ''}NULL
       ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
    .bind(limit + 1, offset)
    .all<SavedLinkRow>();
  const truncated = result.results.length > limit;
  const rows = truncated ? result.results.slice(0, limit) : result.results;
  return {
    links: rows.map(toSavedLink),
    truncated,
    next_offset: truncated ? offset + rows.length : null,
  };
}

export async function createSavedLink(
  db: D1Database,
  input: unknown,
): Promise<SavedLinkCreateResult> {
  const normalized = normalizeCreateInput(input);
  const { url, title = '', note = '' } = normalized;
  const current = await getSavedLinkByUrl(db, url);
  if (current) return reuseSavedLink(db, current, title);

  let result;
  try {
    result = await db
      .prepare('INSERT INTO saved_links (url, title, note) VALUES (?, ?, ?)')
      .bind(url, title, note)
      .run();
  } catch (thrown) {
    if (
      thrown instanceof Error &&
      thrown.message.includes('UNIQUE constraint failed: saved_links.url')
    ) {
      const winner = await getSavedLinkByUrl(db, url);
      if (winner) return reuseSavedLink(db, winner, title);
    }
    throw thrown;
  }
  const link = await getSavedLink(db, Number(result.meta.last_row_id));
  if (!link) throw new Error('作成した保存リンクを取得できませんでした');
  return { link, outcome: 'created' };
}

export async function updateSavedLink(
  db: D1Database,
  id: number,
  input: unknown,
): Promise<SavedLink | null> {
  const normalized = normalizeUpdateInput(input);
  const current = await getSavedLink(db, id);
  if (!current) return null;
  const updates: string[] = [];
  const bindings: Array<string | number | null> = [];
  if (normalized.title !== undefined) {
    updates.push('title = ?');
    bindings.push(normalized.title);
  }
  if (normalized.note !== undefined) {
    updates.push('note = ?');
    bindings.push(normalized.note);
  }
  if (normalized.archived !== undefined) {
    updates.push(
      normalized.archived
        ? "archived_at = datetime('now')"
        : 'archived_at = NULL',
    );
  }
  updates.push("updated_at = datetime('now')");
  bindings.push(id);
  await db
    .prepare(`UPDATE saved_links SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...bindings)
    .run();
  return getSavedLink(db, id);
}

export async function deleteSavedLink(
  db: D1Database,
  id: number,
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM saved_links WHERE id = ?')
    .bind(id)
    .run();
  return result.success && result.meta.changes > 0;
}

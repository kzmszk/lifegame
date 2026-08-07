import { useCallback, useEffect, useState } from 'react';
import type { Connection } from '../../../src/shared/types';
import { fetchConnections, removeConnection } from '../api';
import { ErrorState, Loading } from './feedback';

export function ConnectionSettings({
  onBack,
  onError,
}: {
  onBack: () => void;
  onError: (message: string) => void;
}) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const loadConnections = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetchConnections();
      setConnections(response.connections);
      setTruncated(response.truncated);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : '接続の取得に失敗しました';
      setLoadError(message);
      throw error;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConnections().catch(() => undefined);
  }, [loadConnections]);

  const disconnect = async (connection: Connection) => {
    if (!window.confirm(`「${connection.client_name}」を切断しますか？`))
      return;
    if (removingId) return;
    setRemovingId(connection.id);
    try {
      await removeConnection(connection.id);
    } catch (error) {
      onError(
        error instanceof Error ? error.message : '接続の切断に失敗しました',
      );
      return;
    } finally {
      setRemovingId(null);
    }
    // The revocation already succeeded, so a failed refresh must not read as one.
    onError('接続を切断しました');
    await loadConnections().catch(() => onError('一覧の再取得に失敗しました'));
  };

  return (
    <>
      <header className="detail-header">
        <button
          className="back-button"
          type="button"
          onClick={onBack}
          aria-label="一覧に戻る"
        >
          ‹
        </button>
        <div>
          <p className="eyebrow">SETTINGS</p>
          <h1>設定</h1>
        </div>
      </header>
      {loading ? (
        <Loading />
      ) : loadError ? (
        <ErrorState
          message={loadError}
          onRetry={() => void loadConnections().catch(() => undefined)}
        />
      ) : (
        <>
          {truncated && (
            <p className="notice" role="status">
              接続が多いため、一部だけ表示しています。ここに出ていない接続は切断できません。
            </p>
          )}
          <ConnectionList
            connections={connections}
            removingId={removingId}
            onDisconnect={(connection) => void disconnect(connection)}
          />
        </>
      )}
    </>
  );
}

function ConnectionList({
  connections,
  removingId,
  onDisconnect,
}: {
  connections: Connection[];
  removingId: string | null;
  onDisconnect: (connection: Connection) => void;
}) {
  if (connections.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-icon">◌</div>
        <p>接続中のクライアントはありません</p>
        <small>OAuth クライアントを接続すると、ここに表示されます。</small>
      </div>
    );
  }
  return (
    <section className="connection-list" aria-label="接続中のクライアント一覧">
      {connections.map((connection) => (
        <article className="connection-card" key={connection.id}>
          <div className="connection-main">
            <h2>{connection.client_name}</h2>
            <div className="connection-scopes" aria-label="許可したスコープ">
              {connection.scope.map((scope) => (
                <span className="connection-scope" key={scope}>
                  {scope}
                </span>
              ))}
            </div>
            <p className="connection-created">
              接続日時: {formatConnectionDate(connection.created_at)}
            </p>
          </div>
          <button
            className="button secondary disconnect-button"
            type="button"
            disabled={removingId !== null}
            onClick={() => onDisconnect(connection)}
          >
            {removingId === connection.id ? '切断中…' : '切断'}
          </button>
        </article>
      ))}
    </section>
  );
}

function formatConnectionDate(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString('ja-JP', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

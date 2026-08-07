import type { Connection } from '../../../src/shared/types';

export function ConnectionList({
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

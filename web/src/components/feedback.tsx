export function Loading() {
  return (
    <div className="loading">
      <span className="spinner" />
      読み込み中…
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="empty-state error-state">
      <p>{message}</p>
      <button className="button secondary" onClick={onRetry}>
        再読み込み
      </button>
    </div>
  );
}

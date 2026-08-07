import type { CalendarEvent } from '../../../src/shared/types';

/**
 * Google returns anything overlapping the day, so an event may already be under
 * way or run past midnight. Showing a bare start time would announce something
 * that began last night as starting tonight.
 */
function eventTimeLabel(event: CalendarEvent): string {
  if (event.all_day || (event.started_earlier && event.ends_later))
    return '終日';
  if (event.started_earlier) return `〜${event.end_time}`;
  if (event.ends_later) return `${event.start_time}〜`;
  return event.start_time ?? '';
}

export function CalendarEventList({
  events,
  failed,
  onRetry,
}: {
  events: CalendarEvent[];
  failed: boolean;
  onRetry: () => void;
}) {
  if (failed) {
    return (
      <div className="notice calendar-notice">
        <span>予定を取得できませんでした</span>
        <button type="button" onClick={onRetry}>
          再試行
        </button>
      </div>
    );
  }
  // Nothing to show while loading or on a free day; an empty box would just be noise.
  if (events.length === 0) return null;

  return (
    <section className="event-list" aria-label="今日の予定">
      <h2 className="event-list-title">予定</h2>
      {events.map((event) => (
        <article className="event-card" key={event.id}>
          <span className="event-time">{eventTimeLabel(event)}</span>
          <div className="event-main">
            <p className="event-title">{event.title}</p>
            {event.location && (
              <p className="event-location">{event.location}</p>
            )}
          </div>
        </article>
      ))}
    </section>
  );
}

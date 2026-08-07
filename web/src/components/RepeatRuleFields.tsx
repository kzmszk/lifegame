import { clampInteger } from '../repeat-form';
import type { RepeatFormValue, RepeatFrequency } from '../repeat-form';

const WEEKDAY_OPTIONS = [
  { value: 0, label: '日' },
  { value: 1, label: '月' },
  { value: 2, label: '火' },
  { value: 3, label: '水' },
  { value: 4, label: '木' },
  { value: 5, label: '金' },
  { value: 6, label: '土' },
] as const;

export function RepeatRuleFields({
  value,
  onChange,
  disabled = false,
}: {
  value: RepeatFormValue;
  onChange: (value: RepeatFormValue) => void;
  disabled?: boolean;
}) {
  const setFrequency = (frequency: RepeatFrequency) =>
    onChange({
      ...value,
      frequency,
      weeklyDays: value.weeklyDays.length > 0 ? value.weeklyDays : [1],
    });
  const setWeekday = (weekday: number, checked: boolean) => {
    const weeklyDays = checked
      ? [...new Set([...value.weeklyDays, weekday])].sort(
          (left, right) => left - right,
        )
      : value.weeklyDays.length > 1
        ? value.weeklyDays.filter((day) => day !== weekday)
        : value.weeklyDays;
    onChange({ ...value, weeklyDays });
  };

  return (
    <fieldset className="repeat-settings" disabled={disabled}>
      <legend>繰り返し</legend>
      <label>
        <span>頻度</span>
        <select
          value={value.frequency}
          onChange={(event) =>
            setFrequency(event.target.value as RepeatFrequency)
          }
          aria-label="繰り返しの頻度"
        >
          <option value="none">なし</option>
          <option value="daily">毎日</option>
          <option value="weekly">毎週</option>
          <option value="monthly">毎月</option>
          <option value="every">N日ごと</option>
        </select>
      </label>
      {value.frequency === 'weekly' && (
        <div className="repeat-weekdays" role="group" aria-label="繰り返す曜日">
          <span>曜日</span>
          <div className="weekday-options">
            {WEEKDAY_OPTIONS.map((weekday) => {
              const isOnlySelectedDay =
                value.weeklyDays.length === 1 &&
                value.weeklyDays[0] === weekday.value;
              return (
                <label className="weekday-option" key={weekday.value}>
                  <input
                    type="checkbox"
                    checked={value.weeklyDays.includes(weekday.value)}
                    disabled={isOnlySelectedDay}
                    onChange={(event) =>
                      setWeekday(weekday.value, event.target.checked)
                    }
                  />
                  <span>{weekday.label}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
      {value.frequency === 'monthly' && (
        <label className="repeat-number">
          <span>毎月の日</span>
          <input
            type="number"
            inputMode="numeric"
            min="1"
            max="31"
            value={value.monthlyDay}
            onChange={(event) =>
              onChange({
                ...value,
                monthlyDay: clampInteger(Number(event.target.value), 1, 31),
              })
            }
          />
          <span>日</span>
        </label>
      )}
      {value.frequency === 'every' && (
        <label className="repeat-number">
          <span>間隔</span>
          <input
            type="number"
            inputMode="numeric"
            min="1"
            max="366"
            value={value.everyDays}
            onChange={(event) =>
              onChange({
                ...value,
                everyDays: clampInteger(Number(event.target.value), 1, 366),
              })
            }
          />
          <span>日ごと</span>
        </label>
      )}
      {value.frequency !== 'none' && (
        <p className="repeat-help">
          完了すると次回のタスクを1件作成します。なしを選ぶと以後は作成しません。
        </p>
      )}
    </fieldset>
  );
}

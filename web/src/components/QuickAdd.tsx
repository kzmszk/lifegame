import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { SpeechRecognizer } from '../speech-recognition';

export function QuickAdd({
  onAdd,
  onVoiceText,
  onError,
}: {
  onAdd: (text: string) => Promise<void>;
  onVoiceText: (text: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognizer | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || saving) return;
    setSaving(true);
    try {
      await onAdd(text.trim());
      setText('');
    } catch (error) {
      onError(
        error instanceof Error ? error.message : 'タスクの追加に失敗しました',
      );
    } finally {
      setSaving(false);
    }
  };

  const startVoice = () => {
    const SpeechRecognitionCtor =
      window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!SpeechRecognitionCtor) {
      onError('このブラウザは音声入力に対応していません');
      return;
    }
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = 'ja-JP';
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript?.trim();
      setListening(false);
      if (transcript) {
        setText('');
        void onVoiceText(transcript).catch((error) =>
          onError(
            error instanceof Error ? error.message : '音声の解析に失敗しました',
          ),
        );
      }
    };
    recognition.onerror = () => {
      setListening(false);
      onError('音声を認識できませんでした');
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  };

  return (
    <form className="quick-add" onSubmit={submit}>
      <button
        className="plus"
        type="submit"
        disabled={!text.trim() || saving}
        aria-label="このタスクを追加"
      >
        ＋
      </button>
      <input
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="タスクを追加…"
        aria-label="タスクを追加"
      />
      <button
        className={`voice-button ${listening ? 'is-listening' : ''}`}
        type="button"
        onClick={startVoice}
        aria-label="音声入力"
      >
        {listening ? '◉' : '🎤'}
      </button>
      {saving && <span className="mini-spinner" aria-label="保存中" />}
    </form>
  );
}

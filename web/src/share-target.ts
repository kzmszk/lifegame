export interface SharedLinkDraft {
  url: string;
  title: string;
}

interface ExtractedUrl {
  raw: string;
  url: string;
}

const URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;
const TRAILING_PUNCTUATION = /[.,!?;:、。）」』】]+$/u;

function extractHttpUrl(value: string | null): ExtractedUrl | null {
  if (!value) return null;
  for (const match of value.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(TRAILING_PUNCTUATION, '');
    try {
      const parsed = new URL(raw);
      if (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.href.length <= 2048
      ) {
        return { raw: match[0], url: parsed.href };
      }
    } catch {
      // Continue looking: Android share text can contain prose before a usable URL.
    }
  }
  return null;
}

function titleCandidate(value: string | null): string {
  if (!value) return '';
  const embeddedUrl = extractHttpUrl(value);
  const withoutUrl = embeddedUrl ? value.replace(embeddedUrl.raw, '') : value;
  return withoutUrl.trim().slice(0, 300);
}

export function parseShareTarget(params: URLSearchParams): SharedLinkDraft {
  const extracted = [params.get('url'), params.get('text'), params.get('title')]
    .map(extractHttpUrl)
    .find((candidate) => candidate !== null);
  return {
    url: extracted?.url ?? '',
    title: titleCandidate(params.get('title')),
  };
}

export function clearShareTargetQuery(
  history: Pick<History, 'replaceState'>,
): void {
  history.replaceState({}, '', '/reading');
}

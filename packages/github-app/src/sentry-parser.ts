/**
 * Parse a Sentry webhook payload into a flat failure-text blob that
 * `runRca({ failureScope: { kind: 'stack-trace', text } })` can chew on.
 *
 * Sentry's "issue alert" / "issue created" webhook delivers an event under
 * either `data.event` or `event` (the shape varies by integration version);
 * inside that, `exception.values[].stacktrace.frames` holds Python/JS frames.
 * We don't validate the schema strictly — anything we can't extract is
 * tolerated and we fall back to the raw `message`/`title` so the RCA still
 * gets *something* to seed on.
 *
 * This is intentionally a single pure function with no IO so the route
 * handler can call it on a parsed JSON body without surprises.
 */

export interface ParsedSentryIncident {
  /** Sentry's issue id — used as our idempotency key. Required. */
  issueId: string;
  /** Best-effort title for the GitHub issue. */
  title: string;
  /** Multi-line text that runRca will treat as a stack trace. */
  failureText: string;
}

interface SentryFrame {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  module?: string;
}

interface SentryException {
  type?: string;
  value?: string;
  stacktrace?: { frames?: SentryFrame[] };
}

interface SentryEvent {
  event_id?: string;
  message?: string;
  title?: string;
  exception?: { values?: SentryException[] };
  platform?: string;
}

interface SentryWebhookBody {
  // Older "issue alert" shape
  event?: SentryEvent;
  // Newer "internal integration" shape
  data?: { event?: SentryEvent; issue?: { id?: string; shortId?: string; title?: string } };
  // Top-level Sentry issue id (varies)
  id?: string;
  issue?: { id?: string; shortId?: string };
}

/** Parse Sentry-shaped JSON into a normalized incident. Throws if no usable id. */
export function parseSentryPayload(body: unknown): ParsedSentryIncident {
  if (!body || typeof body !== "object") {
    throw new Error("Sentry payload is not an object");
  }
  const b = body as SentryWebhookBody;
  const event = b.data?.event ?? b.event;
  const issue = b.data?.issue ?? b.issue;

  const issueId =
    issue?.id ??
    issue?.shortId ??
    b.id ??
    event?.event_id ??
    null;
  if (!issueId) {
    throw new Error("Sentry payload missing issue id (data.issue.id / event.event_id)");
  }

  const title =
    b.data?.issue?.title ??
    event?.title ??
    event?.message ??
    `Sentry incident ${issueId}`;

  const failureText = renderFailureText(event ?? null, title);

  return { issueId: String(issueId), title, failureText };
}

function renderFailureText(event: SentryEvent | null, title: string): string {
  if (!event) return title;
  const lines: string[] = [];
  const values = event.exception?.values ?? [];
  for (const v of values) {
    const head = [v.type, v.value].filter(Boolean).join(": ");
    if (head) lines.push(head);
    const frames = v.stacktrace?.frames ?? [];
    // Sentry orders frames bottom-up (call site last). Reverse for the
    // standard "most recent call last" Python-style trace cgrca expects.
    const ordered = [...frames].reverse();
    for (const f of ordered) {
      const file = f.filename ?? f.module ?? "<unknown>";
      const line = typeof f.lineno === "number" ? `:${f.lineno}` : "";
      const fn = f.function ?? "<anonymous>";
      lines.push(`  at ${fn} (${file}${line})`);
    }
  }
  if (lines.length === 0) {
    // No structured frames — fall back to message/title.
    return event.message ?? title;
  }
  return lines.join("\n");
}

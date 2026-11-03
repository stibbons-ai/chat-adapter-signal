/**
 * Signal clients hide a typing indicator 15 s after the last STARTED (signal-cli `sendTyping`;
 * Signal-Android `RECIPIENT_TYPING_TIMEOUT`); Signal-Android refreshes its own every 10 s.
 */
export const TYPING_REFRESH_MS = 10_000;

/** How long `startTyping` keeps refreshing without a post or `endTyping`, so a handler that fails before replying does not leave the bot typing. */
export const TYPING_MAX_MS = 2 * 60_000;

interface Typing {
  until: number;
  timer?: NodeJS.Timeout;
  /** The latest indicator on its way to signal-cli. */
  refreshing?: Promise<void>;
}

/** Keeps a typing indicator alive per Conversation (thread ID) by re-sending it until stopped or `until` passes. */
export class TypingIndicators {
  private readonly active = new Map<string, Typing>();

  constructor(
    private readonly send: (threadId: string) => Promise<void>,
    private readonly onRefreshError: (error: unknown) => void,
  ) {}

  /**
   * Sends the indicator now (rejecting if that fails) and refreshes it for `durationMs`. While it
   * is already up, only extends the refresh: Signal clients still show the last one.
   */
  async start(threadId: string, durationMs: number): Promise<void> {
    const until = Date.now() + durationMs;
    const current = this.active.get(threadId);
    if (current) {
      current.until = Math.max(current.until, until);
      return;
    }
    const typing: Typing = { until };
    this.active.set(threadId, typing);
    const sent = this.send(threadId);
    typing.refreshing = sent.catch(() => {});
    try {
      await sent;
    } catch (error) {
      if (this.active.get(threadId) === typing) {
        this.active.delete(threadId);
      }
      throw error;
    }
    // Stopped while the first one was on its way: no refresh.
    if (this.active.get(threadId) === typing) {
      this.schedule(threadId, typing);
    }
  }

  /**
   * Stops refreshing; true if the indicator was active. Waits for a refresh already on its way,
   * so it cannot reach the recipient after a message that follows: Signal clients clear the
   * indicator on the next message from the typist.
   */
  async stop(threadId: string): Promise<boolean> {
    const typing = this.active.get(threadId);
    if (!typing) {
      return false;
    }
    clearTimeout(typing.timer);
    this.active.delete(threadId);
    await typing.refreshing;
    return true;
  }

  stopAll(): void {
    for (const typing of this.active.values()) {
      clearTimeout(typing.timer);
    }
    this.active.clear();
  }

  private schedule(threadId: string, typing: Typing): void {
    if (Date.now() + TYPING_REFRESH_MS > typing.until) {
      // The last indicator sent fades on its own.
      this.active.delete(threadId);
      return;
    }
    typing.timer = setTimeout(() => {
      typing.refreshing = this.send(threadId).catch(this.onRefreshError);
      this.schedule(threadId, typing);
    }, TYPING_REFRESH_MS);
    typing.timer.unref();
  }
}

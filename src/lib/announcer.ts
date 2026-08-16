// Paced announcements for a single aria-live region.
//
// A screen reader starts reading a live region the moment its text changes. If
// the text changes again a fraction of a second later, the first message is cut
// off mid-word. The capture screen produces messages faster than anyone can
// hear them — coaching every few hundred milliseconds, plus photo confirmations
// on top — so from a blind tester's chair the app "starts reading it, and then
// a new message pops up so quickly it just interrupts it". The message that
// matters most, "photo taken, turn to the next page", is the one that gets
// stomped, because it lands right when the coaching resumes.
//
// This paces the region: each message is given time to be heard before it can
// be replaced. It is deliberately pure and clock-injected so the timing is
// testable without a browser or a real screen reader.

export type AnnouncementPriority =
  /** Coaching. Superseded freely — only the newest one is worth hearing. */
  | 'normal'
  /** Something that happened and must not be missed (a photo was taken). */
  | 'urgent';

/** Words per minute a screen reader is assumed to manage, conservatively. */
const WPM = 190;
/** Even one word needs a beat to register. */
const MIN_READ_MS = 1300;
/** Past this, waiting costs more than the tail of the sentence is worth. */
const MAX_READ_MS = 4500;

/**
 * How long `text` needs before it is safe to replace.
 *
 * Exported because it is the whole basis of the pacing: if this is wrong,
 * messages are either clipped or the screen feels sluggish.
 */
export function readingTimeMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  const ms = (words / WPM) * 60_000;
  return Math.min(MAX_READ_MS, Math.max(MIN_READ_MS, Math.round(ms)));
}

export class PacedAnnouncer {
  private current = '';
  private currentSince = 0;
  private currentPriority: AnnouncementPriority = 'normal';
  /**
   * At most ONE queued normal message. Coaching describes the situation right
   * now, so a backlog would read out advice for a position the phone has
   * already left. Newest wins.
   */
  private queued: string | null = null;
  private queuedUrgent: string[] = [];

  constructor(
    private readonly onChange: (text: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Offer a message. Urgent messages are never dropped and always get their
   * full reading time; normal ones may be superseded before they are ever seen.
   */
  announce(text: string, priority: AnnouncementPriority = 'normal'): void {
    const clean = text.trim();
    if (!clean) return;
    if (priority === 'urgent') {
      // An urgent message displaces pending coaching outright — the coaching
      // was about to be stale anyway, and this is the thing that must be heard.
      this.queued = null;
      if (this.queuedUrgent[this.queuedUrgent.length - 1] !== clean) {
        this.queuedUrgent.push(clean);
      }
      this.pump();
      return;
    }
    if (clean === this.current) return; // already saying exactly this
    this.queued = clean;
    this.pump();
  }

  /** Drive from a timer. Promotes the next message once the current one has been heard. */
  pump(): void {
    const t = this.now();
    const stillReading = !!this.current && t - this.currentSince < readingTimeMs(this.current);

    if (stillReading) {
      // Coaching yields to a photo confirmation. By the time the shutter has
      // fired, whatever was being said about the framing is already history —
      // and the confirmation has to land while the user's hands are still on
      // the phone, not three seconds later. One urgent message never cuts off
      // another, so two photos in a row are both heard in full.
      const preempt = this.currentPriority === 'normal' && this.queuedUrgent.length > 0;
      if (!preempt) return;
    }

    const fromUrgent = this.queuedUrgent.length > 0;
    const next = fromUrgent ? this.queuedUrgent.shift()! : this.queued;
    if (next == null) return;
    this.queued = null;
    if (next === this.current) return;
    this.current = next;
    this.currentPriority = fromUrgent ? 'urgent' : 'normal';
    this.currentSince = t;
    this.onChange(next);
  }

  /** Everything pending, dropped. Used when leaving the screen. */
  reset(): void {
    this.queued = null;
    this.queuedUrgent = [];
    this.current = '';
    this.currentSince = 0;
    this.currentPriority = 'normal';
  }

  /** What the live region is showing right now. */
  get displayed(): string {
    return this.current;
  }

  /** True while a message still owes the listener time. Useful in tests. */
  get busy(): boolean {
    return !!this.current && this.now() - this.currentSince < readingTimeMs(this.current);
  }
}

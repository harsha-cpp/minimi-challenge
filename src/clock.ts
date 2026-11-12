/**
 * The only place the agent learns what time it is.
 *
 * Every timestamp written to memory and every "last Tuesday" resolved against
 * it goes through this, so a test (or a reviewer) can move the agent to another
 * day and ask date questions without waiting a week.
 */
export interface Clock {
  now(): Date;
  readonly simulated: boolean;
}

export class SystemClock implements Clock {
  private offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  get simulated(): boolean {
    return this.offsetMs !== 0;
  }

  /** Jump to `target`; time keeps flowing from there. */
  travelTo(target: Date): void {
    this.offsetMs = target.getTime() - Date.now();
  }

  reset(): void {
    this.offsetMs = 0;
  }
}

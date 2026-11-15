

export interface Clock {
  now(): Date;
  readonly simulated: boolean;
}

export interface TurnTime {
  effectiveAt: string;
  receivedAt: string;
  simulated: boolean;
  tz: string;
}

export function pinTurnTime(clock: Clock, tz: string, asOf?: Date): TurnTime {
  const now = asOf ? new Date(asOf) : clock.now();
  if (Number.isNaN(now.getTime())) throw new Error("Invalid request time.");
  return { effectiveAt: now.toISOString(), receivedAt: new Date().toISOString(), simulated: Boolean(asOf) || clock.simulated, tz };
}

export class SystemClock implements Clock {
  private offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  get simulated(): boolean {
    return this.offsetMs !== 0;
  }

  travelTo(target: Date): void {
    this.offsetMs = target.getTime() - Date.now();
  }

  reset(): void {
    this.offsetMs = 0;
  }
}

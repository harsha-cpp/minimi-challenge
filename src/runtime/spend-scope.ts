import { SpendBudgetError, type SpendReservation, type SpendReservationInput, type SpendStore } from "./spend-store.ts";

function every(operations: Array<() => void>): void {
  let failure: unknown,
    failed = false;
  for (const operation of operations) {
    try {
      operation();
    } catch (error) {
      if (!failed) failure = error;
      failed = true;
    }
  }
  if (failed) throw failure;
}

/** A campaign can only tighten the persistent product allowance. Every physical attempt owns both holds. */
export class ScopedSpendStore implements SpendStore {
  constructor(
    readonly global: SpendStore,
    readonly scope: SpendStore,
  ) {
    const productPath = global.getSummary().path,
      scopePath = scope.getSummary().path;
    if (global === scope || (productPath !== ":memory:" && productPath === scopePath))
      throw new SpendBudgetError("invalid_reservation", "Campaign and product wallets must be separate ledgers.");
  }
  reserve(input: SpendReservationInput): SpendReservation {
    const global = this.global.reserve(input);
    let scoped: SpendReservation;
    try {
      scoped = this.scope.reserve(input);
    } catch (error) {
      global.cancelBeforeStart();
      throw error;
    }
    const started = () => every([() => global.markStarted(), () => scoped.markStarted()]);
    return {
      id: `${global.id}:${scoped.id}`,
      started,
      markStarted: started,
      settle: (actual) => every([() => global.settle(actual), () => scoped.settle(actual)]),
      cancelBeforeStart: () => every([() => global.cancelBeforeStart(), () => scoped.cancelBeforeStart()]),
    };
  }
  /** This is the narrower campaign's status; global status remains available on .global. */
  getSummary() {
    return this.scope.getSummary();
  }
}

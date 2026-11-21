import { isRealDate } from "./zone.ts";

export function parseInstant(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts || !isRealDate({ y: Number(parts[1]), m: Number(parts[2]), d: Number(parts[3]) }) || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

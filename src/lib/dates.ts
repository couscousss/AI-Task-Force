/**
 * The event runs in one timezone with a fixed UTC offset for its two-week window, so a
 * numeric offset is enough and avoids shipping a tz database into a Worker.
 */
export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 = Sunday .. 6 = Saturday */
  weekday: number;
  /** YYYY-MM-DD in local time. */
  dateKey: string;
}

export function toLocalParts(d: Date, offsetHours: number): LocalParts {
  const shifted = new Date(d.getTime() + offsetHours * 3600_000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    year,
    month,
    day,
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
    dateKey: `${year}-${pad(month)}-${pad(day)}`,
  };
}

export function isWeekday(parts: LocalParts): boolean {
  return parts.weekday >= 1 && parts.weekday <= 5;
}

export function formatLocalDate(iso: string, offsetHours: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = toLocalParts(d, offsetHours);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${p.day} ${months[p.month - 1]} ${p.year}`;
}

export function formatLocalDateTime(iso: string, offsetHours: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = toLocalParts(d, offsetHours);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${formatLocalDate(iso, offsetHours)}, ${pad(p.hour)}:${pad(p.minute)}`;
}

export function isPast(iso: string, now: Date = new Date()): boolean {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() < now.getTime();
}

export function projectPathSeparator(path: string): number {
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}

type DateDisplay = {
  locale: string;
  today(time: string): string;
  yesterday(time: string): string;
  unknown: string;
};

const defaultDisplay: DateDisplay = {
  locale: "zh-CN",
  today: time => `今天 ${time}`,
  yesterday: time => `昨天 ${time}`,
  unknown: "时间未知",
};

export function formatLastOpened(value: string, now = new Date(), display = defaultDisplay): string {
  const opened = new Date(value);
  if (Number.isNaN(opened.getTime())) return display.unknown;
  const sameDay = (other: Date) => opened.getFullYear() === other.getFullYear()
    && opened.getMonth() === other.getMonth() && opened.getDate() === other.getDate();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const today = sameDay(now);
  if (today || sameDay(yesterday)) {
    const time = opened.toLocaleTimeString(display.locale, {hour: "2-digit", minute: "2-digit"});
    return today ? display.today(time) : display.yesterday(time);
  }
  const year = opened.getFullYear() === now.getFullYear() ? undefined : "numeric";
  return opened.toLocaleDateString(display.locale, {year, month: "short", day: "numeric"});
}

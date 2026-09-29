export function projectPathSeparator(path: string): number {
  return Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
}

export function formatLastOpened(value: string, now = new Date()): string {
  const opened = new Date(value);
  if (Number.isNaN(opened.getTime())) return "时间未知";
  const sameDay = (other: Date) => opened.getFullYear() === other.getFullYear()
    && opened.getMonth() === other.getMonth() && opened.getDate() === other.getDate();
  const time = `${String(opened.getHours()).padStart(2, "0")}:${String(opened.getMinutes()).padStart(2, "0")}`;
  if (sameDay(now)) return `今天 ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(yesterday)) return `昨天 ${time}`;
  const date = `${opened.getMonth() + 1}月${opened.getDate()}日`;
  return opened.getFullYear() === now.getFullYear() ? date : `${opened.getFullYear()}年${date}`;
}

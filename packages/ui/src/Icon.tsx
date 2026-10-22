import type { ReactNode } from "react";

const shapes = {
  book: (
    <>
      <path d="M12 5.5C8.5 3 5 3 2 4v15c3-1 6.5-1 10 1.5C15.5 18 19 18 22 19V4c-3-1-6.5-1-10 1.5Z" />
      <path d="M12 5.5v15" />
    </>
  ),
  folder: <path d="M3 5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  arrowLeft: <path d="m10 5-7 7 7 7M3 12h18" />,
  file: (
    <>
      <path d="M14 3H5a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9Z" />
      <path d="M14 3v6h6M8 13h8M8 17h6" />
    </>
  ),
  outline: (
    <>
      <rect x="3" y="3" width="5" height="4" rx="1" />
      <path d="M5.5 7v11M5.5 11h6M5.5 18h6" />
      <rect x="12" y="9" width="9" height="4" rx="1" />
      <rect x="12" y="16" width="9" height="4" rx="1" />
    </>
  ),
  textColor: <path d="m5 20 7-16 7 16M8 13h8" />,
  highlight: (
    <>
      <path d="m4 16 12-12 4 4L8 20H4v-4Z" />
      <path d="m13 7 4 4M4 20h16" />
    </>
  ),
  alignLeft: <path d="M4 5h16M4 9h11M4 13h16M4 17h11" />,
  alignCenter: <path d="M4 5h16M7 9h10M4 13h16M7 17h10" />,
  alignRight: <path d="M4 5h16M9 9h11M4 13h16M9 17h11" />,
  alignJustify: <path d="M4 5h16M4 9h16M4 13h16M4 17h16" />,
  chevronRight: <path d="m9 5 7 7-7 7" />,
  chevronDown: <path d="m5 9 7 7 7-7" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  collapseLeft: <path d="M19 4v16M13 6l-6 6 6 6" />,
  collapseRight: <path d="M5 4v16M11 6l6 6-6 6" />,
  split: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <path d="M15 4v16" />
    </>
  ),
  focus: <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5" />,
  history: (
    <>
      <path d="M3 11a9 9 0 1 1 2.6 7M3 5v6h6M12 7v5l3 2" />
    </>
  ),
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m7.5 12 3 3 6-6" />
    </>
  ),
  check: <path d="m5 12 4 4L19 6" />,
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M12 17v3M8 20h8" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </>
  ),
  settings: (
    <>
      <path d="m9.5 3-.6 2.2-1.4.8-2.2-.6-2.5 4.2 1.6 1.6v1.6l-1.6 1.6 2.5 4.2 2.2-.6 1.4.8.6 2.2h5l.6-2.2 1.4-.8 2.2.6 2.5-4.2-1.6-1.6v-1.6l1.6-1.6-2.5-4.2-2.2.6-1.4-.8-.6-2.2Z" />
      <circle cx="12" cy="12" r="3.5" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof shapes;
export type IconSize = "default" | "small" | "medium" | "large" | "brand";

export type IconProps = {
  name: IconName;
  size?: IconSize;
};

export function Icon({ name, size = "default" }: IconProps) {
  return (
    <svg
      className={`icon icon--${size}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {shapes[name]}
    </svg>
  );
}

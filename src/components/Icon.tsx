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

type IconProps = {
  name: keyof typeof shapes;
  size?: "default" | "small" | "medium" | "large" | "brand";
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

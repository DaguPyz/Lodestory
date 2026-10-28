import type { IconSize } from "./Icon.js";
import { BODY_PATH, BLUE_PATH, BRAND_BLUE, VOID_PATH } from "./brandLogoGeometry.mjs";

export type BrandLogoProps = {
  size?: IconSize;
  className?: string;
  "aria-label"?: string;
};

/** Lodestory brand mark. Decorative by default; provide an aria-label when used without nearby brand text. */
export function BrandLogo({ size = "default", className, "aria-label": ariaLabel }: BrandLogoProps) {
  const classes = ["icon", `icon--${size}`, "brand-logo", className].filter(Boolean).join(" ");

  return (
    <svg
      className={classes}
      viewBox="0 0 200 263"
      aria-hidden={ariaLabel ? undefined : true}
      aria-label={ariaLabel}
      role={ariaLabel ? "img" : undefined}
      focusable="false"
    >
      <path d={BLUE_PATH} fill={BRAND_BLUE} />
      <path d={`${BODY_PATH}${VOID_PATH}`} fill="currentColor" fillRule="evenodd" clipRule="evenodd" />
    </svg>
  );
}

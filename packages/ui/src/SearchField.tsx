import type { InputHTMLAttributes } from "react";
import { Icon } from "./Icon.js";
import type { FocusSurface } from "./FocusSurface.js";

export type SearchFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "style" | "type" | "aria-label"> & {
  label: string;
  focusSurface?: FocusSurface;
};

export function SearchField({ label, placeholder = label, focusSurface, ...props }: SearchFieldProps) {
  return (
    <label className="search-field" data-focus-surface={focusSurface}>
      <Icon name="search" />
      <input {...props} type="search" aria-label={label} placeholder={placeholder} />
    </label>
  );
}

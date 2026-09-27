import type { InputHTMLAttributes } from "react";
import { Icon } from "./Icon";

type SearchFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "className" | "style" | "type" | "aria-label"> & {
  label: string;
};

export function SearchField({ label, placeholder = label, ...props }: SearchFieldProps) {
  return (
    <label className="search-field">
      <Icon name="search" />
      <input {...props} type="search" aria-label={label} placeholder={placeholder} />
    </label>
  );
}

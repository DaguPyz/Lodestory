import type { ComponentPropsWithRef } from "react";

export type TextFieldType = "text" | "number" | "email" | "password" | "search" | "tel" | "url";

export type TextFieldProps = Omit<ComponentPropsWithRef<"input">, "className" | "style" | "type"> & {
  type?: TextFieldType;
};

/** Native text and numeric input with shared Lodestory field states. */
export function TextField({ type = "text", ...props }: TextFieldProps) {
  return <input {...props} type={type} className="ui-text-control ui-text-field" />;
}

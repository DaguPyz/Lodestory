import type { ComponentPropsWithRef } from "react";

export type TextareaProps = Omit<ComponentPropsWithRef<"textarea">, "className" | "style">;

/** Native multiline text input with shared Lodestory field states. */
export function Textarea({ rows = 3, ...props }: TextareaProps) {
  return <textarea {...props} rows={rows} className="ui-text-control ui-textarea" />;
}

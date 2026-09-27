import type { ButtonHTMLAttributes } from "react";

type NativeButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "style">;

type ButtonProps = NativeButtonProps & {
  variant?: "primary" | "secondary" | "ghost";
};

export function Button({ variant = "secondary", type = "button", ...props }: ButtonProps) {
  return <button {...props} type={type} className={`button button--${variant}`} />;
}

type IconButtonProps = Omit<NativeButtonProps, "aria-label" | "title"> & {
  label: string;
};

export function IconButton({ label, type = "button", ...props }: IconButtonProps) {
  return <button {...props} type={type} className="icon-button" aria-label={label} title={label} />;
}

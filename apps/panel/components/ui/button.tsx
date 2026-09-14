import { forwardRef, type ComponentPropsWithRef, type ReactNode } from "react";

export type ButtonTone = "default" | "primary" | "quiet" | "danger";
export type ButtonProps = ComponentPropsWithRef<"button"> & {
  tone?: ButtonTone;
  icon?: ReactNode;
};

/** Small behavior-compatible button primitive; `.btn` remains the CSS API. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { tone = "default", icon, className = "", children, type = "button", ...props },
  ref,
) {
  const toneClass = tone === "primary" ? " primary" : tone === "quiet" ? " quiet" : tone === "danger" ? " danger" : "";
  return <button {...props} ref={ref} type={type} className={`btn${toneClass}${className ? ` ${className}` : ""}`}>{icon}{children}</button>;
});

export type IconButtonSize = "sm" | "md" | "lg";
export type IconButtonProps = ButtonProps & { label: string; size?: IconButtonSize };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = "md", className = "", children, ...props },
  ref,
) {
  return <Button {...props} ref={ref} aria-label={label} title={props.title ?? label} className={`icon-button icon-button--${size}${className ? ` ${className}` : ""}`}>{children}</Button>;
});

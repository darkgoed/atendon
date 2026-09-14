import { forwardRef, type ComponentPropsWithRef, type ReactNode } from "react";

export type ButtonTone = "default" | "primary" | "quiet" | "danger" | "secondary" | "outline";
export type ButtonVariant = "primary" | "secondary" | "ghost" | "outline" | "danger";
export type ButtonSize = "sm" | "md" | "lg";
export type ButtonProps = ComponentPropsWithRef<"button"> & {
  tone?: ButtonTone;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { tone = "default", variant, size = "md", loading = false, icon, className = "", children, type = "button", disabled, ...props }, ref,
) {
  const resolved = variant ?? (tone === "primary" ? "primary" : tone === "quiet" ? "ghost" : tone === "danger" ? "danger" : tone === "outline" ? "outline" : "secondary");
  const toneClass = resolved === "primary" ? "btn-primary" : resolved === "ghost" ? "quiet" : resolved === "danger" ? "danger" : resolved === "outline" ? "btn--outline" : "";
  const sizeClass = size === "sm" ? "btn--sm" : size === "lg" ? "btn--lg" : "";
  return <button {...props} ref={ref} type={type} disabled={disabled || loading} data-loading={loading || undefined} className={`btn ${toneClass} ${resolved === "primary" ? "primary" : ""} ${sizeClass} ${className}`.trim()}>{icon}{children}</button>;
});

export type IconButtonSize = ButtonSize;
export type IconButtonProps = ButtonProps & { label: string };
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({ label, size = "md", className = "", children, ...props }, ref) {
  return <Button {...props} ref={ref} aria-label={label} title={props.title ?? label} size={size} className={`icon-button${className ? ` ${className}` : ""}`}>{children}</Button>;
});
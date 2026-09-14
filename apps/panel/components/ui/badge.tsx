import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger" | "primary" | "outline";
export type BadgeProps = HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone; variant?: Exclude<BadgeTone, "neutral">; children?: ReactNode };
export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge({ tone = "neutral", variant, className = "", children, ...props }, ref) {
  const resolved = variant ?? tone;
  return <span {...props} ref={ref} className={`badge${resolved === "neutral" ? "" : ` badge--${resolved}`}${className ? ` ${className}` : ""}`}>{children}</span>;
});
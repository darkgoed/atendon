import { forwardRef, type HTMLAttributes, type ReactNode } from "react";

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";
export type BadgeProps = HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone; children?: ReactNode };

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge({ tone = "neutral", className = "", children, ...props }, ref) {
  return <span {...props} ref={ref} className={`badge badge--${tone}${className ? ` ${className}` : ""}`}>{children}</span>;
});

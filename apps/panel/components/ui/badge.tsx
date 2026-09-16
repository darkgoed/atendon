import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const badge = cva("badge", {
  variants: {
    tone: {
      neutral: "badge--neutral",
      primary: "badge--primary",
      info: "badge--info",
      success: "badge--success",
      warning: "badge--warning",
      danger: "badge--danger"
    },
    variant: { solid: "", outline: "badge--outline", pill: "badge--pill" }
  },
  defaultVariants: { tone: "neutral", variant: "solid" }
});

export type BadgeTone = NonNullable<VariantProps<typeof badge>["tone"]>;
export type BadgeVariant = NonNullable<VariantProps<typeof badge>["variant"]>;
export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  variant?: BadgeVariant;
  children?: ReactNode;
};

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { tone = "neutral", variant = "solid", className, children, ...props },
  ref
) {
  return <span {...props} ref={ref} className={cn(badge({ tone, variant }), className)}>{children}</span>;
});

export type DotTone = "neutral" | "primary" | "success" | "warning" | "danger";

/** Indicador mínimo de estado — 6px, sem texto. Sempre acompanhado de rótulo. */
export const Dot = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement> & { tone?: DotTone }>(function Dot(
  { tone = "neutral", className, ...props },
  ref
) {
  return (
    <span
      {...props}
      ref={ref}
      aria-hidden={props["aria-hidden"] ?? true}
      className={cn("dot", tone !== "neutral" && `dot--${tone}`, className)}
    />
  );
});

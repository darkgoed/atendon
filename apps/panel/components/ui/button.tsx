import { forwardRef, type ComponentPropsWithRef, type ReactNode } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

/**
 * Botão do design system. A API de CSS continua sendo `.btn` + variantes, então
 * markup que escreve `className="btn primary"` segue idêntico; o que muda é que
 * as variantes passam a ser tipadas e derivadas de um único lugar.
 */
const button = cva("btn", {
  variants: {
    tone: {
      default: "",
      primary: "primary",
      quiet: "quiet",
      danger: "danger",
      "danger-solid": "btn--danger-solid",
      outline: "btn--outline"
    },
    size: {
      sm: "btn--sm",
      md: "",
      lg: "btn--lg"
    },
    block: { true: "btn--block", false: "" }
  },
  defaultVariants: { tone: "default", size: "md", block: false }
});

export type ButtonTone = NonNullable<VariantProps<typeof button>["tone"]>;
export type ButtonSize = NonNullable<VariantProps<typeof button>["size"]>;
export type ButtonProps = ComponentPropsWithRef<"button"> & {
  tone?: ButtonTone;
  size?: ButtonSize;
  block?: boolean;
  icon?: ReactNode;
  /** Renderiza no elemento filho (Link, a) preservando o estilo do botão. */
  asChild?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { tone = "default", size = "md", block = false, icon, className, children, type = "button", asChild = false, ...props },
  ref
) {
  if (asChild) {
    return (
      <Slot {...props} ref={ref} className={cn(button({ tone, size, block }), className)}>
        {children}
      </Slot>
    );
  }
  return (
    <button {...props} ref={ref} type={type} className={cn(button({ tone, size, block }), className)}>
      {icon}
      {children}
    </button>
  );
});

export type IconButtonSize = "sm" | "md" | "lg";
export type IconButtonProps = Omit<ButtonProps, "size"> & { label: string; size?: IconButtonSize };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = "md", className, children, ...props },
  ref
) {
  return (
    <Button
      {...props}
      ref={ref}
      aria-label={label}
      title={props.title ?? label}
      className={cn("icon-button", `icon-button--${size}`, className)}
    >
      {children}
    </Button>
  );
});

/** Grupo segmentado para troca de visão/período — evita fileiras de botões. */
export const Segmented = forwardRef<HTMLDivElement, ComponentPropsWithRef<"div">>(function Segmented(
  { className, children, ...props },
  ref
) {
  return <div {...props} ref={ref} role={props.role ?? "group"} className={cn("segmented", className)}>{children}</div>;
});

import { forwardRef, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";

type LayoutProps = HTMLAttributes<HTMLDivElement> & { gap?: string; children?: ReactNode };

export const Stack = forwardRef<HTMLDivElement, LayoutProps>(function Stack({ children, className = "", gap = "var(--space-4)", style, ...props }, ref) {
  return <div {...props} ref={ref} className={`stack ${className}`.trim()} style={{ ...style, "--stack-gap": gap } as CSSProperties}>{children}</div>;
});

export const Cluster = forwardRef<HTMLDivElement, LayoutProps>(function Cluster({ children, className = "", gap = "var(--space-2)", style, ...props }, ref) {
  return <div {...props} ref={ref} className={`cluster ${className}`.trim()} style={{ ...style, "--cluster-gap": gap } as CSSProperties}>{children}</div>;
});

export type PageHeaderProps = Omit<HTMLAttributes<HTMLElement>, "children" | "title"> & {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
};

export const PageHeader = forwardRef<HTMLElement, PageHeaderProps>(function PageHeader({ title, description, actions, className = "", ...props }, ref) {
  return <header {...props} ref={ref} className={`pagehead ${className}`.trim()}><div><h1>{title}</h1>{description && <p className="sub">{description}</p>}</div>{actions && <div className="pagehead__actions">{actions}</div>}</header>;
});

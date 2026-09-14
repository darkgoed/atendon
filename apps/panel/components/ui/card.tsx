import { forwardRef, type HTMLAttributes, type ReactNode } from "react";

export const Card = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(function Card({ className = "", ...props }, ref) {
  return <section {...props} ref={ref} className={`card${className ? ` ${className}` : ""}`} />;
});

export const Section = forwardRef<HTMLElement, HTMLAttributes<HTMLElement> & { title?: ReactNode; description?: ReactNode; actions?: ReactNode }>(function Section({ title, description, actions, children, className = "", ...props }, ref) {
  return <section {...props} ref={ref} className={`ui-section ${className}`.trim()}>{(title || description || actions) && <header className="ui-section__header"><div>{title && <h2>{title}</h2>}{description && <p className="sub">{description}</p>}</div>{actions}</header>}{children}</section>;
});

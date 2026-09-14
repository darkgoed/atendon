import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
export type CardProps = HTMLAttributes<HTMLElement> & { elevated?: boolean; bare?: boolean; flush?: boolean; children?: ReactNode };
export const Card = forwardRef<HTMLElement, CardProps>(function Card({ elevated, bare, flush, className = "", ...props }, ref) {
  return <section {...props} ref={ref} className={`panel card${elevated ? " panel--elevated" : ""}${bare ? " panel--bare" : ""}${flush ? " panel--flush" : ""}${className ? ` ${className}` : ""}`} />;
});
export const Section = forwardRef<HTMLElement, HTMLAttributes<HTMLElement> & { title?: ReactNode; description?: ReactNode; actions?: ReactNode }>(function Section({ title, description, actions, children, className = "", ...props }, ref) {
  return <section {...props} ref={ref} className={`ui-section ${className}`.trim()}>{(title || description || actions) && <header className="ui-section__header"><div>{title && <h2>{title}</h2>}{description && <p className="type-secondary">{description}</p>}</div>{actions}</header>}{children}</section>;
});
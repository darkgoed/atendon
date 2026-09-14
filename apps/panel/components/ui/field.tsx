import { Children, cloneElement, forwardRef, isValidElement, useId, type ComponentPropsWithRef, type HTMLAttributes, type LabelHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

export type FieldProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
};

export function Field({ label, hint, error, htmlFor, children, className = "", ...props }: FieldProps) {
  const generatedId = `field-${useId().replace(/:/g, "")}`;
  const hintId = `${htmlFor ?? generatedId}-hint`;
  const errorId = `${htmlFor ?? generatedId}-error`;
  const describedBy = error ? errorId : hint ? hintId : undefined;
  const enhance = (node: ReactNode): ReactNode => {
    if (!isValidElement(node)) return node;
    const element = node as ReactElement<Record<string, unknown>>;
    const type = element.type;
    const isControl = type === "input" || type === "select" || type === "textarea" || type === Input || type === Select || type === Textarea;
    if (isControl) {
      const existingId = typeof element.props.id === "string" ? element.props.id : undefined;
      const id = existingId ?? htmlFor ?? generatedId;
      const existingDescribedBy = typeof element.props["aria-describedby"] === "string" ? element.props["aria-describedby"] : "";
      return cloneElement(element, {
        id,
        ...(describedBy ? { "aria-describedby": [existingDescribedBy, describedBy].filter(Boolean).join(" ") } : {}),
        ...(error ? { "aria-invalid": element.props["aria-invalid"] ?? "true" } : {}),
      });
    }
    if (type === "div" || type === "span") {
      return cloneElement(element, { children: Children.map(element.props.children as ReactNode, enhance) });
    }
    return node;
  };
  const control = Children.map(children, enhance);
  const findControlId = (nodes: ReactNode): string | undefined => {
    for (const node of Children.toArray(nodes)) {
      if (!isValidElement(node)) continue;
      const id = (node.props as { id?: unknown }).id;
      if (typeof id === "string") return id;
      const nested = (node.props as { children?: ReactNode }).children;
      if (nested) {
        const nestedId = findControlId(nested);
        if (nestedId) return nestedId;
      }
    }
    return undefined;
  };
  const controlId = htmlFor ?? findControlId(control);
  return <div {...props} className={`field${error ? " field--error" : ""}${className ? ` ${className}` : ""}`}>
    {label && <label htmlFor={controlId}>{label}</label>}
    {control}
    {error ? <small id={errorId} className="field__error" role="alert">{error}</small> : hint ? <small id={hintId} className="sub">{hint}</small> : null}
  </div>;
}

export const Input = forwardRef<HTMLInputElement, ComponentPropsWithRef<"input">>(function Input({ className = "", ...props }, ref) { return <input {...props} ref={ref} className={`input${className ? ` ${className}` : ""}`} />; });
export const Select = forwardRef<HTMLSelectElement, ComponentPropsWithRef<"select">>(function Select({ className = "", ...props }, ref) { return <select {...props} ref={ref} className={`input${className ? ` ${className}` : ""}`} />; });
export const Textarea = forwardRef<HTMLTextAreaElement, ComponentPropsWithRef<"textarea">>(function Textarea({ className = "", ...props }, ref) { return <textarea {...props} ref={ref} className={`input${className ? ` ${className}` : ""}`} />; });
export type { ComponentPropsWithRef, LabelHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes };

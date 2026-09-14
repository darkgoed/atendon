import { forwardRef, type HTMLAttributes, type ReactNode, type TableHTMLAttributes } from "react";

export const Table = forwardRef<HTMLTableElement, TableHTMLAttributes<HTMLTableElement>>(function Table({ children, className = "", ...props }, ref) { return <div className="table-wrap" tabIndex={0}><table {...props} ref={ref} className={className}>{children}</table></div>; });
export const TableScroll = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { children: ReactNode }>(function TableScroll({ children, className = "", ...props }, ref) { return <div tabIndex={0} {...props} ref={ref} className={`table-scroll ${className}`.trim()}>{children}</div>; });

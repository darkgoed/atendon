import type { ComponentProps, HTMLAttributes, ReactNode } from "react";
import { Button, Field, KpiCard, KpiGrid, PageHeader, TableScroll } from "@/components/ui";
import styles from "./admin.module.css";

export function AdminPage({ children, className = "", ...props }: Omit<HTMLAttributes<HTMLDivElement>, "children"> & { children: ReactNode }) {
  return <div {...props} className={`${styles.page} ${className}`.trim()}>{children}</div>;
}

export function AdminPageHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return <PageHeader title={title} actions={actions} className={styles.header} />;
}

export function AdminActions({ children, end = false, className = "" }: { children: ReactNode; end?: boolean; className?: string }) {
  return <div className={`${styles.actions} ${end ? styles.actionsEnd : ""} ${className}`.trim()}>{children}</div>;
}

export function AdminSection({ title, description, actions, children, className = "", ...props }: HTMLAttributes<HTMLElement> & { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return <section {...props} className={`${styles.section} ${className}`.trim()}>{title || description || actions ? <div className={styles.sectionHeader}><div>{title ? <h2>{title}</h2> : null}{description ? <p className="sub">{description}</p> : null}</div>{actions}</div> : null}{children}</section>;
}

export function AdminCard({ children, className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`card admin-card ${className}`.trim()}>{children}</div>;
}

export function AdminMetricGrid({ children, className = "", ...props }: HTMLAttributes<HTMLElement> & { children: ReactNode }) {
  return <KpiGrid {...props} className={className}>{children}</KpiGrid>;
}

export function AdminMetricValue({ children, className = "", ...props }: HTMLAttributes<HTMLElement> & { children: ReactNode }) {
  return <strong {...props} className={`${styles.metricValue} ${className}`.trim()}>{children}</strong>;
}

/** Card de KPI padrão do console admin — rótulo, valor e detalhe opcional. */
export function AdminMetric({ label, value, detail, tone }: { label: string; value: ReactNode; detail?: ReactNode; tone?: ComponentProps<typeof KpiCard>["tone"] }) {
  return <KpiCard label={label} value={value} hint={detail} tone={tone} />;
}

export function AdminField({ label, hint, error, children, ...props }: Omit<ComponentProps<typeof Field>, "children"> & { children: ReactNode }) {
  return <Field {...props} label={label} hint={hint} error={error}>{children}</Field>;
}

export { Button as AdminButton, TableScroll as AdminTableScroll };
export { styles as adminStyles };

"use client";

import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type ReactNode } from "react";

type Placement = { top: number; left?: number; right?: number };

/**
 * Dropdown trigger + panel rendered via portal so the panel escapes any
 * ancestor `overflow:hidden`/`overflow:auto` clipping (the shell, scrollable
 * lists, the pipeline board, etc. all clip absolutely-positioned children).
 */
export function PopoverMenu({
  icon,
  label,
  buttonClassName = "btn",
  panelClassName = "",
  align = "end",
  ariaLabel,
  title,
  children
}: {
  icon?: ReactNode;
  label?: ReactNode;
  buttonClassName?: string;
  panelClassName?: string;
  align?: "start" | "end";
  ariaLabel?: string;
  title?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const reposition = () => {
      const box = anchorRef.current?.getBoundingClientRect();
      if (!box) return;
      setPlacement(align === "end"
        ? { top: box.bottom + 6, right: Math.max(8, window.innerWidth - box.right) }
        : { top: box.bottom + 6, left: Math.max(8, box.left) });
    };
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, align]);

  // Flips the panel above the trigger or clamps it horizontally once its real
  // size is known, so it never overflows the viewport near screen edges.
  useEffect(() => {
    if (!open || !placement) return;
    const panel = panelRef.current;
    const box = anchorRef.current?.getBoundingClientRect();
    if (!panel || !box) return;
    const rect = panel.getBoundingClientRect();
    let next = placement;
    if (rect.bottom > window.innerHeight - 8) {
      next = { ...next, top: Math.max(8, box.top - rect.height - 6) };
    }
    if (next.left !== undefined && rect.right > window.innerWidth - 8) {
      next = { top: next.top, right: 8 };
    }
    if (next.right !== undefined && rect.left < 8) {
      next = { top: next.top, left: 8 };
    }
    if (next.top !== placement.top || next.left !== placement.left || next.right !== placement.right) {
      setPlacement(next);
    }
  }, [open, placement]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        ref={anchorRef}
        className={buttonClassName}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
      >
        {icon}
        {label}
      </button>
      {open && placement && typeof document !== "undefined"
        ? createPortal(
            <div
              ref={panelRef}
              className={panelClassName}
              style={{ position: "fixed", top: placement.top, left: placement.left, right: placement.right, zIndex: "var(--z-popover)" }}
            >
              {children(close)}
            </div>,
            document.body
          )
        : null}
    </>
  );
}

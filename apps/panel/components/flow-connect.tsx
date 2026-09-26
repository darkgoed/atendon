"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight } from "@/components/icons";
import styles from "./flow-connect.module.css";

export type FlowConnectDirection = "horizontal" | "vertical" | "auto";

export type FlowConnectItem = {
  key: string;
  label: string;
  description?: string;
};

/** Segmento medido: linha (reta ou curva em S) + cabeça de seta (chevron). */
type Segment = { line: string; head: string };

type Box = { left: number; top: number; right: number; bottom: number; width: number; height: number };

/* Distância da borda do card até o início/fim da linha. */
const EDGE_GAP = 2;
/* Comprimento da cabeça de seta (chevron aberto, mesmo peso da linha). */
const HEAD = 6;
/* Abertura da cabeça em radianos (~26° de cada lado). */
const HEAD_SPREAD = 0.46;
/* Deriva máxima de centro que ainda lê como "empilhado" (seta reta ↓). */
const ALIGN_TOLERANCE = 24;

const round = (value: number): number => Math.round(value * 10) / 10;

function chevron(x: number, y: number, angle: number): string {
  const p1x = x - HEAD * Math.cos(angle - HEAD_SPREAD);
  const p1y = y - HEAD * Math.sin(angle - HEAD_SPREAD);
  const p2x = x - HEAD * Math.cos(angle + HEAD_SPREAD);
  const p2y = y - HEAD * Math.sin(angle + HEAD_SPREAD);
  return `M ${round(p1x)} ${round(p1y)} L ${round(x)} ${round(y)} L ${round(p2x)} ${round(p2y)}`;
}

function straight(x1: number, y1: number, x2: number, y2: number): Segment {
  return {
    line: `M ${round(x1)} ${round(y1)} L ${round(x2)} ${round(y2)}`,
    head: chevron(x2, y2, Math.atan2(y2 - y1, x2 - x1)),
  };
}

/**
 * Conector entre dois cards medidos:
 * - mesma linha → seta reta → ;
 * - card seguinte empilhado abaixo (coluna/quebra alinhada) → seta reta ↓;
 * - quebra de linha (wrap) → curva em S (cúbica = 1–2 curvas) saindo da
 *   borda direita do card anterior e entrando pela esquerda do seguinte.
 */
function connect(a: Box, b: Box): Segment {
  const aMidY = (a.top + a.bottom) / 2;
  const bMidY = (b.top + b.bottom) / 2;
  const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  const sameRow = overlapY > Math.min(a.height, b.height) / 2;
  if (sameRow) return straight(a.right + EDGE_GAP, aMidY, b.left - EDGE_GAP, bMidY);

  const aCenterX = a.left + a.width / 2;
  const bCenterX = b.left + b.width / 2;
  if (Math.abs(aCenterX - bCenterX) <= ALIGN_TOLERANCE) {
    return straight(aCenterX, a.bottom + EDGE_GAP, bCenterX, b.top - EDGE_GAP);
  }

  const x1 = a.right + EDGE_GAP;
  const x2 = b.left - EDGE_GAP;
  const bend = Math.min(Math.abs(bMidY - aMidY) * 0.6, 44);
  const cx1 = x1 + bend;
  const cx2 = x2 - bend;
  return {
    line: `M ${round(x1)} ${round(aMidY)} C ${round(cx1)} ${round(aMidY)}, ${round(cx2)} ${round(bMidY)}, ${round(x2)} ${round(bMidY)}`,
    head: chevron(x2, bMidY, Math.atan2(bMidY - aMidY, x2 - cx2)),
  };
}

function sameSegments(prev: Segment[] | null, next: Segment[]): boolean {
  return (
    prev !== null &&
    prev.length === next.length &&
    prev.every((segment, index) => segment.line === next[index].line && segment.head === next[index].head)
  );
}

/**
 * FlowConnect — pattern "fluxo conectado": blocos `.card` ligados por setas
 * discretas (1px + cabeça pequena), sem numeração e sem semântica de wizard.
 *
 * Horizontal com wrap: ao quebrar linha o conector entre o último card da
 * linha e o primeiro da seguinte vira uma curva em S, desenhada por um SVG
 * overlay calculado das posições reais (getBoundingClientRect +
 * ResizeObserver). Sem medição (SSR, erro, ResizeObserver ausente) os
 * conectores caem para setas retas inline entre os cards.
 */
export function FlowConnect({
  items,
  direction = "auto",
}: {
  items: FlowConnectItem[];
  direction?: FlowConnectDirection;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [segments, setSegments] = useState<Segment[] | null>(null);

  const measure = useCallback(() => {
    try {
      const root = rootRef.current;
      if (!root) return;
      const origin = root.getBoundingClientRect();
      if (origin.width === 0 && origin.height === 0) return; // sem layout (jsdom/oculto) → fallback
      const cards = Array.from(root.querySelectorAll<HTMLElement>("[data-flow-card]"));
      if (cards.length < 2) {
        setSegments(null);
        return;
      }
      const boxes = cards.map((card) => {
        const rect = card.getBoundingClientRect();
        return {
          left: rect.left - origin.left,
          top: rect.top - origin.top,
          right: rect.right - origin.left,
          bottom: rect.bottom - origin.top,
          width: rect.width,
          height: rect.height,
        };
      });
      const next: Segment[] = [];
      for (let index = 0; index + 1 < boxes.length; index += 1) next.push(connect(boxes[index], boxes[index + 1]));
      setSegments((prev) => (sameSegments(prev, next) ? prev : next));
    } catch {
      setSegments(null); // erro de medição → fallback setas retas
    }
  }, []);

  useEffect(() => {
    measure();
  }, [measure, items]);

  useEffect(() => {
    const root = rootRef.current;
    // Safari 12–13.0 não tem ResizeObserver: permanece no fallback inline.
    if (!root || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, [measure]);

  if (items.length === 0) return null;

  const measured = segments !== null;

  return (
    <div ref={rootRef} className={styles.root} role="list" data-direction={direction} data-measured={measured ? "true" : undefined}>
      {items.map((item, index) => (
        <Fragment key={item.key}>
          {index > 0 ? (
            <div aria-hidden="true" className={styles.connectorSlot} data-flow-connector="true">
              <ArrowRight size={16} focusable="false" className={styles.connectorGlyph} />
            </div>
          ) : null}
          <div role="listitem" className={`${styles.item} card`} data-flow-card="true">
            <span className="cardtitle">{item.label}</span>
            {item.description ? <span className="type-secondary">{item.description}</span> : null}
          </div>
        </Fragment>
      ))}
      {measured && segments !== null ? (
        <svg className={styles.overlay} aria-hidden="true" focusable="false">
          {segments.map((segment, index) => (
            <Fragment key={index}>
              <path className={styles.connectorLine} d={segment.line} />
              <path className={styles.connectorHead} d={segment.head} />
            </Fragment>
          ))}
        </svg>
      ) : null}
    </div>
  );
}

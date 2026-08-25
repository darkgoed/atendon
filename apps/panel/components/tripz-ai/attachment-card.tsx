"use client";

import { FileImage, FilePdf, WarningCircle } from "@phosphor-icons/react";
import React from "react";
import {
  formatTripzFileSize,
  tripzApiContentUrl,
  tripzAttachmentContentPath,
  tripzAttachmentStatusLabel,
  type TripzAttachment
} from "../../lib/tripz-ai";

export function TripzAttachmentCard({
  attachment,
  conversationId
}: {
  attachment: TripzAttachment;
  conversationId: string;
}) {
  const isImage = attachment.mimeType.startsWith("image/");
  const href = tripzApiContentUrl(tripzAttachmentContentPath(conversationId, attachment.id));
  const failed = attachment.processingStatus === "failed";

  return (
    <a
      className="group grid min-w-0 grid-cols-[3.25rem_minmax(0,1fr)] overflow-hidden border border-[var(--border)] bg-[var(--panel-secondary)] text-left text-[var(--body)] no-underline transition-[border-color,transform,opacity] duration-200 hover:border-[var(--strong)] active:translate-y-px"
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label={`Abrir anexo ${attachment.filename}`}
    >
      <span className="grid h-[3.25rem] place-items-center overflow-hidden border-r border-[var(--border)] bg-[var(--app)] text-[var(--accent)]">
        {isImage ? (
          // A mídia vem de endpoint autenticado, nunca de URL informada pela IA.
          // eslint-disable-next-line @next/next/no-img-element
          <img className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]" src={href} alt="" />
        ) : (
          <FilePdf size={22} weight="duotone" aria-hidden="true" />
        )}
      </span>
      <span className="grid min-w-0 content-center gap-0.5 px-3 py-2">
        <strong className="truncate text-xs font-semibold text-[var(--text)]">{attachment.filename}</strong>
        <span className={`flex min-w-0 items-center gap-1.5 text-[10px] ${failed ? "text-[var(--warn)]" : "text-[var(--faint-text)]"}`}>
          {failed ? <WarningCircle size={11} weight="fill" aria-hidden="true" /> : isImage ? <FileImage size={11} aria-hidden="true" /> : null}
          <span className="truncate">{tripzAttachmentStatusLabel(attachment.processingStatus)}</span>
          <span aria-hidden="true">·</span>
          <span>{formatTripzFileSize(attachment.size)}</span>
        </span>
      </span>
    </a>
  );
}

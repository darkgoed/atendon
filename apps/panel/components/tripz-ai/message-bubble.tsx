"use client";

import { Robot, User } from "@/components/icons";
import React from "react";
import { formatTripzTimestamp, type TripzMessage } from "../../lib/tripz-ai";
import { TripzAttachmentCard } from "./attachment-card";
import styles from "./tripz-ai.module.css";

export function TripzMessageBubble({
  conversationId,
  message
}: {
  conversationId: string;
  message: TripzMessage;
}) {
  const fromUser = message.role === "user";
  return (
    <article
      className={`${styles.message} ${fromUser ? styles.messageUser : styles.messageAi}`}
      aria-label={fromUser ? "Mensagem enviada por você" : "Resposta da Tripz IA"}
    >
      <header className={`flex items-center gap-2 px-1 text-[10px] font-medium ${fromUser ? "flex-row-reverse text-[var(--text-muted)]" : "text-[var(--primary-text)]"}`}>
        <span className={`grid h-5 w-5 place-items-center border ${fromUser ? "border-[var(--border-strong)] bg-[var(--surface)]" : "border-[var(--primary-border)] bg-[var(--primary-subtle)]"}`} aria-hidden="true">
          {fromUser ? <User size={11} weight="bold" /> : <Robot size={12} weight="duotone" />}
        </span>
        <span>{fromUser ? "Você" : "Tripz IA"}</span>
        <time className="font-mono font-normal text-[var(--text-muted)]" dateTime={message.createdAt}>
          {formatTripzTimestamp(message.createdAt)}
        </time>
      </header>

      {message.content ? (
        <div className={`${fromUser ? styles.messageBodyUser : styles.messageBody} px-4 py-3`}>
          <p className="m-0 whitespace-pre-wrap text-[13px] leading-6 text-[var(--text-secondary)]">{message.content}</p>
        </div>
      ) : null}

      {message.attachments.length > 0 ? (
        <div className={`grid w-full gap-2 sm:grid-cols-2 ${fromUser ? "max-w-[36rem]" : "max-w-[42rem]"}`}>
          {message.attachments.map((attachment) => (
            <TripzAttachmentCard key={attachment.id} attachment={attachment} conversationId={conversationId} />
          ))}
        </div>
      ) : null}
    </article>
  );
}

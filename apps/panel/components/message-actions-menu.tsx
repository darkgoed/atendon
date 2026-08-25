"use client";

import { ArrowBendUpLeft, Copy, DotsThreeVertical, PencilSimple, Trash } from "@phosphor-icons/react";
import { PopoverMenu } from "@/components/popover-menu";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

export function MessageActionsMenu({
  isOwn,
  align,
  reactionEmoji,
  onReply,
  onCopy,
  onReact,
  onEdit,
  onDelete
}: {
  isOwn: boolean;
  align: "start" | "end";
  reactionEmoji?: string | null;
  onReply: () => void;
  onCopy: () => void;
  onReact: (emoji: string) => void;
  onEdit?: () => void;
  onDelete: (forEveryone: boolean) => void;
}) {
  return (
    <PopoverMenu
      buttonClassName="message-actions-menu__trigger"
      icon={<DotsThreeVertical size={14} weight="bold" aria-hidden="true" />}
      ariaLabel="Ações da mensagem"
      title="Mais ações"
      align={align}
      panelClassName="conversation-action-menu__panel message-actions-menu__panel"
    >
      {(close) => (
        <>
          <div className="message-actions-menu__reactions">
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className={`message-actions-menu__reaction ${reactionEmoji === emoji ? "message-actions-menu__reaction--active" : ""}`}
                onClick={() => { onReact(reactionEmoji === emoji ? "" : emoji); close(); }}
                aria-label={`Reagir com ${emoji}`}
              >
                {emoji}
              </button>
            ))}
          </div>
          <button type="button" className="conversation-action-menu__item" onClick={() => { onReply(); close(); }}>
            <ArrowBendUpLeft size={15} aria-hidden="true" /> Responder
          </button>
          <button type="button" className="conversation-action-menu__item" onClick={() => { onCopy(); close(); }}>
            <Copy size={15} aria-hidden="true" /> Copiar
          </button>
          {isOwn && onEdit ? (
            <button type="button" className="conversation-action-menu__item" onClick={() => { onEdit(); close(); }}>
              <PencilSimple size={15} aria-hidden="true" /> Editar
            </button>
          ) : null}
          {isOwn ? (
            <button
              type="button"
              className="conversation-action-menu__item conversation-action-menu__item--warn"
              onClick={() => { if (window.confirm("Apagar esta mensagem para todos? Ela some do celular do contato também.")) { onDelete(true); close(); } }}
            >
              <Trash size={15} aria-hidden="true" /> Apagar para todos
            </button>
          ) : null}
          <button
            type="button"
            className="conversation-action-menu__item conversation-action-menu__item--warn"
            onClick={() => { if (window.confirm("Apagar esta mensagem?")) { onDelete(false); close(); } }}
          >
            <Trash size={15} aria-hidden="true" /> Apagar
          </button>
        </>
      )}
    </PopoverMenu>
  );
}

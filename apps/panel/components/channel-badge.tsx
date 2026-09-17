"use client";

import Image from "next/image";

export type Channel = "whatsapp" | "instagram";

export function ChannelBadge({ channel, size = 12, className }: { channel: Channel; size?: number; className?: string }) {
  const label = channel === "instagram" ? "Canal Instagram" : "Canal WhatsApp";
  return (
    <span
      title={label}
      aria-label={label}
      role="img"
      className={`inline-flex shrink-0 items-center ${className ?? ""}`}
      data-channel={channel}
    >
      <Image
        src={channel === "instagram" ? "/brand/instagram.svg" : "/brand/whatsapp.svg"}
        alt=""
        aria-hidden="true"
        width={size}
        height={size}
        style={{ width: size, height: size }}
        draggable={false}
        unoptimized
      />
    </span>
  );
}

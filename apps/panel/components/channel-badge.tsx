"use client";

import { InstagramLogo, WhatsappLogo } from "@phosphor-icons/react";

export type Channel = "whatsapp" | "instagram";

export function ChannelBadge({ channel, size = 12 }: { channel: Channel; size?: number }) {
  const label = channel === "instagram" ? "Canal Instagram" : "Canal WhatsApp";
  return (
    <span title={label} aria-label={label} role="img" className="inline-flex items-center" data-channel={channel}>
      {channel === "instagram"
        ? <InstagramLogo size={size} color="currentColor" aria-hidden="true" />
        : <WhatsappLogo size={size} color="currentColor" aria-hidden="true" />}
    </span>
  );
}

"use client";

import { FacebookLogo, GlobeHemisphereWest, GoogleLogo, InstagramLogo, Megaphone, WhatsappLogo } from "@/components/icons";
import type { PipelineLead } from "@/lib/pipeline";

type Attribution = { source_url?: string | null; source_type?: string | null; headline?: string | null };
type OriginLead = Pick<PipelineLead, "origem" | "campanha"> & { origem_facebook?: Attribution | null };

function platform(value?: string | null) {
  return (["whatsapp", "instagram", "facebook", "google"] as const).find((name) => new RegExp(`(?:^|[\\s_:/.-])${name}(?:$|[\\s_:/.-])`, "i").test(value ?? ""));
}

function attributionPlatform(attribution?: Attribution | null) {
  if (attribution?.source_url) {
    try {
      const hostname = new URL(attribution.source_url).hostname.toLowerCase();
      for (const name of ["instagram", "facebook", "google", "whatsapp"] as const) {
        if (hostname === `${name}.com` || hostname.endsWith(`.${name}.com`)) return name;
      }
      if (hostname === "wa.me") return "whatsapp";
    } catch { /* A URL inválida não identifica uma rede. */ }
  }
  return platform(attribution?.source_type);
}

const icons = { whatsapp: WhatsappLogo, instagram: InstagramLogo, facebook: FacebookLogo, google: GoogleLogo };

export function PipelineOrigin({ lead }: { lead: OriginLead }) {
  const attribution = lead.origem_facebook;
  const campaign = lead.campanha || attribution?.headline;
  const entries = [
    { text: lead.origem, label: "Origem", channel: platform(lead.origem), fallback: GlobeHemisphereWest },
    { text: campaign, label: "Campanha", channel: platform(campaign) ?? attributionPlatform(attribution), fallback: Megaphone }
  ];
  const description = entries.map((entry) => entry.text).filter(Boolean).join(" · ");
  if (!description) return null;
  return <p className="pipeline-card__origin" title={description}>
    {entries.filter((entry) => entry.text).map(({ text, label, channel, fallback }) => {
      const Icon = channel ? icons[channel] : fallback;
      return <span key={label} role="img" aria-label={`${label}: ${text}`} title={`${label}: ${text}`} data-platform={channel ?? "unknown"}>
        <Icon size={14} aria-hidden="true" />
      </span>;
    })}
  </p>;
}

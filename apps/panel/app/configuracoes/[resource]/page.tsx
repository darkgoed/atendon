import { notFound } from "next/navigation";
import ConfigPage from "../page";

// 13 chaves de configuração (SPEC settings-search) — inclui google-calendar.
// Deve espelhar as chaves de resourceLabels em ../page.
const CONFIG_RESOURCES: readonly string[] = [
  "workspace",
  "categorias",
  "parceiros",
  "unidades",
  "attendants",
  "conversation-queues",
  "atendon-meet",
  "google-meet",
  "google-calendar",
  "signature",
  "panel-notifications",
  "agenda-notifications",
  "armazenamento"
];

export default async function ConfigResourcePage({ params }: { params: Promise<{ resource: string }> }) {
  const { resource } = await params;
  if (!CONFIG_RESOURCES.includes(resource)) notFound();
  return <ConfigPage />;
}

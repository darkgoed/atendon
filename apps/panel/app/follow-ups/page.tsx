"use client";

import { useRef, useState } from "react";
import useSWR from "swr";
import { Check, Trash, UploadSimple, Clock, Image, VideoCamera, Microphone, Sticker } from "@phosphor-icons/react";
import { Empty, LoadingCards } from "@/components/page-state";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";

type Settings = { enabled?: boolean; delaysMinutes?: number[]; [key: string]: unknown };
type Media = { id: string; name?: string; file_name?: string; mime_type?: string; media_type?: string; type?: string; size_bytes?: number; enabled?: boolean };
const fetcher = <T,>(url: string) => api<T>(url);
const types = [
  { key: "image", label: "Imagem", Icon: Image, accept: "image/*" },
  { key: "video", label: "Vídeo", Icon: VideoCamera, accept: "video/*" },
  { key: "audio", label: "Áudio", Icon: Microphone, accept: "audio/*" },
  { key: "sticker", label: "Figurinha", Icon: Sticker, accept: "image/webp" }
] as const;

async function base64(file: File) { return new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("Não foi possível ler o arquivo")); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.readAsDataURL(file); }); }

export default function FollowUpsPage() {
  const { data: settings, error: settingsError, mutate: mutateSettings } = useSWR<Settings>("/ai-follow-ups/settings", fetcher, { revalidateOnFocus: false });
  const { data: mediaData, error, mutate } = useSWR<{ media?: Media[]; assets?: Media[] }>("/ai-follow-ups/media", fetcher, { revalidateOnFocus: false });
  const [enabled, setEnabled] = useState<boolean>();
  const [delays, setDelays] = useState("");
  const [status, setStatus] = useState("");
  const [file, setFile] = useState<File>();
  const input = useRef<HTMLInputElement>(null);
  const media = mediaData?.media ?? mediaData?.assets ?? [];
  const currentEnabled = enabled ?? Boolean(settings?.enabled);
  const initialLoading = (!settings && !settingsError) || (!mediaData && !error);
  async function saveSettings() { setStatus("Salvando configurações…"); try { await api("/ai-follow-ups/settings", { method: "PATCH", body: JSON.stringify({ ...settings, enabled: currentEnabled, delaysMinutes: delays.split(",").map(Number).filter(Number.isFinite) }) }); await mutateSettings(); setStatus("Configurações salvas."); } catch (e) { setStatus(e instanceof Error ? e.message : "Não foi possível salvar."); } }
  async function upload() { if (!file) return; setStatus("Enviando mídia…"); try { await api("/ai-follow-ups/media", { method: "POST", body: JSON.stringify({ fileName: file.name, mimeType: file.type, dataBase64: await base64(file), type: file.type.startsWith("video") ? "video" : file.type.startsWith("audio") ? "audio" : file.type === "image/webp" ? "sticker" : "image" }) }); setFile(undefined); if (input.current) input.current.value = ""; await mutate(); setStatus("Mídia adicionada."); } catch (e) { setStatus(e instanceof Error ? e.message : "Não foi possível enviar a mídia."); } }
  async function remove(id: string) { try { await api(`/ai-follow-ups/media/${id}`, { method: "DELETE" }); await mutate(); setStatus("Mídia removida."); } catch (e) { setStatus(e instanceof Error ? e.message : "Não foi possível remover."); } }
  return <Shell>
    <header className="pagehead"><div><div className="mono mb-3 flex items-center gap-2 text-[10px] uppercase tracking-[.16em] text-[var(--accent-soft)]"><Clock size={18}/>Automação da IA</div><h1>Follow-ups</h1><p>Configure a cadência e a biblioteca de mídias usadas nas mensagens automáticas.</p></div></header>
    {initialLoading ? <LoadingCards label="Carregando configurações de follow-ups" /> : <section className="grid gap-5 border-y border-[var(--border)] py-6"><div><h2 className="text-base font-semibold">Configurações e cadência</h2><p className="sub mt-1">Defina se os follow-ups estão ativos e o intervalo de cada tentativa.</p></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={currentEnabled} onChange={e => setEnabled(e.target.checked)}/> Ativar follow-ups</label><label className="field max-w-md"><span>Cadência (minutos, separados por vírgula)</span><input className="input" value={delays || (settings?.delaysMinutes ?? []).join(", ")} onChange={e => setDelays(e.target.value)} placeholder="60, 1440, 4320"/></label><button className="btn primary w-fit" onClick={() => void saveSettings()}>Salvar configurações</button></section>}
    <section className="mt-8 grid gap-5"><div><h2 className="text-base font-semibold">Biblioteca de mídia</h2><p className="sub mt-1">Imagens, vídeos, áudios e figurinhas para os follow-ups.</p></div><div className="grid gap-3 sm:grid-cols-4">{types.map(({ key, label, Icon }) => <div key={key} className="border border-[var(--border)] p-4"><Icon size={20} className="mb-2 text-[var(--accent-soft)]"/><strong className="block">{label}</strong><span className="sub">Disponível para envio</span></div>)}</div><div className="flex flex-wrap items-center gap-3"><input ref={input} className="input max-w-md" type="file" accept="image/*,video/*,audio/*" onChange={e => setFile(e.target.files?.[0])}/><button className="btn primary" disabled={!file} onClick={() => void upload()}><UploadSimple size={16}/>Enviar mídia</button></div>{error ? <p role="alert" className="error">{error.message}</p> : settingsError ? <p role="alert" className="error">{settingsError.message}</p> : initialLoading ? <LoadingCards label="Carregando mídias de follow-ups" /> : media.length === 0 ? <Empty>Nenhuma mídia cadastrada.</Empty> : <div className="divide-y divide-[var(--border)] border-y border-[var(--border)]">{media.map(item => <div className="flex items-center justify-between py-4" key={item.id}><span>{item.name ?? item.file_name ?? item.id} <small className="sub">({item.media_type ?? item.type ?? item.mime_type})</small></span><button className="btn" onClick={() => void remove(item.id)} aria-label={`Remover ${item.name ?? item.id}`}><Trash size={16}/></button></div>)}</div>}</section>{status && <p role="status" className="mt-5 flex items-center gap-2 accent"><Check size={16}/>{status}</p>}
  </Shell>;
}

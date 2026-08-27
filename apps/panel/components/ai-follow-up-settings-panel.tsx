"use client";

import { ChatCircleDots, ClockCountdown, FloppyDisk, ImageSquare, Plus, Prohibit, Sticker, Trash, UploadSimple } from "@phosphor-icons/react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import useSWR from "swr";
import { api } from "@/lib/api";
import { formatFollowUpDelay, isValidFollowUpDelays, normalizeFollowUpDelivery, type AiFollowUpSettings, type FollowUpDelivery } from "@/lib/ai-follow-ups";

type FollowUpMedia = { id: string; name: string; description: string; mime_type: string; file_name: string; size_bytes: number };
type FollowUpSticker = { id: string; name: string; enabled: boolean };
function apiContentUrl(path: string) { const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/backend"; return `${base}${path}`; }
async function fileBase64(file: File): Promise<string> { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error("Não foi possível ler a mídia")); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.readAsDataURL(file); }); }

export function AiFollowUpSettingsPanel() {
  const defaultDelays = [120, 1440, 4320];
  const [settings, setSettings] = useState<AiFollowUpSettings>({
    enabled: false,
    delaysMinutes: defaultDelays,
    delivery: normalizeFollowUpDelivery(defaultDelays)
  });
  const [media, setMedia] = useState<FollowUpMedia[]>([]);
  // A biblioteca de figurinhas usa a mesma chave SWR; assim, cadastrar ou ativar
  // uma figurinha lá revalida esta lista sem exigir reload da página.
  const { data: stickerData } = useSWR<{ stickers: FollowUpSticker[] }>(
    "/ai-stickers",
    (url: string) => api<{ stickers: FollowUpSticker[] }>(url),
    { revalidateOnFocus: false }
  );
  const stickers = useMemo(
    () => (stickerData?.stickers ?? []).filter((sticker) => sticker.enabled),
    [stickerData?.stickers]
  );
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadFile, setUploadFile] = useState<File>();
  const [uploadName, setUploadName] = useState("");
  const [uploadDescription, setUploadDescription] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([
      api<{ settings: AiFollowUpSettings }>("/ai-follow-ups/settings"),
      api<{ media: FollowUpMedia[] }>("/ai-follow-ups/media")
    ])
      .then(([settingsResponse, mediaResponse]) => {
        if (!active) return;
        setSettings({
          ...settingsResponse.settings,
          delivery: normalizeFollowUpDelivery(
            settingsResponse.settings.delaysMinutes,
            settingsResponse.settings.delivery
          )
        });
        setMedia(mediaResponse.media);
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Falha ao carregar os follow-ups da IA");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSaved(false);
    if (!isValidFollowUpDelays(settings.delaysMinutes)) {
      setError("Os atrasos devem ser crescentes, entre 1 minuto e 30 dias.");
      return;
    }
    const payload: AiFollowUpSettings = {
      enabled: settings.enabled,
      delaysMinutes: settings.delaysMinutes,
      delivery: normalizeFollowUpDelivery(settings.delaysMinutes, settings.delivery)
    };
    setSaving(true);
    try {
      const response = await api<{ settings: AiFollowUpSettings }>("/ai-follow-ups/settings", {
        method: "PUT",
        body: JSON.stringify(payload)
      });
      setSettings(response.settings);
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Falha ao salvar os follow-ups da IA");
    } finally {
      setSaving(false);
    }
  }

  async function uploadImage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!uploadFile || !uploadName.trim() || !uploadDescription.trim()) return;
    setError("");
    setUploading(true);
    try {
      const response = await api<{ media: FollowUpMedia }>("/ai-follow-ups/media", {
        method: "POST",
        body: JSON.stringify({
          name: uploadName.trim(),
          description: uploadDescription.trim(),
          mimeType: uploadFile.type,
          fileName: uploadFile.name,
          dataBase64: await fileBase64(uploadFile)
        })
      });
      setMedia((current) => [response.media, ...current.filter((item) => item.id !== response.media.id)]);
      setUploadFile(undefined);
      setUploadName("");
      setUploadDescription("");
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Falha ao adicionar a mídia");
    } finally {
      setUploading(false);
    }
  }

  function changeDelivery(index: number, delivery: FollowUpDelivery) {
    setSettings((current) => {
      const next = normalizeFollowUpDelivery(current.delaysMinutes, current.delivery);
      next[index] = delivery;
      return { ...current, delivery: next };
    });
    setSaved(false);
  }

  if (loading) {
    return (
      <div className="grid gap-4 md:grid-cols-[minmax(0,1.45fr)_minmax(280px,.55fr)]" aria-busy="true" aria-label="Carregando follow-ups da IA">
        <div className="card grid gap-4"><div className="skeleton h-8 w-2/5" /><div className="skeleton h-20" /><div className="skeleton h-28" /></div>
        <div className="card grid gap-3"><div className="skeleton h-6 w-1/2" /><div className="skeleton h-16" /><div className="skeleton h-16" /></div>
      </div>
    );
  }

  return (
    <div className="grid gap-5 md:grid-cols-[minmax(0,1.45fr)_minmax(280px,.55fr)]">
      <form className="card" onSubmit={submit}>
        <div className="mb-6 flex items-start justify-between gap-5 border-b border-[var(--border)] pb-5">
          <div>
            <div className="cardtitle">Cadência automática</div>
            <p className="sub mt-1 max-w-[62ch]">Após o intervalo, a IA relê a conversa e só envia se a resposta for necessária para avançar ao agendamento ou ao fechamento com o SDR ou especialista. Qualquer resposta do contato encerra a sequência atual.</p>
          </div>
          <label className="flex shrink-0 items-center gap-3 text-sm font-medium text-[var(--body)]">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => { setSettings((current) => ({ ...current, enabled: event.target.checked })); setSaved(false); }}
            />
            {settings.enabled ? "Ativo" : "Inativo"}
          </label>
        </div>

        {error ? <p className="error mb-5" role="alert">{error}</p> : null}
        {saved ? <p className="mb-5 text-sm text-[var(--accent-soft)]" role="status">Configuração salva.</p> : null}

        <div className="grid gap-3">
          <div className="flex items-end justify-between gap-4">
            <div>
              <div className="label">Tentativas cumulativas</div>
              <p className="sub mt-1 text-xs">Cada valor é contado desde a resposta original da IA, não desde a tentativa anterior.</p>
            </div>
            <button
              type="button"
              className="btn"
              disabled={settings.delaysMinutes.length >= 10 || (settings.delaysMinutes.at(-1) ?? 0) >= 43_200}
              onClick={() => {
                setSettings((current) => ({
                  ...current,
                  delaysMinutes: [...current.delaysMinutes, Math.min(43_200, (current.delaysMinutes.at(-1) ?? 0) + 1440)],
                  delivery: [...normalizeFollowUpDelivery(current.delaysMinutes, current.delivery), { type: "text" }]
                }));
                setSaved(false);
              }}
            >
              <Plus size={15} aria-hidden="true" />Adicionar
            </button>
          </div>
          {settings.delaysMinutes.map((delay, index) => {
            const delivery = settings.delivery[index] ?? { type: "text" as const };
            const selectedImage = delivery.type === "image" ? media.find((item) => item.id === delivery.assetId) : undefined;
            const selectedSticker = delivery.type === "sticker" ? stickers.find((item) => item.id === delivery.assetId) : undefined;
            const selectedAudio = delivery.type === "audio" ? media.find((item) => item.id === delivery.assetId) : undefined;
            const selectedVideo = delivery.type === "video" ? media.find((item) => item.id === delivery.assetId) : undefined;
            return (
              <div key={index} className="grid gap-4 rounded border border-[var(--border)] p-4">
                <div className="grid items-center gap-3 sm:grid-cols-[92px_minmax(0,1fr)_minmax(130px,auto)_40px]">
                  <strong className="text-xs text-[var(--heading)]">{index + 1}ª tentativa</strong>
                  <input
                    className="input"
                    type="number"
                    min={index === 0 ? 1 : settings.delaysMinutes[index - 1]! + 1}
                    max={index === settings.delaysMinutes.length - 1 ? 43_200 : settings.delaysMinutes[index + 1]! - 1}
                    required
                    aria-label={`Atraso cumulativo da tentativa ${index + 1}, em minutos`}
                    value={delay}
                    onChange={(event) => {
                      const delaysMinutes = [...settings.delaysMinutes];
                      delaysMinutes[index] = Number(event.target.value);
                      setSettings((current) => ({ ...current, delaysMinutes }));
                      setSaved(false);
                    }}
                  />
                  <span className="sub text-xs">{formatFollowUpDelay(delay)} após a origem</span>
                  <button
                    type="button"
                    className="btn h-10 px-2"
                    aria-label={`Remover tentativa ${index + 1}`}
                    disabled={settings.delaysMinutes.length === 1}
                    onClick={() => {
                      setSettings((current) => ({
                        ...current,
                        delaysMinutes: current.delaysMinutes.filter((_, delayIndex) => delayIndex !== index),
                        delivery: normalizeFollowUpDelivery(current.delaysMinutes, current.delivery)
                          .filter((_, deliveryIndex) => deliveryIndex !== index)
                      }));
                      setSaved(false);
                    }}
                  >
                    <Trash size={15} aria-hidden="true" />
                  </button>
                </div>

                <div className="grid gap-3 border-t border-[var(--border)] pt-4 sm:grid-cols-[minmax(150px,.65fr)_minmax(0,1fr)]">
                  <label className="field">
                    <span>Formato do envio</span>
                    <select
                      className="input"
                      value={delivery.type}
                      onChange={(event) => {
                        const type = event.target.value;
                        if (type === "image" && media.find((item) => item.mime_type.startsWith("image/"))) changeDelivery(index, { type, assetId: media.find((item) => item.mime_type.startsWith("image/"))!.id });
                        else if (type === "audio" && media.find((item) => item.mime_type.startsWith("audio/"))) changeDelivery(index, { type, assetId: media.find((item) => item.mime_type.startsWith("audio/"))!.id });
                        else if (type === "video" && media.find((item) => item.mime_type === "video/mp4")) changeDelivery(index, { type, assetId: media.find((item) => item.mime_type === "video/mp4")!.id });
                        else if (type === "sticker" && stickers[0]) changeDelivery(index, { type, assetId: stickers[0].id });
                        else changeDelivery(index, { type: "text" });
                      }}
                    >
                      <option value="text">Somente texto</option>
                      <option value="image" disabled={!media.some((item) => item.mime_type.startsWith("image/"))}>Imagem + texto</option>
                      <option value="audio" disabled={!media.some((item) => item.mime_type.startsWith("audio/"))}>Áudio (nota de voz, sem legenda)</option>
                      <option value="video" disabled={!media.some((item) => item.mime_type === "video/mp4")}>Vídeo + texto</option>
                      <option value="sticker" disabled={!stickers.length}>Figurinha sem texto</option>
                    </select>
                  </label>

                  {delivery.type === "image" ? (
                    <label className="field">
                      <span>Imagem do case</span>
                      <select className="input" value={delivery.assetId} onChange={(event) => changeDelivery(index, { type: "image", assetId: event.target.value })}>
                        {media.filter((item) => item.mime_type.startsWith("image/")).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                    </label>
                  ) : delivery.type === "audio" || delivery.type === "video" ? (
                    <label className="field"><span>{delivery.type === "audio" ? "Áudio para enviar" : "Vídeo para enviar"}</span><select className="input" value={delivery.assetId} onChange={(event) => changeDelivery(index, { type: delivery.type, assetId: event.target.value })}>{media.filter((item) => delivery.type === "audio" ? item.mime_type.startsWith("audio/") : item.mime_type === "video/mp4").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
                  ) : delivery.type === "sticker" ? (
                    <label className="field">
                      <span>Figurinha para descontrair</span>
                      <select className="input" value={delivery.assetId} onChange={(event) => changeDelivery(index, { type: "sticker", assetId: event.target.value })}>
                        {stickers.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                      </select>
                    </label>
                  ) : (
                    <div className="flex items-end pb-2">
                      <p className="sub text-xs">A IA escreve uma retomada curta de acordo com o contexto.</p>
                    </div>
                  )}
                </div>

                {selectedImage ? (
                  <div className="grid grid-cols-[72px_1fr] items-center gap-3 rounded bg-[var(--active)] p-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={apiContentUrl(`/ai-follow-ups/media/${selectedImage.id}/content`)} alt={selectedImage.name} className="h-16 w-18 rounded object-cover" />
                    <div><strong className="text-sm text-[var(--heading)]">{selectedImage.name}</strong><p className="sub mt-1 text-xs">{selectedImage.description}</p></div>
                  </div>
                ) : selectedSticker ? (
                  <div className="grid grid-cols-[72px_1fr] items-center gap-3 rounded bg-[var(--active)] p-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={apiContentUrl(`/ai-stickers/${selectedSticker.id}/content`)} alt={selectedSticker.name} className="h-16 w-18 object-contain" />
                    <div><strong className="text-sm text-[var(--heading)]">{selectedSticker.name}</strong><p className="sub mt-1 text-xs">Será enviada sozinha, sem texto adicional.</p></div>
                  </div>
                ) : selectedAudio ? (<div className="rounded bg-[var(--active)] p-3"><audio controls className="w-full" src={apiContentUrl(`/ai-follow-ups/media/${selectedAudio.id}/content`)} /><p className="sub mt-1 text-xs">Nota de voz, sem legenda.</p></div>)
                : selectedVideo ? (<div className="rounded bg-[var(--active)] p-3"><video controls className="w-full" src={apiContentUrl(`/ai-follow-ups/media/${selectedVideo.id}/content`)} /><p className="sub mt-1 text-xs">O texto da IA será enviado como legenda.</p></div>) : null}
              </div>
            );
          })}
        </div>

        <div className="mt-7 flex items-center justify-between gap-4 border-t border-[var(--border)] pt-5">
          <span className="sub text-xs">Alterações também atualizam sequências que ainda estão aguardando.</span>
          <button className="btn primary active:scale-[0.98]" disabled={saving}>
            <FloppyDisk aria-hidden="true" />
            {saving ? "Salvando…" : "Salvar cadência"}
          </button>
        </div>
      </form>

      <aside className="border-t border-[var(--border)] pt-5 md:border-l md:border-t-0 md:pl-6 md:pt-1" aria-label="Como funcionam os follow-ups">
        <form className="grid gap-3 border-b border-[var(--border)] pb-6" onSubmit={uploadImage}>
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold text-[var(--heading)]"><ImageSquare size={17} aria-hidden="true" />Mídias de cases</h2>
            <p className="sub mt-1 text-xs leading-relaxed">Adicione imagens, áudio OGG/MP3 ou vídeo MP4. Áudio é enviado como nota de voz sem legenda; vídeo recebe a legenda da IA.</p>
          </div>
          <label className="field">
            <span>Arquivo</span>
            <input
              className="input file:mr-3 file:border-0 file:bg-transparent file:text-xs file:font-semibold"
              type="file"
              accept="image/jpeg,image/png,image/webp,audio/ogg,audio/mpeg,video/mp4,.jpg,.jpeg,.png,.webp,.ogg,.mp3,.mp4"
              onChange={(event) => {
                const next = event.target.files?.[0];
                setUploadFile(next);
                if (next && !uploadName) setUploadName(next.name.replace(/\.[^.]+$/, ""));
              }}
            />
          </label>
          <label className="field">
            <span>Nome para seleção</span>
            <input className="input" value={uploadName} maxLength={100} onChange={(event) => setUploadName(event.target.value)} placeholder="Case Newave — 14 dias" />
          </label>
          <label className="field">
            <span>Contexto para a legenda</span>
            <textarea className="input min-h-24 resize-y" value={uploadDescription} maxLength={500} onChange={(event) => setUploadDescription(event.target.value)} placeholder="Resultados de vendas do novo cliente Newave nos primeiros 14 dias." />
            <small className="sub">A IA usa somente estes fatos para apresentar o case, sem inventar resultados.</small>
          </label>
          <button className="btn active:scale-[0.98]" disabled={!uploadFile || !uploadName.trim() || !uploadDescription.trim() || uploading}>
            <UploadSimple size={16} aria-hidden="true" />
            {uploading ? "Adicionando…" : "Adicionar mídia"}
          </button>
          <div className="flex items-start gap-2 text-xs text-[var(--muted)]">
            <Sticker className="mt-0.5 shrink-0" size={15} aria-hidden="true" />
            <p>As figurinhas vêm da biblioteca logo abaixo nesta página e sempre são enviadas sem texto.</p>
          </div>
        </form>

        <h2 className="mt-6 text-sm font-semibold text-[var(--heading)]">Como a sequência decide</h2>
        <div className="mt-5 grid gap-5">
          <FollowUpRule Icon={ClockCountdown} title="Segue a linha do tempo" description="Cada tentativa usa seu atraso cumulativo desde a resposta original da IA: por exemplo, 2h, 24h e 72h." />
          <FollowUpRule Icon={ChatCircleDots} title="Avalia a necessidade" description="A IA só retoma perguntas cuja resposta bloqueia o agendamento ou o fechamento pelo SDR ou especialista, como a confirmação de um horário oferecido." />
          <FollowUpRule Icon={Prohibit} title="Evita insistência desnecessária" description="Dados opcionais, perguntas recusadas e conversas já agendadas ou entregues ao humano encerram a sequência sem nova mensagem." />
          <FollowUpRule Icon={Prohibit} title="Para ao receber resposta" description="Uma nova mensagem do contato cancela todos os próximos envios daquela sequência." />
        </div>
      </aside>
    </div>
  );
}

function FollowUpRule({ Icon, title, description }: { Icon: typeof ClockCountdown; title: string; description: string }) {
  return <div className="grid grid-cols-[32px_1fr] gap-3"><div className="grid h-8 w-8 place-items-center rounded-full border border-[var(--border)] text-[var(--accent-soft)]"><Icon size={16} aria-hidden="true" /></div><div><strong className="block text-sm text-[var(--heading)]">{title}</strong><p className="sub mt-1 text-xs leading-relaxed">{description}</p></div></div>;
}

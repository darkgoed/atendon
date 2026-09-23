"use client";

import { type ChangeEvent, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { FloppyDisk, Sticker, Trash } from "@phosphor-icons/react";
import { IconButton, SaveButton, SaveToast, useSaveFeedback } from "@/components/ui";
import { api } from "@/lib/api";
import type { PanelSession } from "@/lib/session";

type WorkspaceLogoResponse = { workspace: { id: string; name: string; logo_data: string | null } };

// Limite original de 5MB antes de qualquer processamento (R4).
const LOGO_MAX_SOURCE_BYTES = 5 * 1024 * 1024;
// Lado maior máximo após o redimensionamento.
const LOGO_MAX_EDGE = 256;
// Teto do data URL final (~100KB em chars; o backend aceita 150.000 chars como
// defesa, mas o cliente comprime para bem menos).
const LOGO_MAX_DATA_URL_CHARS = 100_000;
// Decisão de redimensionamento (documentada, conforme a SPEC): a imagem é
// escalada — nunca ampliada — para caber em até 256px no lado maior e desenhada
// preenchendo o canvas inteiro, sem crop central (preserva a composição inteira
// da logo, que normalmente é pequena). A saída é PNG para manter transparência;
// se o PNG exceder ~100KB, re-renderiza sobre fundo branco em JPEG 0.9 e usa o
// menor dos dois. GIF/BMP não passam no accept nem na checagem de tipo.
export async function resizeWorkspaceLogo(dataUrl: string): Promise<string> {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Não foi possível ler a imagem."));
    img.src = dataUrl;
  });
  const scale = Math.min(1, LOGO_MAX_EDGE / Math.max(image.width, image.height));
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Não foi possível processar a imagem neste navegador.");
  ctx.drawImage(image, 0, 0, width, height);
  const png = canvas.toDataURL("image/png");
  if (png.length <= LOGO_MAX_DATA_URL_CHARS) return png;
  const jpegCanvas = document.createElement("canvas");
  jpegCanvas.width = width;
  jpegCanvas.height = height;
  const jpegCtx = jpegCanvas.getContext("2d");
  if (!jpegCtx) return png;
  jpegCtx.fillStyle = "#ffffff";
  jpegCtx.fillRect(0, 0, width, height);
  jpegCtx.drawImage(image, 0, 0, width, height);
  const jpeg = jpegCanvas.toDataURL("image/jpeg", 0.9);
  return jpeg.length < png.length ? jpeg : png;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Não foi possível ler o arquivo."));
    reader.readAsDataURL(file);
  });
}

// R4 — Upload/remoção da logo do tenant. Salvar/Remover revalidam o cache
// global "/me" (useSWRConfig().mutate) para o Shell refletir a logo sem reload.
export function WorkspaceLogoSection({ canManage }: { canManage: boolean }) {
  const { data: session } = useSWR<PanelSession>("/me", (url: string) => api<PanelSession>(url), {
    revalidateOnFocus: false,
    dedupingInterval: 10_000
  });
  const { mutate: mutateKey } = useSWRConfig();
  const currentLogo = session?.activeWorkspace?.logo_data ?? null;
  const [previewLogo, setPreviewLogo] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [logoError, setLogoError] = useState("");
  const [savedMessage, setSavedMessage] = useState("");
  const save = useSaveFeedback();

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.target.value = "";
    setPreviewLogo("");
    setLogoError("");
    setSavedMessage("");
    if (!file) return;
    // Validações ANTES do canvas (R4): não-imagem e >5MB falham aqui.
    if (!file.type.startsWith("image/")) {
      setLogoError("Selecione um arquivo de imagem (PNG, JPEG ou WEBP).");
      return;
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setLogoError("Formato não suportado. Use PNG, JPEG ou WEBP.");
      return;
    }
    if (file.size > LOGO_MAX_SOURCE_BYTES) {
      setLogoError("A imagem deve ter no máximo 5MB.");
      return;
    }
    try {
      setPreviewLogo(await resizeWorkspaceLogo(await readAsDataUrl(file)));
    } catch {
      setLogoError("Não foi possível processar a imagem.");
    }
  }

  async function saveLogo() {
    if (!previewLogo || saving) return;
    setSaving(true);
    setLogoError("");
    setSavedMessage("");
    try {
      await api<WorkspaceLogoResponse>("/workspaces/current/logo", {
        method: "PATCH",
        body: JSON.stringify({ logo_data: previewLogo })
      });
      await mutateKey("/me");
      setPreviewLogo("");
      setSavedMessage("Logo salva.");
      save.markDone();
    } catch (saveError) {
      setLogoError(saveError instanceof Error ? saveError.message : "Não foi possível salvar a logo.");
    } finally {
      setSaving(false);
    }
  }

  async function removeLogo() {
    if (removing) return;
    // Prévia ainda não salva: só descarta o rascunho local.
    if (previewLogo && !currentLogo) {
      setPreviewLogo("");
      setSavedMessage("");
      return;
    }
    setRemoving(true);
    setLogoError("");
    setSavedMessage("");
    try {
      await api<WorkspaceLogoResponse>("/workspaces/current/logo", {
        method: "DELETE"
      });
      await mutateKey("/me");
      setPreviewLogo("");
      setSavedMessage("Logo removida.");
    } catch (removeError) {
      setLogoError(removeError instanceof Error ? removeError.message : "Não foi possível remover a logo.");
    } finally {
      setRemoving(false);
    }
  }

  const shownLogo = previewLogo || currentLogo;
  return (
    <section className="max-w-2xl border-t border-[var(--border)] pt-6" aria-label="Logo da empresa">
      <div className="grid gap-5 sm:grid-cols-[40px_minmax(0,1fr)]">
        <span className="grid h-10 w-10 place-items-center rounded-full border border-[var(--border)] text-[var(--primary-text)]">
          <Sticker size={19} aria-hidden="true" />
        </span>
        <div className="grid gap-4">
          <div>
            <h2 className="m-0 text-base font-semibold text-[var(--text)]">Logo da empresa</h2>
            <p className="sub mt-1">Aparece no seletor de empresas do sidebar, no lugar da inicial.</p>
          </div>
          {logoError ? <p className="error" role="alert">{logoError}</p> : null}
          {savedMessage ? <p className="text-sm text-[var(--primary-text)]" role="status">{savedMessage}</p> : null}
          <SaveToast show={save.done}>Logo salva</SaveToast>
          <div className="flex items-start gap-4">
            {shownLogo ? (
              previewLogo ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={previewLogo} alt="Prévia da nova logo" className="h-16 w-16 rounded-full border border-[var(--border)] object-cover" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={currentLogo ?? ""} alt="Logo atual" className="h-16 w-16 rounded-full border border-[var(--border)] object-cover" />
              )
            ) : (
              <span className="grid h-16 w-16 place-items-center rounded-full border border-dashed border-[var(--border)] text-xs text-[var(--text-muted)]">—</span>
            )}
            {canManage ? (
              <div className="grid gap-3">
                <label className="field">
                  <span className="label">Nova logo</span>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    aria-label="Escolher imagem da logo"
                    disabled={saving || removing}
                    onChange={(event) => void handleFile(event)}
                  />
                  <small className="sub">PNG, JPEG ou WEBP até 5MB. Redimensionamos para até 256px.</small>
                </label>
                <div className="flex gap-2">
                  <SaveButton
                    type="button"
                    state={saving ? "busy" : save.state}
                    aria-label="Salvar logo"
                    icon={<FloppyDisk size={16} aria-hidden="true" />}
                    disabled={!previewLogo || saving || removing}
                    onClick={() => void saveLogo()}
                  >
                    Salvar
                  </SaveButton>
                  {shownLogo ? (
                    <IconButton
                      type="button"
                      label="Remover logo"
                      className="warn"
                      disabled={saving || removing}
                      onClick={() => void removeLogo()}
                    >
                      <Trash size={16} aria-hidden="true" />
                    </IconButton>
                  ) : null}
                </div>
              </div>
            ) : (
              <span className="sub">{shownLogo ? undefined : "Nenhuma logo definida."}</span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

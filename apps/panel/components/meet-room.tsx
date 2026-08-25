"use client";

import { ArrowClockwise, ArrowLeft, ShieldCheck, VideoCamera } from "@phosphor-icons/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BrandMark } from "@/components/brand-mark";
import { api } from "@/lib/api";
import { apiContentUrl, normalizeMeetOrigin, type MeetAccessResponse } from "@/lib/meet";

type JitsiExternalApi = {
  addListener(event: string, listener: (payload?: unknown) => void): void;
  dispose(): void;
};

type JitsiExternalApiConstructor = new (domain: string, options: {
  roomName: string;
  jwt: string;
  parentNode: HTMLElement;
  width: string;
  height: string;
  configOverwrite: Record<string, unknown>;
  interfaceConfigOverwrite: Record<string, unknown>;
}) => JitsiExternalApi;

declare global {
  interface Window {
    JitsiMeetExternalAPI?: JitsiExternalApiConstructor;
  }
}

const scriptRequests = new Map<string, Promise<JitsiExternalApiConstructor>>();

function loadJitsiApi(origin: string) {
  if (window.JitsiMeetExternalAPI) return Promise.resolve(window.JitsiMeetExternalAPI);
  const currentRequest = scriptRequests.get(origin);
  if (currentRequest) return currentRequest;

  const request = new Promise<JitsiExternalApiConstructor>((resolve, reject) => {
    const source = `${origin}/external_api.js`;
    let script = document.querySelector<HTMLScriptElement>(`script[data-atendon-meet-source="${source}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = source;
      script.async = true;
      script.dataset.atendonMeetSource = source;
      document.head.appendChild(script);
    }

    const finish = () => {
      cleanup();
      if (window.JitsiMeetExternalAPI) resolve(window.JitsiMeetExternalAPI);
      else reject(new Error("O servidor de reunião respondeu sem a API esperada."));
    };
    const fail = () => {
      cleanup();
      script?.remove();
      reject(new Error("Não foi possível carregar a sala de reunião."));
    };
    const timeout = window.setTimeout(fail, 20_000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      script?.removeEventListener("load", finish);
      script?.removeEventListener("error", fail);
    };
    script.addEventListener("load", finish, { once: true });
    script.addEventListener("error", fail, { once: true });
  }).catch((error) => {
    scriptRequests.delete(origin);
    throw error;
  });
  scriptRequests.set(origin, request);
  return request;
}

async function publicMeetAccess(endpoint: string) {
  const response = await fetch(apiContentUrl(endpoint), {
    credentials: "include",
    headers: { Accept: "application/json" }
  });
  const body = await response.json().catch(() => null) as MeetAccessResponse | { error?: string } | null;
  if (!response.ok) {
    throw new Error(body && "error" in body && body.error ? body.error : "Esta sala não está disponível.");
  }
  return body as MeetAccessResponse;
}

export function MeetRoom({ endpoint, publicAccess = false }: { endpoint: string; publicAccess?: boolean }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<JitsiExternalApi | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<"loading" | "ready" | "ended" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    let instance: JitsiExternalApi | null = null;
    const parentNode = parentRef.current;
    setPhase("loading");
    setError("");

    async function connect() {
      try {
        const access = publicAccess
          ? await publicMeetAccess(endpoint)
          : await api<MeetAccessResponse>(endpoint);
        if (!access.token || !access.room_name || !access.domain) {
          throw new Error("O servidor retornou dados incompletos para esta sala.");
        }
        const origin = normalizeMeetOrigin(access.domain);
        const Constructor = await loadJitsiApi(origin);
        if (!active || !parentNode) return;

        instance = new Constructor(new URL(origin).host, {
          roomName: access.room_name,
          jwt: access.token,
          parentNode,
          width: "100%",
          height: "100%",
          configOverwrite: {
            disableDeepLinking: true,
            enableClosePage: false,
            prejoinConfig: { enabled: true },
            startWithAudioMuted: true,
            startWithVideoMuted: true
          },
          interfaceConfigOverwrite: {
            APP_NAME: "AtendON Meet",
            DEFAULT_BACKGROUND: "#0E1315",
            DISABLE_JOIN_LEAVE_NOTIFICATIONS: false,
            JITSI_WATERMARK_LINK: "",
            MOBILE_APP_PROMO: false,
            NATIVE_APP_NAME: "AtendON Meet",
            PROVIDER_NAME: "AtendON",
            SHOW_BRAND_WATERMARK: false,
            SHOW_JITSI_WATERMARK: false,
            SHOW_POWERED_BY: false,
            SHOW_WATERMARK_FOR_GUESTS: false
          }
        });
        apiRef.current = instance;
        instance.addListener("videoConferenceJoined", () => { if (active) setPhase("ready"); });
        instance.addListener("readyToClose", () => { if (active) setPhase("ended"); });
        instance.addListener("errorOccurred", (payload) => {
          if (!active) return;
          const detail = payload && typeof payload === "object" && "message" in payload
            ? String((payload as { message?: unknown }).message ?? "")
            : "";
          setError(detail || "A conexão com a reunião foi interrompida.");
          setPhase("error");
        });
        setPhase("ready");
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Não foi possível abrir a reunião.");
        setPhase("error");
      }
    }

    void connect();
    return () => {
      active = false;
      instance?.dispose();
      if (apiRef.current === instance) apiRef.current = null;
      parentNode?.replaceChildren();
    };
  }, [attempt, endpoint, publicAccess]);

  function retry() {
    apiRef.current?.dispose();
    apiRef.current = null;
    parentRef.current?.replaceChildren();
    setAttempt((current) => current + 1);
  }

  return (
    <main className="grid min-h-[100dvh] grid-rows-[52px_minmax(0,1fr)] overflow-hidden bg-[#0E1315] text-[#F2F3F1]">
      <header className="flex min-w-0 items-center justify-between gap-4 border-b border-white/10 bg-[#171B1D] px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <BrandMark className="size-7 shrink-0" />
          <div className="min-w-0">
            <strong className="block truncate text-sm">AtendON Meet</strong>
            <span className="flex items-center gap-1.5 text-[10px] text-[#A7ABA6]"><ShieldCheck size={12} aria-hidden="true" /> Sala protegida</span>
          </div>
        </div>
        {!publicAccess ? <Link href="/agenda" className="btn border-white/10 bg-transparent text-[#C7CAC6] active:translate-y-px"><ArrowLeft size={15} aria-hidden="true" />Voltar à agenda</Link> : null}
      </header>

      <section className="relative min-h-0 bg-[#0E1315]" aria-label="Sala de videochamada">
        <div ref={parentRef} className="absolute inset-0 [&>iframe]:block [&>iframe]:h-full [&>iframe]:w-full [&>iframe]:border-0" />
        {phase === "loading" ? (
          <div className="absolute inset-0 grid place-items-center bg-[#0E1315] p-6" role="status" aria-live="polite">
            <div className="grid w-full max-w-sm gap-5 border-y border-white/10 py-7 text-left">
              <span className="grid size-11 place-items-center rounded-full border border-cyan-300/25 text-cyan-300"><VideoCamera size={21} aria-hidden="true" /></span>
              <div><strong className="block text-lg">Preparando sua sala</strong><p className="mt-1 text-sm text-[#A7ABA6]">Validando o acesso e conectando áudio e vídeo.</p></div>
              <span className="skeleton h-1.5 w-full" aria-hidden="true" />
            </div>
          </div>
        ) : null}
        {phase === "error" || phase === "ended" ? (
          <div className="absolute inset-0 grid place-items-center bg-[#0E1315]/95 p-6" role={phase === "error" ? "alert" : "status"}>
            <div className="grid w-full max-w-md justify-items-start gap-4 border-y border-white/10 py-8">
              <span className="label">{phase === "error" ? "Falha na conexão" : "Reunião encerrada"}</span>
              <h1 className="m-0 text-2xl tracking-tight">{phase === "error" ? "Não foi possível entrar na sala" : "A chamada foi finalizada"}</h1>
              <p className="m-0 text-sm leading-relaxed text-[#A7ABA6]">{phase === "error" ? error : "Você já pode fechar esta página ou entrar novamente."}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn primary active:scale-[.98]" onClick={retry}><ArrowClockwise size={16} aria-hidden="true" />{phase === "error" ? "Tentar novamente" : "Entrar novamente"}</button>
                {!publicAccess ? <Link href="/agenda" className="btn active:translate-y-px">Voltar à agenda</Link> : null}
              </div>
            </div>
          </div>
        ) : null}
      </section>
    </main>
  );
}

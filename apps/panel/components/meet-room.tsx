"use client";

import { ArrowClockwise, ArrowLeft, ShieldCheck, VideoCamera } from "@/components/icons";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BrandMark } from "@/components/brand-mark";
import { api } from "@/lib/api";
import { apiContentUrl, normalizeMeetOrigin, type MeetAccessResponse } from "@/lib/meet";
import { clearElement } from "@/lib/compat";
import { Tooltip } from "@/components/ui";

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
        const background = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();

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
            DEFAULT_BACKGROUND: background,
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
      clearElement(parentNode);
    };
  }, [attempt, endpoint, publicAccess]);

  function retry() {
    apiRef.current?.dispose();
    apiRef.current = null;
    clearElement(parentRef.current);
    setAttempt((current) => current + 1);
  }

  return (
    <main className="meet-room">
      <header className="meet-room__header">
        <div className="flex min-w-0 items-center gap-3">
          <BrandMark className="size-7 shrink-0" />
          <div className="min-w-0">
            <strong className="block truncate text-sm">AtendON Meet</strong>
            <span className="meet-room__status"><ShieldCheck size={12} aria-hidden="true" /> Sala protegida</span>
          </div>
        </div>
        {!publicAccess ? <Tooltip content="Voltar à agenda"><Link href="/agenda" className="btn icon-button meet-room__back"><ArrowLeft size={15} aria-hidden="true" /><span className="sr-only">Voltar à agenda</span></Link></Tooltip> : null}
      </header>

      <section className="meet-room__stage" aria-label="Sala de videochamada">
        <div ref={parentRef} className="meet-room__frame" />
        {phase === "ready" ? <h1 className="sr-only">Sala de videochamada</h1> : null}
        {phase === "loading" ? (
          <div className="meet-room__overlay" role="status" aria-live="polite">
            <div className="meet-room__message">
              <span className="meet-room__icon"><VideoCamera size={21} aria-hidden="true" /></span>
              <div><strong>Preparando sua sala</strong><p>Validando o acesso e conectando áudio e vídeo.</p></div>
              <span className="skeleton meet-room__progress" aria-hidden="true" />
            </div>
          </div>
        ) : null}
        {phase === "error" || phase === "ended" ? (
          <div className="meet-room__overlay meet-room__overlay--ended" role={phase === "error" ? "alert" : "status"}>
            <div className="meet-room__message meet-room__message--error">
              <span className="label">{phase === "error" ? "Falha na conexão" : "Reunião encerrada"}</span>
              <h1 className="m-0 text-xl tracking-tight">{phase === "error" ? "Não foi possível entrar na sala" : "A chamada foi finalizada"}</h1>
              <p>{phase === "error" ? error : "Você já pode fechar esta página ou entrar novamente."}</p>
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

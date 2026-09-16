import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "AtendON",
    short_name: "AtendON",
    description: "Painel seguro de atendimento e operação comercial",
    start_url: "/",
    scope: "/",
    display: "standalone",
    // O SO lê estes valores e não aceita var(): mantenha em sincronia manual
    // com --bg do tema DARK (padrão do produto) em styles/tokens.css.
    background_color: "#0F1115",
    theme_color: "#0F1115",
    orientation: "any",
    lang: "pt-BR",
    categories: ["business", "productivity"],
    icons: [
      { src: "/icon.png", sizes: "1024x1024", type: "image/png", purpose: "any" },
      { src: "/icon.png", sizes: "1024x1024", type: "image/png", purpose: "maskable" }
    ]
  };
}

import type { MediaType } from "./types.js";
import { DEFAULT_MEDIA_FALLBACK } from "../ai-router/defaults.js";

export function mediaFallback(mediaType: MediaType): string {
  if (mediaType === "video") {
    return "Recebi seu vídeo, mas ainda não consigo analisá-lo. Pode descrever em texto?";
  }
  return DEFAULT_MEDIA_FALLBACK[mediaType];
}

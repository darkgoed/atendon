// Preferências por usuário: aparência (R16, rota nova deste módulo) e os
// handlers que o patch do orquestrador instala em app.ts para estender
// GET/PATCH /me/notification-preferences com sound_key/volume (lógica em
// service.ts). app.ts NÃO é editado por este worker.
import type { FastifyInstance } from "fastify";
import { requireSession } from "../../auth/session.js";
import {
  appearancePreferencesPatchSchema,
  loadAppearancePreferences,
  loadPanelNotificationPreferences,
  notificationPreferencesPatchSchema,
  updateAppearancePreferences,
  updatePanelNotificationPreferences
} from "./service.js";

export async function registerInternalPreferenceRoutes(app: FastifyInstance) {
  app.get("/me/appearance-preferences", async (request) => {
    return loadAppearancePreferences(await requireSession(request));
  });
  app.patch("/me/appearance-preferences", async (request) => {
    const session = await requireSession(request);
    return updateAppearancePreferences(session, appearancePreferencesPatchSchema.parse(request.body));
  });
}

// Exatamente os handlers que o patch do orquestrador instala em app.ts —
// exportados para os testes de integração refletirem o patch sem tocar app.ts.
export function registerPanelNotificationPreferenceHandlers(app: FastifyInstance) {
  app.get("/me/notification-preferences", async (request) => {
    return loadPanelNotificationPreferences(await requireSession(request));
  });
  app.patch("/me/notification-preferences", async (request) => {
    const session = await requireSession(request);
    const body = notificationPreferencesPatchSchema.parse(request.body);
    return updatePanelNotificationPreferences(session, body);
  });
}
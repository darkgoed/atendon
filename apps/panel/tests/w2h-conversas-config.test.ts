import { describe, expect, it, vi } from "vitest";

const { apiMock } = vi.hoisted(() => ({ apiMock: vi.fn().mockResolvedValue({}) }));
vi.mock("../lib/api", () => ({ api: apiMock }));

import { markConversationRead, reactToMessage, setConversationNotificationMute } from "../lib/conversations-api";

describe("w2h conversations/config contracts", () => {
  it("uses conversation API operations for mutations", async () => {
    await markConversationRead("c1");
    await reactToMessage("c1", "m1", "👍");
    expect(apiMock).toHaveBeenCalledWith("/conversations/c1/read", { method: "PATCH" });
    expect(apiMock).toHaveBeenCalledWith("/conversations/c1/messages/m1/react", expect.objectContaining({ method: "POST" }));
  });

  it("keeps mute changes scoped to the conversation", async () => {
    await setConversationNotificationMute("c2", true);
    expect(apiMock).toHaveBeenCalledWith("/conversations/c2/notification-mute", expect.objectContaining({ method: "PATCH" }));
  });
});

FROM node:24-alpine AS baileys-deps

WORKDIR /opt/baileys
RUN npm init -y \
    && npm install --omit=dev --ignore-scripts \
      baileys@7.0.0-rc13 \
      libsignal@6.0.0 \
      whatsapp-rust-bridge@0.5.4

FROM evoapicloud/evolution-api:v2.3.7

# Baileys rc.9 can receive WhatsApp error 463 on new 1:1 conversations
# because the privacy token (tctoken) is not issued before the first reply.
# rc.13 adds the token lifecycle while keeping the Evolution 2.3.7 HTTP
# contract unchanged.
COPY --from=baileys-deps /opt/baileys/node_modules/baileys /evolution/node_modules/baileys
COPY --from=baileys-deps /opt/baileys/node_modules/libsignal /evolution/node_modules/libsignal
COPY --from=baileys-deps /opt/baileys/node_modules/whatsapp-rust-bridge /evolution/node_modules/whatsapp-rust-bridge

RUN node -e "const version=require('baileys/package.json').version;if(version!=='7.0.0-rc13')process.exit(1)" \
    && node -e "import('baileys').then(module=>{if(typeof module.makeWASocket!=='function')process.exit(1)})"

# messages.upsert awaits profilePictureUrl inline and the Baileys event loop is
# serial. With rc.13, 1:1 chats use LID addressing and the profile-picture IQ
# for @lid JIDs never gets an answer, so every inbound message stalled the
# pipeline for defaultQueryTimeoutMs (60s), delaying the next message's webhook
# by exactly 60s. Skip the query for @lid and cap the rest at 3s.
RUN node -e ' \
  const fs = require("fs"); \
  const file = "/evolution/dist/main.js"; \
  const source = fs.readFileSync(file, "utf8"); \
  const before = "let o=await this.client.profilePictureUrl(t,\"image\")"; \
  const after = "let o=t.endsWith(\"@lid\")?null:await this.client.profilePictureUrl(t,\"image\",3e3)"; \
  if (source.split(before).length !== 2) { console.error("profilePicture patch target not found or ambiguous"); process.exit(1); } \
  fs.writeFileSync(file, source.replace(before, after)); \
  console.log("patched profilePictureUrl timeout in dist/main.js");'

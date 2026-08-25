import { config } from "./config.js";
import { buildApp } from "./app.js";

const app = buildApp();
await app.listen({ port: config.PORT, host: config.HOST });

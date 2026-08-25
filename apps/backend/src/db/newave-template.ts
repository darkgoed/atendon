import { readFile } from "node:fs/promises";

export async function loadNewavePromptTemplate(): Promise<string> {
  return readFile(new URL("../../../../instrução-newave-ia.md", import.meta.url), "utf8");
}

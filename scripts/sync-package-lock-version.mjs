import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function syncPackageLockVersion(rootDirectory) {
  const packageFile = join(rootDirectory, "package.json");
  const lockFile = join(rootDirectory, "package-lock.json");
  const [packageJson, packageLock] = await Promise.all([
    readFile(packageFile, "utf8").then(JSON.parse),
    readFile(lockFile, "utf8").then(JSON.parse)
  ]);

  if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
    throw new Error("package.json não contém uma versão válida");
  }
  if (!packageLock.packages || !packageLock.packages[""]) {
    throw new Error("package-lock.json não contém o pacote raiz");
  }

  packageLock.version = packageJson.version;
  packageLock.packages[""].version = packageJson.version;
  const temporaryFile = `${lockFile}.tmp-${process.pid}`;
  await writeFile(temporaryFile, `${JSON.stringify(packageLock, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  await rename(temporaryFile, lockFile);
  return packageJson.version;
}

const invokedFile = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedFile === resolve(fileURLToPath(import.meta.url))) {
  const rootDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
  const version = await syncPackageLockVersion(rootDirectory);
  console.log(`package-lock.json sincronizado com ${version}`);
}

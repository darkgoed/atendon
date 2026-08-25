import { databaseTarget, resolveTestDatabaseUrl } from "./test-database.js";
import { loadTestEnvironment } from "./test-environment.js";

loadTestEnvironment();

const testDatabaseUrl = resolveTestDatabaseUrl(process.env);
console.log(`Banco de testes validado: ${databaseTarget(testDatabaseUrl)}`);

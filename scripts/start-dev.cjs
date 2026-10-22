const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const net = require("node:net");

const root = path.resolve(__dirname, "..");
const apiDir = path.join(root, "api");
const webDir = path.join(root, "web");
const isWin = process.platform === "win32";
const npm = isWin ? "npm.cmd" : "npm";
let children = [];
let shuttingDown = false;

function fail(message) {
  console.error(`\nERROR: ${message}`);
  process.exitCode = 1;
}
function run(command, args, cwd, quiet = false) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: quiet ? ["ignore", "ignore", "ignore"] : "inherit",
      shell: isWin,
      windowsHide: false,
    });
    child.once("error", (error) => resolve({ code: 1, error }));
    child.once("exit", (code) => resolve({ code: code ?? 1 }));
  });
}
function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
function startNpm(label, args, cwd) {
  console.log(`\n[${label}] starting...`);
  const child = spawn(npm, args, { cwd, stdio: "inherit", shell: isWin, windowsHide: false });
  children.push(child);
  child.once("error", (error) => {
    console.error(`[${label}] failed to launch: ${error.message}`);
    shutdown(1);
  });
  child.once("exit", (code) => {
    if (!shuttingDown) {
      console.error(`[${label}] exited with code ${code ?? 1}.`);
      shutdown(code && code !== 0 ? code : 1);
    }
  });
  return child;
}
function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      if (isWin && child.pid) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      else child.kill();
    } catch {}
  }
  process.exitCode = code;
  setTimeout(() => process.exit(code), 800).unref();
}

(async () => {
  if (!fs.existsSync(path.join(root, "api", ".env"))) {
    fail("api/.env is missing. Double-click setup-local.bat first."); return;
  }
  if (!fs.existsSync(path.join(apiDir, "node_modules", ".bin", isWin ? "tsx.cmd" : "tsx")) ||
      !fs.existsSync(path.join(apiDir, "node_modules", ".bin", isWin ? "prisma.cmd" : "prisma")) ||
      !fs.existsSync(path.join(webDir, "node_modules", ".bin", isWin ? "vite.cmd" : "vite"))) {
    fail("Dependencies are not installed. Double-click setup-local.bat first, and wait until it says Setup complete."); return;
  }
  if (!fs.existsSync(path.join(apiDir, "node_modules", ".prisma", "client", "index.js")) ||
      (isWin && !fs.existsSync(path.join(apiDir, "node_modules", ".prisma", "client", "query_engine-windows.dll.node")))) {
    fail("Prisma Client or its Windows engine is missing. Close the ERP windows and run repair-prisma.bat."); return;
  }
  for (const port of [4000, 5173]) {
    if (!(await portIsFree(port))) {
      fail(`Port ${port} is already in use. Close any older Sastha ERP API/web terminal windows, then run run-erp.bat again.`);
      return;
    }
  }

  console.log("Sastha Infinite ERP — local runner");
  console.log("Starting PostgreSQL (Docker Compose)...");
  const dbStart = await run("docker", ["compose", "up", "-d", "db"], root);
  if (dbStart.code !== 0) { fail("Docker could not start PostgreSQL. Open Docker Desktop, wait until it is ready, and retry."); return; }

  console.log("Waiting for PostgreSQL to become ready...");
  let ready = false;
  for (let i = 0; i < 30; i++) {
    const check = await run("docker", ["compose", "exec", "-T", "db", "pg_isready", "-U", "sastha_app", "-d", "sastha_erp"], root, true);
    if (check.code === 0) { ready = true; break; }
    await delay(2000);
  }
  if (!ready) { fail("PostgreSQL did not become ready within 60 seconds. Check Docker Desktop with: docker compose ps"); return; }

  console.log("Checking/applying the Prisma schema (no client regeneration)...");
  const schema = await run(npm, ["exec", "--", "prisma", "db", "push", "--skip-generate"], apiDir);
  if (schema.code !== 0) {
    fail("The database schema could not be checked. Review the message above; do not reset the database. If the schema has a data-loss warning, stop and share it before accepting any destructive change.");
    return;
  }

  console.log("\nReady. Open http://localhost:5173 in your browser.");
  console.log("API health: http://localhost:4000/health");
  console.log("Press Ctrl+C here to stop the web/API processes. PostgreSQL data is preserved.\n");
  startNpm("API", ["run", "dev"], apiDir);
  startNpm("WEB", ["run", "dev", "--", "--host", "127.0.0.1", "--strictPort"], webDir);
})().catch((error) => { fail(error?.message || String(error)); });

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

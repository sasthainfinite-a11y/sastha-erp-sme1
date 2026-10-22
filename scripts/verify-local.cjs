const { spawnSync } = require("node:child_process");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const isWin = process.platform === "win32";
const npm = isWin ? "npm.cmd" : "npm";
function run(args, cwd) {
  const result = spawnSync(npm, args, { cwd, stdio: "inherit", shell: isWin });
  if (result.error) { console.error(result.error.message); process.exit(1); }
  if (result.status !== 0) process.exit(result.status || 1);
}
const api = path.join(root, "api");
const web = path.join(root, "web");
console.log("Validating Prisma schema...");
run(["exec", "--", "prisma", "validate"], api);
if (!require("node:fs").existsSync(path.join(api, "node_modules", ".prisma", "client", "index.js"))) {
  console.log("Prisma Client not found; generating it now. Close running ERP API windows first.");
  run(["exec", "--", "prisma", "generate"], api);
} else {
  console.log("Prisma Client exists; skipping generation to avoid Windows DLL file-lock errors.");
}
console.log("Building API...");
run(["run", "build"], api);
console.log("Building frontend...");
run(["run", "build"], web);
console.log("\nAll available schema/build checks passed. Live database/API checks require Docker and a running local API.");

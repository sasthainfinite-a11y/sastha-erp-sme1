import { prisma } from "./db";
import { ensureDefaultPlans } from "./plans";

ensureDefaultPlans()
  .then(() => console.log("Default Sastha Infinite ERP subscription plans are ready."))
  .catch((error) => { console.error("Unable to seed subscription plans:", error); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });

import { prisma } from "./db";

export const DEFAULT_PLANS = [
  { code: "LAUNCH", name: "Launch", monthlyPrice: "149.00", annualPrice: "1490.00", limits: { maxUsers: 2, maxProducts: 500, maxWarehouses: 1, support: "Standard", description: "For very small businesses starting with ERP." } },
  { code: "BUSINESS", name: "Business", monthlyPrice: "249.00", annualPrice: "2490.00", limits: { maxUsers: 5, maxProducts: 5000, maxWarehouses: 3, support: "Standard", description: "For growing SMEs managing sales, purchasing and inventory." } },
  { code: "BUSINESS_PLUS", name: "Business Plus", monthlyPrice: "499.00", annualPrice: "4990.00", limits: { maxUsers: 15, maxProducts: 20000, maxWarehouses: 10, support: "Priority", description: "For larger teams needing more room to grow." } }
];

export async function ensureDefaultPlans() {
  for (const p of DEFAULT_PLANS) {
    await prisma.plan.upsert({
      where: { code: p.code },
      update: { name: p.name, monthlyPrice: p.monthlyPrice, annualPrice: p.annualPrice, limits: p.limits, active: true },
      create: { ...p, limits: p.limits, active: true }
    });
  }
}

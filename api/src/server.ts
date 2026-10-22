import "dotenv/config";
import express, { NextFunction, Request, Response, RequestHandler } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { prisma } from "./db";
import { requireAuth } from "./auth";
import { ensureDefaultPlans } from "./plans";

const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));
const configuredWebOrigins = new Set(
  (process.env.WEB_ORIGIN ?? "http://localhost:5173,http://127.0.0.1:5173")
    .split(",").map(value => value.trim()).filter(Boolean)
);
function isLocalDevelopmentOrigin(origin: string): boolean {
  if (process.env.NODE_ENV === "production") return false;
  try {
    const url = new URL(origin);
    const localHost = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
    return localHost && url.protocol === "http:";
  } catch {
    return false;
  }
}
app.use(cors({
  origin: (origin, callback) => {
    // Non-browser requests have no Origin header. In local development, Vite may
    // use localhost, 127.0.0.1, or a different port when its default port is busy.
    const allowed = !origin || configuredWebOrigins.has(origin) || isLocalDevelopmentOrigin(origin);
    callback(null, allowed);
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json({ limit: "2mb" }));
app.use("/api/auth", rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
const port = Number(process.env.PORT ?? 4000);

type AsyncRoute = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;
const route = (fn: AsyncRoute): RequestHandler => (req, res, next) => { void Promise.resolve(fn(req, res, next)).catch(next); };
const tenantId = (req: Request) => req.auth!.tenantId;
const userId = (req: Request) => req.auth!.userId;
const idSchema = z.string().uuid();
const money = z.number().finite().min(0).max(1_000_000_000);
const validRole = (req: Request, roles: string[]) => roles.includes(req.auth?.role ?? "");
function makeNo(prefix: string) { return `${prefix}-${new Date().toISOString().slice(0,10).replaceAll("-","")}-${randomBytes(3).toString("hex").toUpperCase()}`; }
function round2(value: number) { return Math.round((value + Number.EPSILON) * 100) / 100; }
async function logAction(tid: string, uid: string, action: string, entityType: string, entityId?: string, metadata?: unknown) {
  try { await prisma.auditLog.create({ data: { tenantId: tid, actorId: uid, action, entityType, entityId, metadata: metadata as never } }); }
  catch (e) { console.warn("Audit log write failed", e instanceof Error ? e.message : "unknown"); }
}
function forbidden(res: Response) { return res.status(403).json({ error: "Your role does not have permission to perform this action." }); }
function notFound(res: Response, noun: string) { return res.status(404).json({ error: `${noun} not found.` }); }

app.get("/health/live", (_req, res) => res.json({ status: "ok", application: "Sastha Infinite ERP" }));
app.get("/health", route(async (_req, res) => {
  await prisma.$queryRaw`SELECT 1`;
  res.json({ status: "ok", application: "Sastha Infinite ERP", database: "connected" });
}));

// Authentication and company setup
app.post("/api/auth/register", route(async (req, res) => {
  const parsed = z.object({ companyName: z.string().trim().min(2).max(150), email: z.string().trim().email().max(254).transform(v => v.toLowerCase()), password: z.string().min(12).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a company name, valid email and password of at least 12 characters.", details: parsed.error.flatten() });
  const { companyName, email, password } = parsed.data;
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) return res.status(500).json({ error: "JWT_SECRET must be at least 32 characters in api/.env." });
  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) return res.status(409).json({ error: "This email is already registered. Please sign in." });
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    const result = await prisma.$transaction(async tx => {
      const tenant = await tx.tenant.create({ data: { name: companyName, settings: { create: { currency: "MYR", timezone: "Asia/Kuala_Lumpur", invoicePrefix: "INV" } } } });
      const user = await tx.user.create({ data: { email, passwordHash } });
      await tx.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, role: "COMPANY_OWNER" } });
      await tx.warehouse.create({ data: { tenantId: tenant.id, code: "MAIN", name: "Main Warehouse" } });
      const starter = await tx.plan.upsert({ where: { code: "LAUNCH" }, update: {}, create: { code: "LAUNCH", name: "Launch", monthlyPrice: "149.00", annualPrice: "1490.00", limits: { maxUsers: 2, maxProducts: 500, maxWarehouses: 1, support: "Standard" }, active: true } });
      const trialStart = new Date(); const trialEnd = new Date(trialStart); trialEnd.setDate(trialEnd.getDate() + 14);
      await tx.subscription.create({ data: { tenantId: tenant.id, planId: starter.id, status: "TRIALING", periodStart: trialStart, periodEnd: trialEnd } });
      return { tenant, user };
    });
    const token = jwt.sign({ sub: result.user.id }, secret, { expiresIn: "8h", issuer: "sastha-infinite-erp" });
    res.status(201).json({ token, user: { id: result.user.id, email: result.user.email }, company: { id: result.tenant.id, name: result.tenant.name }, role: "COMPANY_OWNER" });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return res.status(409).json({ error: "This email is already registered." });
    throw e;
  }
}));

app.post("/api/auth/login", route(async (req, res) => {
  const parsed = z.object({ email: z.string().trim().email().transform(v => v.toLowerCase()), password: z.string().min(1).max(128) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a valid email and password." });
  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (!user || user.status !== "ACTIVE" || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) return res.status(401).json({ error: "Email or password is incorrect." });
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) return res.status(500).json({ error: "Server authentication is not configured." });
  const membership = await prisma.tenantMembership.findFirst({ where: { userId: user.id, active: true, tenant: { status: "ACTIVE" } }, orderBy: { createdAt: "asc" } });
  if (!membership) return res.status(403).json({ error: "No active company membership was found." });
  const token = jwt.sign({ sub: user.id }, secret, { expiresIn: "8h", issuer: "sastha-infinite-erp" });
  res.json({ token, user: { id: user.id, email: user.email }, companyId: membership.tenantId, companyName: (await prisma.tenant.findUnique({ where: { id: membership.tenantId }, select: { name: true } }))?.name, role: membership.role });
}));

// Public plan catalogue. Prices are draft MYR pricing and can be changed by the operator.
app.get("/api/plans", route(async (_req, res) => {
  await ensureDefaultPlans();
  const data = await prisma.plan.findMany({ where: { active: true }, orderBy: { monthlyPrice: "asc" }, select: { id: true, code: true, name: true, monthlyPrice: true, annualPrice: true, limits: true } });
  res.json({ data, paymentMode: "MANUAL_REQUEST", message: "Online checkout is not configured. Plan requests are sent to the ERP operator for confirmation." });
}));

app.get("/api/subscription", requireAuth, route(async (req, res) => {
  await ensureDefaultPlans();
  const [current, requests] = await Promise.all([
    prisma.subscription.findFirst({ where: { tenantId: tenantId(req) }, include: { plan: true }, orderBy: { createdAt: "desc" } }),
    prisma.planRequest.findMany({ where: { tenantId: tenantId(req) }, include: { plan: { select: { name: true, monthlyPrice: true, annualPrice: true } } }, orderBy: { createdAt: "desc" }, take: 5 })
  ]);
  res.json({ data: current, requests });
}));

app.post("/api/subscription/request-plan", requireAuth, route(async (req, res) => {
  const parsed = z.object({ planId: idSchema, billingCycle: z.enum(["MONTHLY", "ANNUAL"]).default("MONTHLY"), note: z.string().trim().max(500).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose a valid plan and billing cycle." });
  const plan = await prisma.plan.findFirst({ where: { id: parsed.data.planId, active: true } });
  if (!plan) return res.status(404).json({ error: "The selected subscription plan is unavailable." });
  const pending = await prisma.planRequest.findFirst({ where: { tenantId: tenantId(req), status: "PENDING" } });
  if (pending) return res.status(409).json({ error: "You already have a pending subscription request. Sastha Infinite Enterprise will contact you to confirm it." });
  const note = `${parsed.data.billingCycle} billing${parsed.data.note ? ` — ${parsed.data.note}` : ""}`;
  const request = await prisma.planRequest.create({ data: { tenantId: tenantId(req), planId: plan.id, requestedById: userId(req), note } });
  res.status(201).json({ ok: true, data: { id: request.id, status: request.status, planName: plan.name }, message: "Your plan request has been recorded. Online payment is not enabled yet; contact Sastha Infinite Enterprise to confirm payment and activation." });
}));

app.get("/api/me", requireAuth, route(async (req, res) => {
  const [user, company] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId(req) }, select: { id: true, email: true } }),
    prisma.tenant.findUnique({ where: { id: tenantId(req) }, select: { id: true, name: true, status: true, settings: true } })
  ]);
  if (!user || !company) return res.status(401).json({ error: "User or company is no longer active." });
  res.json({ user, company, role: req.auth!.role });
}));

// Dashboard and tenant settings
app.get("/api/dashboard", requireAuth, route(async (req, res) => {
  const tid = tenantId(req);
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
  const [sales, purchases, productCount, customers, suppliers, invoices, expenses, recentSales, recentPurchases, recentMovements] = await Promise.all([
    prisma.salesDocument.aggregate({ where: { tenantId: tid, status: "ISSUED", type: "INVOICE", issuedAt: { gte: monthStart } }, _sum: { grandTotal: true }, _count: { _all: true } }),
    prisma.purchaseDocument.aggregate({ where: { tenantId: tid, status: "ISSUED", type: "SUPPLIER_INVOICE", createdAt: { gte: monthStart } }, _sum: { grandTotal: true }, _count: { _all: true } }),
    prisma.product.count({ where: { tenantId: tid, status: "ACTIVE" } }),
    prisma.customer.count({ where: { tenantId: tid, active: true } }),
    prisma.supplier.count({ where: { tenantId: tid, active: true } }),
    prisma.salesDocument.findMany({ where: { tenantId: tid, type: "INVOICE", status: "ISSUED" }, select: { grandTotal: true, receipts: { select: { amount: true } } }, take: 500 }),
    prisma.expense.aggregate({ where: { tenantId: tid, expenseDate: { gte: monthStart } }, _sum: { amount: true } }),
    prisma.salesDocument.findMany({ where: { tenantId: tid }, include: { customer: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 5 }),
    prisma.purchaseDocument.findMany({ where: { tenantId: tid }, include: { supplier: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 5 }),
    prisma.stockMovement.findMany({ where: { tenantId: tid }, include: { product: { select: { name: true, sku: true } }, warehouse: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 5 })
  ]);
  const outstanding = invoices.reduce((sum, inv) => sum + Number(inv.grandTotal) - inv.receipts.reduce((s, r) => s + Number(r.amount), 0), 0);
  res.json({ data: { salesThisMonth: Number(sales._sum.grandTotal ?? 0), purchasesThisMonth: Number(purchases._sum.grandTotal ?? 0), stockItems: productCount, customers, suppliers, outstanding: Math.max(0, outstanding), expensesThisMonth: Number(expenses._sum.amount ?? 0), invoiceCount: sales._count._all, purchaseInvoiceCount: purchases._count._all, recentSales, recentPurchases, recentMovements } });
}));

app.get("/api/settings", requireAuth, route(async (req, res) => {
  const data = await prisma.tenant.findUnique({ where: { id: tenantId(req) }, include: { settings: true } });
  res.json({ data });
}));
app.put("/api/settings", requireAuth, route(async (req, res) => {
  if (!validRole(req, ["COMPANY_OWNER", "COMPANY_ADMIN"])) return forbidden(res);
  const parsed = z.object({ name: z.string().trim().min(2).max(150), registrationNo: z.string().trim().max(80).optional().nullable(), currency: z.string().trim().length(3).default("MYR"), timezone: z.string().trim().min(1).max(80).default("Asia/Kuala_Lumpur"), invoicePrefix: z.string().trim().min(1).max(10).default("INV") }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Please check the company settings.", details: parsed.error.flatten() });
  const { name, registrationNo, currency, timezone, invoicePrefix } = parsed.data;
  const data = await prisma.$transaction(async tx => {
    await tx.tenant.update({ where: { id: tenantId(req) }, data: { name, registrationNo: registrationNo || null } });
    await tx.tenantSettings.upsert({ where: { tenantId: tenantId(req) }, create: { tenantId: tenantId(req), currency, timezone, invoicePrefix }, update: { currency, timezone, invoicePrefix } });
    return tx.tenant.findUnique({ where: { id: tenantId(req) }, include: { settings: true } });
  });
  await logAction(tenantId(req), userId(req), "COMPANY_SETTINGS_UPDATED", "Tenant", tenantId(req));
  res.json({ data });
}));

// Customers
app.get("/api/customers", requireAuth, route(async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const data = await prisma.customer.findMany({ where: { tenantId: tenantId(req), ...(req.query.all === "true" ? {} : { active: true }), ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { email: { contains: q, mode: "insensitive" as const } }, { phone: { contains: q } }] } : {}) }, orderBy: { name: "asc" }, take: 500 });
  res.json({ data });
}));
app.post("/api/customers", requireAuth, route(async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(200), email: z.union([z.string().email().max(254), z.literal("")]).optional(), phone: z.string().trim().max(40).optional(), tin: z.string().trim().max(80).optional(), registrationNo: z.string().trim().max(80).optional(), address: z.string().trim().max(1000).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Check the customer details.", details: parsed.error.flatten() });
  const d = parsed.data;
  const item = await prisma.customer.create({ data: { tenantId: tenantId(req), name: d.name, email: d.email || null, phone: d.phone || null, tin: d.tin || null, registrationNo: d.registrationNo || null, address: d.address ? { text: d.address } : undefined } });
  await logAction(tenantId(req), userId(req), "CUSTOMER_CREATED", "Customer", item.id);
  res.status(201).json({ data: item });
}));
app.put("/api/customers/:id", requireAuth, route(async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(200), email: z.union([z.string().email().max(254), z.literal("")]).optional(), phone: z.string().trim().max(40).optional(), tin: z.string().trim().max(80).optional(), registrationNo: z.string().trim().max(80).optional(), address: z.string().trim().max(1000).optional(), active: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Check the customer details." });
  const d = parsed.data;
  const exists = await prisma.customer.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) } }); if (!exists) return notFound(res, "Customer");
  const item = await prisma.customer.update({ where: { id: exists.id }, data: { name: d.name, email: d.email || null, phone: d.phone || null, tin: d.tin || null, registrationNo: d.registrationNo || null, address: d.address ? { text: d.address } : undefined, active: d.active } });
  res.json({ data: item });
}));
app.delete("/api/customers/:id", requireAuth, route(async (req, res) => {
  const r = await prisma.customer.updateMany({ where: { id: req.params.id, tenantId: tenantId(req) }, data: { active: false } });
  if (!r.count) return notFound(res, "Customer"); await logAction(tenantId(req), userId(req), "CUSTOMER_ARCHIVED", "Customer", req.params.id); res.json({ ok: true });
}));

// Suppliers
app.get("/api/suppliers", requireAuth, route(async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const data = await prisma.supplier.findMany({ where: { tenantId: tenantId(req), ...(req.query.all === "true" ? {} : { active: true }), ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { email: { contains: q, mode: "insensitive" as const } }, { phone: { contains: q } }] } : {}) }, orderBy: { name: "asc" }, take: 500 });
  res.json({ data });
}));
app.post("/api/suppliers", requireAuth, route(async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(200), email: z.union([z.string().email().max(254), z.literal("")]).optional(), phone: z.string().trim().max(40).optional(), tin: z.string().trim().max(80).optional(), registrationNo: z.string().trim().max(80).optional(), address: z.string().trim().max(1000).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Check the supplier details.", details: parsed.error.flatten() });
  const d = parsed.data;
  const item = await prisma.supplier.create({ data: { tenantId: tenantId(req), name: d.name, email: d.email || null, phone: d.phone || null, tin: d.tin || null, registrationNo: d.registrationNo || null, address: d.address ? { text: d.address } : undefined } });
  await logAction(tenantId(req), userId(req), "SUPPLIER_CREATED", "Supplier", item.id); res.status(201).json({ data: item });
}));
app.put("/api/suppliers/:id", requireAuth, route(async (req, res) => {
  const parsed = z.object({ name: z.string().trim().min(1).max(200), email: z.union([z.string().email().max(254), z.literal("")]).optional(), phone: z.string().trim().max(40).optional(), tin: z.string().trim().max(80).optional(), registrationNo: z.string().trim().max(80).optional(), address: z.string().trim().max(1000).optional(), active: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Check the supplier details." }); const d = parsed.data;
  const exists = await prisma.supplier.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) } }); if (!exists) return notFound(res, "Supplier");
  const item = await prisma.supplier.update({ where: { id: exists.id }, data: { name: d.name, email: d.email || null, phone: d.phone || null, tin: d.tin || null, registrationNo: d.registrationNo || null, address: d.address ? { text: d.address } : undefined, active: d.active } }); res.json({ data: item });
}));
app.delete("/api/suppliers/:id", requireAuth, route(async (req, res) => { const r = await prisma.supplier.updateMany({ where: { id: req.params.id, tenantId: tenantId(req) }, data: { active: false } }); if (!r.count) return notFound(res, "Supplier"); await logAction(tenantId(req), userId(req), "SUPPLIER_ARCHIVED", "Supplier", req.params.id); res.json({ ok: true }); }));

// Warehouses and products
app.get("/api/warehouses", requireAuth, route(async (req, res) => { const data = await prisma.warehouse.findMany({ where: { tenantId: tenantId(req), active: true }, orderBy: { name: "asc" } }); res.json({ data }); }));
app.post("/api/warehouses", requireAuth, route(async (req, res) => {
  if (!validRole(req, ["COMPANY_OWNER", "COMPANY_ADMIN", "STOCK_STAFF"])) return forbidden(res);
  const parsed = z.object({ code: z.string().trim().min(1).max(30), name: z.string().trim().min(1).max(150) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "Enter a warehouse code and name." });
  try { const data = await prisma.warehouse.create({ data: { ...parsed.data, tenantId: tenantId(req) } }); res.status(201).json({ data }); }
  catch (e) { if ((e as { code?: string }).code === "P2002") return res.status(409).json({ error: "That warehouse code already exists." }); throw e; }
}));
app.get("/api/products", requireAuth, route(async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  const data = await prisma.product.findMany({ where: { tenantId: tenantId(req), ...(req.query.all === "true" ? {} : { status: "ACTIVE" }), ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" as const } }, { sku: { contains: q, mode: "insensitive" as const } }, { barcode: { contains: q } }] } : {}) }, include: { stockMovements: { select: { quantityDelta: true } } }, orderBy: { name: "asc" }, take: 500 });
  res.json({ data: data.map(({ stockMovements, ...p }) => ({ ...p, stockOnHand: stockMovements.reduce((s, m) => s + Number(m.quantityDelta), 0) })) });
}));
app.post("/api/products", requireAuth, route(async (req, res) => {
  if (!validRole(req, ["COMPANY_OWNER", "COMPANY_ADMIN", "STOCK_STAFF"])) return forbidden(res);
  const parsed = z.object({ sku: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(200), barcode: z.string().trim().max(100).optional(), description: z.string().trim().max(1000).optional(), unitCode: z.string().trim().max(20).default("UNIT"), unitPrice: money.default(0), unitCost: money.default(0) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Check the product details.", details: parsed.error.flatten() });
  try { const data = await prisma.product.create({ data: { tenantId: tenantId(req), ...parsed.data } }); await logAction(tenantId(req), userId(req), "PRODUCT_CREATED", "Product", data.id); res.status(201).json({ data: { ...data, stockOnHand: 0 } }); }
  catch (e) { if ((e as { code?: string }).code === "P2002") return res.status(409).json({ error: "This SKU already exists in your company." }); throw e; }
}));
app.put("/api/products/:id", requireAuth, route(async (req, res) => {
  if (!validRole(req, ["COMPANY_OWNER", "COMPANY_ADMIN", "STOCK_STAFF"])) return forbidden(res);
  const parsed = z.object({ sku: z.string().trim().min(1).max(80), name: z.string().trim().min(1).max(200), barcode: z.string().trim().max(100).optional(), description: z.string().trim().max(1000).optional(), unitCode: z.string().trim().max(20).default("UNIT"), unitPrice: money.default(0), unitCost: money.default(0) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "Check the product details." });
  const exists = await prisma.product.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) } }); if (!exists) return notFound(res, "Product");
  try { const data = await prisma.product.update({ where: { id: exists.id }, data: parsed.data }); res.json({ data }); } catch (e) { if ((e as { code?: string }).code === "P2002") return res.status(409).json({ error: "This SKU already exists." }); throw e; }
}));
app.delete("/api/products/:id", requireAuth, route(async (req, res) => { if (!validRole(req, ["COMPANY_OWNER", "COMPANY_ADMIN", "STOCK_STAFF"])) return forbidden(res); const r = await prisma.product.updateMany({ where: { id: req.params.id, tenantId: tenantId(req) }, data: { status: "ARCHIVED" } }); if (!r.count) return notFound(res, "Product"); await logAction(tenantId(req), userId(req), "PRODUCT_ARCHIVED", "Product", req.params.id); res.json({ ok: true }); }));

// Inventory movement ledger
app.get("/api/stock/movements", requireAuth, route(async (req, res) => {
  const data = await prisma.stockMovement.findMany({ where: { tenantId: tenantId(req) }, include: { product: { select: { id: true, name: true, sku: true } }, warehouse: { select: { id: true, name: true, code: true } } }, orderBy: { createdAt: "desc" }, take: 500 }); res.json({ data });
}));
app.post("/api/stock/movements", requireAuth, route(async (req, res) => {
  if (!validRole(req, ["COMPANY_OWNER", "COMPANY_ADMIN", "STOCK_STAFF"])) return forbidden(res);
  const parsed = z.object({ productId: idSchema, warehouseId: idSchema, type: z.enum(["OPENING", "RECEIPT", "SALE", "RETURN_IN", "RETURN_OUT", "ADJUSTMENT", "TRANSFER_IN", "TRANSFER_OUT"]), quantityDelta: z.number().finite().min(-1_000_000).max(1_000_000).refine(v => v !== 0, "Quantity cannot be zero"), unitCost: money.optional(), reason: z.string().trim().min(2).max(500) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter a product, warehouse, non-zero quantity and reason.", details: parsed.error.flatten() });
  const p = await prisma.product.findFirst({ where: { id: parsed.data.productId, tenantId: tenantId(req), status: "ACTIVE" } }); const w = await prisma.warehouse.findFirst({ where: { id: parsed.data.warehouseId, tenantId: tenantId(req), active: true } }); if (!p || !w) return res.status(400).json({ error: "Choose a product and warehouse belonging to this company." });
  const current = await prisma.stockMovement.aggregate({ where: { tenantId: tenantId(req), productId: p.id, warehouseId: w.id }, _sum: { quantityDelta: true } });
  if (Number(current._sum.quantityDelta ?? 0) + parsed.data.quantityDelta < 0) return res.status(409).json({ error: "This adjustment would make stock negative." });
  const data = await prisma.stockMovement.create({ data: { tenantId: tenantId(req), productId: p.id, warehouseId: w.id, type: parsed.data.type, quantityDelta: parsed.data.quantityDelta, unitCost: parsed.data.unitCost, reason: parsed.data.reason, createdBy: userId(req), sourceType: "MANUAL" }, include: { product: true, warehouse: true } });
  await logAction(tenantId(req), userId(req), "STOCK_MOVEMENT_CREATED", "StockMovement", data.id, { type: data.type, quantityDelta: data.quantityDelta.toString() }); res.status(201).json({ data });
}));

const salesType = z.enum(["QUOTATION", "SALES_ORDER", "INVOICE", "CREDIT_NOTE"]);
const purchaseType = z.enum(["PURCHASE_ORDER", "SUPPLIER_INVOICE"]);
const linesSchema = z.array(z.object({ productId: z.union([idSchema, z.literal("")]).optional(), description: z.string().trim().min(1).max(500), quantity: z.number().finite().positive().max(1_000_000), unitPrice: money }).refine(line => !line.productId || idSchema.safeParse(line.productId).success)).min(1).max(100);
function docPrefix(type: string) { return ({ QUOTATION: "QUO", SALES_ORDER: "SO", INVOICE: "INV", CREDIT_NOTE: "CRN", PURCHASE_ORDER: "PO", SUPPLIER_INVOICE: "PINV" } as Record<string,string>)[type] ?? "DOC"; }

// Sales documents / quotation / order / invoices
app.get("/api/sales-documents", requireAuth, route(async (req, res) => {
  const data = await prisma.salesDocument.findMany({ where: { tenantId: tenantId(req), ...(req.query.type ? { type: String(req.query.type) as never } : {}) }, include: { customer: { select: { id: true, name: true } }, lines: true, receipts: { select: { id: true, amount: true, receiptNo: true, paymentDate: true } } }, orderBy: { createdAt: "desc" }, take: 500 });
  res.json({ data: data.map(d => ({ ...d, paidAmount: d.receipts.reduce((s, p) => s + Number(p.amount), 0), balance: Math.max(0, Number(d.grandTotal) - d.receipts.reduce((s, p) => s + Number(p.amount), 0)) })) });
}));
app.post("/api/sales-documents", requireAuth, route(async (req, res) => {
  if (!validRole(req, ["COMPANY_OWNER", "COMPANY_ADMIN", "SALES_STAFF"])) return forbidden(res);
  const parsed = z.object({ customerId: idSchema, type: salesType, documentNo: z.string().trim().max(80).optional(), discount: money.default(0), taxRate: z.number().finite().min(0).max(100).default(0), notes: z.string().trim().max(1000).optional(), lines: linesSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Check the document and at least one line item.", details: parsed.error.flatten() });
  const d = parsed.data; const customer = await prisma.customer.findFirst({ where: { id: d.customerId, tenantId: tenantId(req), active: true } }); if (!customer) return res.status(400).json({ error: "Choose an active customer from this company." });
  const productIds = [...new Set(d.lines.map(x => x.productId).filter((x): x is string => Boolean(x)))];
  if (productIds.length) { const count = await prisma.product.count({ where: { id: { in: productIds }, tenantId: tenantId(req), status: "ACTIVE" } }); if (count !== productIds.length) return res.status(400).json({ error: "One or more line items contain a product from another company or an inactive product." }); }
  const subtotal = round2(d.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0)); const taxTotal = round2(Math.max(0, subtotal - d.discount) * d.taxRate / 100); const grandTotal = round2(Math.max(0, subtotal - d.discount) + taxTotal);
  const tenantSettings = await prisma.tenantSettings.findUnique({ where: { tenantId: tenantId(req) }, select: { invoicePrefix: true } });
  const no = d.documentNo || makeNo(d.type === "INVOICE" ? (tenantSettings?.invoicePrefix || "INV") : docPrefix(d.type));
  try { const data = await prisma.salesDocument.create({ data: { tenantId: tenantId(req), customerId: customer.id, documentNo: no, type: d.type, subtotal, discount: d.discount, taxTotal, grandTotal, lines: { create: d.lines.map(l => ({ tenantId: tenantId(req), productId: l.productId || null, description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, lineTotal: round2(l.quantity * l.unitPrice) })) } }, include: { customer: true, lines: true } }); await logAction(tenantId(req), userId(req), "SALES_DOCUMENT_CREATED", "SalesDocument", data.id, { type: data.type, documentNo: data.documentNo }); res.status(201).json({ data }); }
  catch (e) { if ((e as { code?: string }).code === "P2002") return res.status(409).json({ error: "That document number already exists. Try again or enter a different number." }); throw e; }
}));
app.post("/api/sales-documents/:id/issue", requireAuth, route(async (req, res) => {
  if (!validRole(req, ["COMPANY_OWNER", "COMPANY_ADMIN", "SALES_STAFF"])) return forbidden(res);
  const id = req.params.id; const doc = await prisma.salesDocument.findFirst({ where: { id, tenantId: tenantId(req) }, include: { lines: true } }); if (!doc) return notFound(res, "Sales document"); if (doc.status !== "DRAFT") return res.status(409).json({ error: "Only draft documents can be issued." });
  const needsStock = doc.type === "INVOICE" || doc.type === "CREDIT_NOTE"; let warehouseId: string | undefined;
  if (needsStock && doc.lines.some(l => l.productId)) { const wid = z.string().uuid().safeParse(req.body?.warehouseId); if (!wid.success) return res.status(400).json({ error: "Select a warehouse before issuing an invoice or credit note." }); const wh = await prisma.warehouse.findFirst({ where: { id: wid.data, tenantId: tenantId(req), active: true } }); if (!wh) return res.status(400).json({ error: "Warehouse does not belong to this company." }); warehouseId = wh.id; }
  const created = await prisma.$transaction(async tx => {
    if (warehouseId && doc.type === "INVOICE") {
      const quantities = new Map<string, number>();
      for (const line of doc.lines) if (line.productId) quantities.set(line.productId, (quantities.get(line.productId) ?? 0) + Number(line.quantity));
      for (const [productId, quantity] of quantities) { const result = await tx.stockMovement.aggregate({ where: { tenantId: tenantId(req), productId, warehouseId }, _sum: { quantityDelta: true } }); if (Number(result._sum.quantityDelta ?? 0) < quantity) { const product = await tx.product.findUnique({ where: { id: productId }, select: { name: true } }); throw new Error(`INSUFFICIENT_STOCK:${product?.name ?? productId}`); } }
      for (const line of doc.lines) { if (!line.productId) continue; await tx.stockMovement.create({ data: { tenantId: tenantId(req), productId: line.productId, warehouseId, type: "SALE", quantityDelta: -Number(line.quantity), sourceType: "SALES_INVOICE", sourceId: doc.id, reason: `Issued invoice ${doc.documentNo}`, createdBy: userId(req) } }); }
    }
    if (warehouseId && doc.type === "CREDIT_NOTE") { for (const line of doc.lines) { if (!line.productId) continue; await tx.stockMovement.create({ data: { tenantId: tenantId(req), productId: line.productId, warehouseId, type: "RETURN_IN", quantityDelta: line.quantity, sourceType: "CREDIT_NOTE", sourceId: doc.id, reason: `Issued credit note ${doc.documentNo}`, createdBy: userId(req) } }); } }
    return tx.salesDocument.update({ where: { id: doc.id }, data: { status: "ISSUED", issuedAt: new Date() }, include: { customer: true, lines: true } });
  }).catch(e => { if (e instanceof Error && e.message.startsWith("INSUFFICIENT_STOCK:")) return { __insufficient: e.message.split(":")[1] }; throw e; });
  if ("__insufficient" in created) return res.status(409).json({ error: `Not enough stock for ${created.__insufficient}.` });
  await logAction(tenantId(req), userId(req), "SALES_DOCUMENT_ISSUED", "SalesDocument", doc.id, { documentNo: doc.documentNo }); res.json({ data: created });
}));
app.post("/api/sales-documents/:id/void", requireAuth, route(async (req, res) => {
  if (!validRole(req, ["COMPANY_OWNER", "COMPANY_ADMIN"])) return forbidden(res); const doc = await prisma.salesDocument.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) } }); if (!doc) return notFound(res, "Sales document"); if (doc.status !== "DRAFT") return res.status(409).json({ error: "Only draft documents can be voided in this local version. Issued documents require a reversing credit note." }); const data = await prisma.salesDocument.update({ where: { id: doc.id }, data: { status: "VOIDED" } }); res.json({ data });
}));

// Purchase orders and supplier invoices
app.get("/api/purchase-documents", requireAuth, route(async (req, res) => {
  const data = await prisma.purchaseDocument.findMany({ where: { tenantId: tenantId(req) }, include: { supplier: { select: { id: true, name: true } }, lines: true, payments: { select: { id: true, amount: true, paymentNo: true, paymentDate: true } } }, orderBy: { createdAt: "desc" }, take: 500 });
  res.json({ data: data.map(d => ({ ...d, paidAmount: d.payments.reduce((s, p) => s + Number(p.amount), 0), balance: Math.max(0, Number(d.grandTotal) - d.payments.reduce((s, p) => s + Number(p.amount), 0)), received: d.lines.length ? undefined : false })) });
}));
app.post("/api/purchase-documents", requireAuth, route(async (req, res) => {
  if (!validRole(req, ["COMPANY_OWNER", "COMPANY_ADMIN", "PURCHASE_STAFF"])) return forbidden(res);
  const parsed = z.object({ supplierId: idSchema, type: purchaseType, documentNo: z.string().trim().max(80).optional(), taxRate: z.number().finite().min(0).max(100).default(0), notes: z.string().trim().max(1000).optional(), lines: linesSchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Check the purchase document and line items.", details: parsed.error.flatten() }); const d = parsed.data;
  const supplier = await prisma.supplier.findFirst({ where: { id: d.supplierId, tenantId: tenantId(req), active: true } }); if (!supplier) return res.status(400).json({ error: "Choose an active supplier from this company." });
  const productIds = [...new Set(d.lines.map(x => x.productId).filter((x): x is string => Boolean(x)))]; if (productIds.length) { const count = await prisma.product.count({ where: { id: { in: productIds }, tenantId: tenantId(req), status: "ACTIVE" } }); if (count !== productIds.length) return res.status(400).json({ error: "A selected product is not active in this company." }); }
  const subtotal = round2(d.lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0)); const taxTotal = round2(subtotal * d.taxRate / 100); const grandTotal = round2(subtotal + taxTotal); const no = d.documentNo || makeNo(docPrefix(d.type));
  try { const data = await prisma.purchaseDocument.create({ data: { tenantId: tenantId(req), supplierId: supplier.id, documentNo: no, type: d.type, subtotal, taxTotal, grandTotal, lines: { create: d.lines.map(l => ({ tenantId: tenantId(req), productId: l.productId || null, description: l.description, quantity: l.quantity, unitCost: l.unitPrice, lineTotal: round2(l.quantity * l.unitPrice) })) } }, include: { supplier: true, lines: true } }); await logAction(tenantId(req), userId(req), "PURCHASE_DOCUMENT_CREATED", "PurchaseDocument", data.id, { type: data.type, documentNo: data.documentNo }); res.status(201).json({ data }); }
  catch (e) { if ((e as { code?: string }).code === "P2002") return res.status(409).json({ error: "That purchase document number already exists." }); throw e; }
}));
app.post("/api/purchase-documents/:id/issue", requireAuth, route(async (req, res) => {
  if (!validRole(req, ["COMPANY_OWNER", "COMPANY_ADMIN", "PURCHASE_STAFF"])) return forbidden(res);
  const doc = await prisma.purchaseDocument.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, include: { lines: true } }); if (!doc) return notFound(res, "Purchase document"); if (doc.status !== "DRAFT") return res.status(409).json({ error: "Only draft purchase documents can be issued." });
  let warehouseId: string | undefined;
  if (doc.type === "SUPPLIER_INVOICE" && doc.lines.some(l => l.productId)) { const parsed = idSchema.safeParse(req.body?.warehouseId); if (!parsed.success) return res.status(400).json({ error: "Select a warehouse before posting supplier stock." }); const wh = await prisma.warehouse.findFirst({ where: { id: parsed.data, tenantId: tenantId(req), active: true } }); if (!wh) return res.status(400).json({ error: "Warehouse does not belong to this company." }); warehouseId = wh.id; }
  const data = await prisma.$transaction(async tx => { if (warehouseId) for (const line of doc.lines) if (line.productId) await tx.stockMovement.create({ data: { tenantId: tenantId(req), productId: line.productId, warehouseId: warehouseId!, type: "RECEIPT", quantityDelta: line.quantity, unitCost: line.unitCost, sourceType: "SUPPLIER_INVOICE", sourceId: doc.id, reason: `Posted supplier invoice ${doc.documentNo}`, createdBy: userId(req) } }); return tx.purchaseDocument.update({ where: { id: doc.id }, data: { status: "ISSUED" }, include: { supplier: true, lines: true } }); });
  await logAction(tenantId(req), userId(req), "PURCHASE_DOCUMENT_ISSUED", "PurchaseDocument", doc.id); res.json({ data });
}));
app.post("/api/purchase-documents/:id/receive", requireAuth, route(async (req, res) => {
  if (!validRole(req, ["COMPANY_OWNER", "COMPANY_ADMIN", "PURCHASE_STAFF", "STOCK_STAFF"])) return forbidden(res);
  const doc = await prisma.purchaseDocument.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, include: { lines: true } }); if (!doc) return notFound(res, "Purchase order"); if (doc.type !== "PURCHASE_ORDER" || doc.status !== "ISSUED") return res.status(409).json({ error: "Only an issued purchase order can be received." });
  const parsed = idSchema.safeParse(req.body?.warehouseId); if (!parsed.success) return res.status(400).json({ error: "Select a warehouse." }); const wh = await prisma.warehouse.findFirst({ where: { id: parsed.data, tenantId: tenantId(req), active: true } }); if (!wh) return res.status(400).json({ error: "Warehouse does not belong to this company." });
  const previous = await prisma.stockMovement.count({ where: { tenantId: tenantId(req), sourceType: "PURCHASE_ORDER_RECEIPT", sourceId: doc.id } }); if (previous) return res.status(409).json({ error: "This order has already been received. Partial receiving is not enabled in this version." });
  await prisma.$transaction(async tx => { for (const line of doc.lines) if (line.productId) await tx.stockMovement.create({ data: { tenantId: tenantId(req), productId: line.productId, warehouseId: wh.id, type: "RECEIPT", quantityDelta: line.quantity, unitCost: line.unitCost, sourceType: "PURCHASE_ORDER_RECEIPT", sourceId: doc.id, reason: `Received purchase order ${doc.documentNo}`, createdBy: userId(req) } }); });
  res.json({ ok: true, message: "Purchase order received into stock." });
}));

// Customer receipts, supplier payments and expenses
app.get("/api/receipts", requireAuth, route(async (req, res) => { const data = await prisma.customerReceipt.findMany({ where: { tenantId: tenantId(req) }, include: { customer: { select: { id: true, name: true } }, document: { select: { id: true, documentNo: true } } }, orderBy: { paymentDate: "desc" }, take: 500 }); res.json({ data }); }));
app.post("/api/receipts", requireAuth, route(async (req, res) => {
  if (!validRole(req, ["COMPANY_OWNER", "COMPANY_ADMIN", "SALES_STAFF", "ACCOUNTANT"])) return forbidden(res);
  const parsed = z.object({ customerId: idSchema, documentId: z.union([idSchema, z.literal("")]).optional(), amount: money.refine(v => v > 0, "Amount must be greater than zero"), method: z.string().trim().min(1).max(50).default("Bank transfer"), reference: z.string().trim().max(100).optional(), note: z.string().trim().max(500).optional(), paymentDate: z.string().datetime().optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "Check receipt details.", details: parsed.error.flatten() }); const d = parsed.data;
  const customer = await prisma.customer.findFirst({ where: { id: d.customerId, tenantId: tenantId(req), active: true } }); if (!customer) return res.status(400).json({ error: "Select a customer in this company." });
  let documentId: string | null = null;
  if (d.documentId) { const doc = await prisma.salesDocument.findFirst({ where: { id: d.documentId, tenantId: tenantId(req), customerId: customer.id, type: "INVOICE", status: "ISSUED" }, include: { receipts: true } }); if (!doc) return res.status(400).json({ error: "Select an issued invoice for this customer." }); const balance = Number(doc.grandTotal) - doc.receipts.reduce((s, r) => s + Number(r.amount), 0); if (d.amount - balance > 0.005) return res.status(409).json({ error: `Receipt exceeds invoice balance of RM ${Math.max(0,balance).toFixed(2)}.` }); documentId = doc.id; }
  const data = await prisma.customerReceipt.create({ data: { tenantId: tenantId(req), customerId: customer.id, documentId, receiptNo: makeNo("RCT"), amount: d.amount, method: d.method, reference: d.reference || null, note: d.note || null, paymentDate: d.paymentDate ? new Date(d.paymentDate) : new Date() }, include: { customer: true, document: true } }); await logAction(tenantId(req), userId(req), "CUSTOMER_RECEIPT_CREATED", "CustomerReceipt", data.id); res.status(201).json({ data });
}));
app.get("/api/supplier-payments", requireAuth, route(async (req, res) => { const data = await prisma.supplierPayment.findMany({ where: { tenantId: tenantId(req) }, include: { supplier: { select: { id: true, name: true } }, document: { select: { id: true, documentNo: true } } }, orderBy: { paymentDate: "desc" }, take: 500 }); res.json({ data }); }));
app.post("/api/supplier-payments", requireAuth, route(async (req, res) => {
  if (!validRole(req, ["COMPANY_OWNER", "COMPANY_ADMIN", "PURCHASE_STAFF", "ACCOUNTANT"])) return forbidden(res);
  const parsed = z.object({ supplierId: idSchema, documentId: z.union([idSchema, z.literal("")]).optional(), amount: money.refine(v => v > 0), method: z.string().trim().min(1).max(50).default("Bank transfer"), reference: z.string().trim().max(100).optional(), note: z.string().trim().max(500).optional(), paymentDate: z.string().datetime().optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "Check supplier payment details.", details: parsed.error.flatten() }); const d = parsed.data;
  const supplier = await prisma.supplier.findFirst({ where: { id: d.supplierId, tenantId: tenantId(req), active: true } }); if (!supplier) return res.status(400).json({ error: "Select a supplier in this company." }); let documentId: string | null = null;
  if (d.documentId) { const doc = await prisma.purchaseDocument.findFirst({ where: { id: d.documentId, tenantId: tenantId(req), supplierId: supplier.id, type: "SUPPLIER_INVOICE", status: "ISSUED" }, include: { payments: true } }); if (!doc) return res.status(400).json({ error: "Select an issued supplier invoice for this supplier." }); const balance = Number(doc.grandTotal) - doc.payments.reduce((s, p) => s + Number(p.amount), 0); if (d.amount - balance > 0.005) return res.status(409).json({ error: `Payment exceeds invoice balance of RM ${Math.max(0,balance).toFixed(2)}.` }); documentId = doc.id; }
  const data = await prisma.supplierPayment.create({ data: { tenantId: tenantId(req), supplierId: supplier.id, documentId, paymentNo: makeNo("PAY"), amount: d.amount, method: d.method, reference: d.reference || null, note: d.note || null, paymentDate: d.paymentDate ? new Date(d.paymentDate) : new Date() }, include: { supplier: true, document: true } }); await logAction(tenantId(req), userId(req), "SUPPLIER_PAYMENT_CREATED", "SupplierPayment", data.id); res.status(201).json({ data });
}));
app.get("/api/expenses", requireAuth, route(async (req, res) => { const data = await prisma.expense.findMany({ where: { tenantId: tenantId(req) }, orderBy: { expenseDate: "desc" }, take: 500 }); res.json({ data }); }));
app.post("/api/expenses", requireAuth, route(async (req, res) => {
  if (!validRole(req, ["COMPANY_OWNER", "COMPANY_ADMIN", "ACCOUNTANT"])) return forbidden(res);
  const parsed = z.object({ category: z.string().trim().min(1).max(100), description: z.string().trim().min(1).max(300), amount: money.refine(v => v > 0), method: z.string().trim().min(1).max(50).default("Bank transfer"), reference: z.string().trim().max(100).optional(), notes: z.string().trim().max(500).optional(), expenseDate: z.string().datetime().optional() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "Check expense details.", details: parsed.error.flatten() }); const d = parsed.data;
  const data = await prisma.expense.create({ data: { tenantId: tenantId(req), category: d.category, description: d.description, amount: d.amount, method: d.method, reference: d.reference || null, notes: d.notes || null, expenseDate: d.expenseDate ? new Date(d.expenseDate) : new Date() } }); await logAction(tenantId(req), userId(req), "EXPENSE_CREATED", "Expense", data.id); res.status(201).json({ data });
}));

// Operational reports and audit trail
app.get("/api/reports/summary", requireAuth, route(async (req, res) => {
  const tid = tenantId(req); const from = req.query.from ? new Date(String(req.query.from)) : new Date(new Date().getFullYear(), 0, 1); const to = req.query.to ? new Date(String(req.query.to)) : new Date(); to.setHours(23,59,59,999);
  if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf())) return res.status(400).json({ error: "Use valid from/to dates." });
  const [salesDocs, purchaseDocs, receipts, payments, expenses, moves, customers, suppliers, products] = await Promise.all([
    prisma.salesDocument.findMany({ where: { tenantId: tid, status: "ISSUED", type: "INVOICE", issuedAt: { gte: from, lte: to } }, include: { customer: { select: { name: true } } }, orderBy: { issuedAt: "desc" } }),
    prisma.purchaseDocument.findMany({ where: { tenantId: tid, status: "ISSUED", type: "SUPPLIER_INVOICE", createdAt: { gte: from, lte: to } }, include: { supplier: { select: { name: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.customerReceipt.findMany({ where: { tenantId: tid, paymentDate: { gte: from, lte: to } }, include: { customer: { select: { name: true } }, document: { select: { documentNo: true } } }, orderBy: { paymentDate: "desc" } }),
    prisma.supplierPayment.findMany({ where: { tenantId: tid, paymentDate: { gte: from, lte: to } }, include: { supplier: { select: { name: true } }, document: { select: { documentNo: true } } }, orderBy: { paymentDate: "desc" } }),
    prisma.expense.findMany({ where: { tenantId: tid, expenseDate: { gte: from, lte: to } }, orderBy: { expenseDate: "desc" } }),
    prisma.stockMovement.findMany({ where: { tenantId: tid, createdAt: { gte: from, lte: to } }, include: { product: { select: { name: true, sku: true } }, warehouse: { select: { name: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.customer.count({ where: { tenantId: tid, active: true } }), prisma.supplier.count({ where: { tenantId: tid, active: true } }), prisma.product.findMany({ where: { tenantId: tid, status: "ACTIVE" }, include: { stockMovements: { select: { quantityDelta: true } } }, orderBy: { name: "asc" } })
  ]);
  const expenseTotal = expenses.reduce((s, x) => s + Number(x.amount), 0); const salesTotal = salesDocs.reduce((s, x) => s + Number(x.grandTotal), 0); const purchaseTotal = purchaseDocs.reduce((s, x) => s + Number(x.grandTotal), 0); const receiptTotal = receipts.reduce((s, x) => s + Number(x.amount), 0); const paymentTotal = payments.reduce((s, x) => s + Number(x.amount), 0);
  res.json({ data: { from, to, salesDocs, purchaseDocs, receipts, payments, expenses, movements: moves, customers, suppliers, products: products.map(({stockMovements,...p})=>({...p,stockOnHand:stockMovements.reduce((s,m)=>s+Number(m.quantityDelta),0)})), totals: { sales: salesTotal, purchases: purchaseTotal, receipts: receiptTotal, supplierPayments: paymentTotal, expenses: expenseTotal, netCashMovement: receiptTotal - paymentTotal - expenseTotal } } });
}));
app.get("/api/audit-logs", requireAuth, route(async (req, res) => { const data = await prisma.auditLog.findMany({ where: { tenantId: tenantId(req) }, orderBy: { createdAt: "desc" }, take: 200 }); res.json({ data }); }));
app.get("/api/notifications", requireAuth, route(async (req, res) => {
  const tid = tenantId(req); const [sales, purchases, stock] = await Promise.all([
    prisma.salesDocument.findMany({ where: { tenantId: tid }, include: { customer: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 3 }),
    prisma.purchaseDocument.findMany({ where: { tenantId: tid }, include: { supplier: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 3 }),
    prisma.stockMovement.findMany({ where: { tenantId: tid }, include: { product: { select: { name: true } } }, orderBy: { createdAt: "desc" }, take: 3 })
  ]); res.json({ data: [...sales.map(x=>({id:x.id,title:`${x.type} ${x.documentNo}`,detail:`${x.customer.name} · ${x.status}`,createdAt:x.createdAt})),...purchases.map(x=>({id:x.id,title:`${x.type} ${x.documentNo}`,detail:`${x.supplier.name} · ${x.status}`,createdAt:x.createdAt})),...stock.map(x=>({id:x.id,title:`Stock ${x.type.toLowerCase().replaceAll("_"," ")}`,detail:`${x.product.name} · ${x.quantityDelta}`,createdAt:x.createdAt}))].sort((a,b)=>new Date(b.createdAt).getTime()-new Date(a.createdAt).getTime()).slice(0,8) });
}));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const error = err as { code?: string; message?: string; issues?: unknown };
  console.error("ERP API error:", error?.message ?? error);
  if (error?.code === "P2002") return res.status(409).json({ error: "A record with the same unique value already exists." });
  if (error?.code === "P2003") return res.status(400).json({ error: "This record is referenced by another transaction and cannot be changed or removed." });
  if (error?.code === "P2025") return res.status(404).json({ error: "The requested record was not found." });
  res.status(500).json({ error: process.env.NODE_ENV === "development" ? (error?.message ?? "Unexpected server error") : "Unexpected server error" });
});

const server = app.listen(port, () => { console.log(`Sastha Infinite ERP API listening on port ${port}`); void ensureDefaultPlans().catch(error => console.error("Subscription plan seeding deferred until database is ready:", error instanceof Error ? error.message : error)); });
process.on("SIGINT", async () => { server.close(); await prisma.$disconnect(); process.exit(0); });
process.on("SIGTERM", async () => { server.close(); await prisma.$disconnect(); process.exit(0); });

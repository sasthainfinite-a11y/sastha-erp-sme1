import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "./db";

export type AuthContext = {
  userId: string;
  tenantId: string;
  role: string;
};

declare global {
  namespace Express {
    interface Request { auth?: AuthContext }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.header("authorization");
    if (!header?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const token = header.slice(7);
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) {
      return res.status(500).json({ error: "Server authentication is not configured safely" });
    }
    const payload = jwt.verify(token, secret) as { sub?: string };
    if (!payload.sub) return res.status(401).json({ error: "Invalid token" });

    // This starter resolves an active tenant membership from the database on every request.
    // For multi-company users, add a secure tenant-switch endpoint that verifies membership.
    const membership = await prisma.tenantMembership.findFirst({
      where: { userId: payload.sub, active: true, tenant: { status: "ACTIVE" } },
      orderBy: { createdAt: "asc" }
    });
    if (!membership) return res.status(403).json({ error: "No active company membership" });

    req.auth = { userId: payload.sub, tenantId: membership.tenantId, role: membership.role };

    // Keep the account and billing pages reachable when a trial expires, but protect ERP data routes.
    const billingPath = req.path.startsWith("/api/subscription") || req.path === "/api/me";
    if (!billingPath) {
      const current = await prisma.subscription.findFirst({
        where: { tenantId: membership.tenantId },
        include: { plan: { select: { name: true } } },
        orderBy: { createdAt: "desc" }
      });
      const entitled = !!current && (current.status === "ACTIVE" || current.status === "TRIALING") && current.periodEnd > new Date();
      if (!entitled) {
        return res.status(402).json({
          code: "SUBSCRIPTION_REQUIRED",
          error: "Your ERP trial or subscription is not active. Open Subscription to choose a plan or contact Sastha Infinite Enterprise.",
          subscriptionStatus: current?.status ?? "NONE"
        });
      }
    }
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

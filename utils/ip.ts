import { Request } from "express";

export function getRequestIp(req: Request): string {
  const forwarded = req.headers?.["x-forwarded-for"];
  if (forwarded && typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || (req.socket?.remoteAddress) || "unknown";
}

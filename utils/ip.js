export function getRequestIp(req) {
    const forwarded = req.headers?.["x-forwarded-for"];
    if (forwarded && typeof forwarded === "string") {
        return forwarded.split(",")[0].trim();
    }
    return req.ip || req.connection?.remoteAddress || "unknown";
}

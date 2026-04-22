import path from "path";
import express from "express";

export function mediaStaticMiddleware({ rootDir }: { rootDir: string }) {
  const dailyVidDir = path.join(rootDir, "daily_vid");
  const mediaDir = path.join(rootDir, "media");
  const mediaTriggersDir = path.join(rootDir, "media_triggers");

  const router = express.Router();
  router.use("/daily_vid", express.static(dailyVidDir));
  router.use("/media", express.static(mediaDir));
  router.use("/media_triggers", express.static(mediaTriggersDir));
  return router;
}

import path from "path";
import express from "express";

/**
 * Middleware para expor diretórios de mídias locais.
 * - /daily_vid -> vídeos de bom dia/boa noite
 * - /media -> mídias padrão (imagens/vídeos) já servidas pelas rotas /media, mas aqui garantimos estático se precisar
 */
export function mediaStaticMiddleware({ rootDir }) {
    const dailyVidDir = path.join(rootDir, "daily_vid");
    const mediaDir = path.join(rootDir, "media");
    const mediaTriggersDir = path.join(rootDir, "media_triggers");

    const router = express.Router();
    router.use("/daily_vid", express.static(dailyVidDir));
    router.use("/media", express.static(mediaDir));
    router.use("/media_triggers", express.static(mediaTriggersDir));
    return router;
}

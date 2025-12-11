export function registerWhatsAppLifecycle({
    client,
    log,
    generate,
    join,
    processExpiredEvents,
    startVideoCheck,
}) {
    if (!client) return;

    client.on("qr", (qr) => {
        log("QR Code gerado! Escaneie com seu WhatsApp:", "info");
        log("----------------------------------------", "info");
        // Imprime o QR diretamente no stdout para evitar interferência do logger
        generate(qr, { small: false });
        log("----------------------------------------", "info");
        log("Se o QR Code acima não estiver legível, você pode:", "info");
        log("1. Aumentar o zoom do terminal", "info");
        log("2. Copiar o QR Code e usar um leitor online", "info");
        log("3. Tentar novamente em alguns segundos", "info");
    });

    client.on("ready", async () => {
        log("Cliente WhatsApp conectado!", "success");
        log(`Diretório da sessão: ${join(process.cwd(), ".wwebjs_auth")}`, "info");

        await new Promise((resolve) => setTimeout(resolve, 5000));

        try {
            await processExpiredEvents();
        } catch (e) {
            log(
                `Erro ao processar eventos expirados na inicialização: ${e.message}`,
                "error"
            );
        }

        // Cron para eventos expirados e verificação de vídeos
        startVideoCheck();
    });
}

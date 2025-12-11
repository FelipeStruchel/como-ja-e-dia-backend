import mongoose from "mongoose";
import moment from "moment-timezone";
import "moment/locale/pt-br.js";

moment.locale("pt-br");

export async function connectDb(log, uri = process.env.MONGO_CONNECTION_STRING) {
    let connected = false;

    async function connectWithRetry(maxAttempts = 6) {
        if (!uri) {
            log("MONGO_CONNECTION_STRING não definido no .env", "warning");
            return;
        }

        const baseDelay = 2000;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                log(
                    `Tentativa de conexão ao MongoDB (${attempt}/${maxAttempts})...`,
                    "info"
                );
                await mongoose.connect(uri, {
                    serverSelectionTimeoutMS: 10000,
                    socketTimeoutMS: 45000,
                    connectTimeoutMS: 10000,
                    family: 4,
                });
                connected = true;
                log("Conectado ao MongoDB com sucesso", "success");
                return;
            } catch (err) {
                connected = false;
                log(
                    `Erro ao conectar no MongoDB (attempt ${attempt}): ${err.message}`,
                    "error"
                );
                if (attempt < maxAttempts) {
                    const delay = baseDelay * Math.pow(2, attempt - 1);
                    log(
                        `Aguardando ${Math.round(
                            delay / 1000
                        )}s antes da próxima tentativa...`,
                        "info"
                    );
                    await new Promise((resolve) => setTimeout(resolve, delay));
                } else {
                    log(
                        "Máximo de tentativas de conexão ao MongoDB atingido. Prosseguindo sem DB.",
                        "warning"
                    );
                }
            }
        }
    }

    await connectWithRetry();

    return {
        dbConnected: () => connected,
        mongoose,
        moment,
    };
}

import fs from "node:fs";
import path from "node:path";
import https from "node:https";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

const SMTC_VERSION = "v0.1.1";
const ASSET_NAME = `smtc-reader-${SMTC_VERSION}-win-x64.exe`;
const DOWNLOAD_URL = `https://github.com/Barrryy/SMTC-reader/releases/download/${SMTC_VERSION}/${ASSET_NAME}`;
const TARGET_DIR = path.join(REPO_ROOT, "com.ryan-henning.streamdeck-apple-music.sdPlugin", "bin");
const TARGET_FILE = path.join(TARGET_DIR, "smtc-reader.exe");

async function downloadFile(url, dest) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Download failed with HTTP ${res.statusCode}: ${res.statusMessage}`));
            }

            const totalBytes = parseInt(res.headers["content-length"] || "0", 10);
            let downloadedBytes = 0;
            const file = fs.createWriteStream(dest);

            res.on("data", (chunk) => {
                downloadedBytes += chunk.length;
                if (totalBytes > 0) {
                    const percent = ((downloadedBytes / totalBytes) * 100).toFixed(1);
                    process.stdout.write(`\rDownloading smtc-reader.exe... ${percent}%`);
                }
            });

            res.pipe(file);
            file.on("finish", () => {
                file.close();
                process.stdout.write("\n");
                resolve();
            });
            file.on("error", (err) => {
                fs.unlinkSync(dest);
                reject(err);
            });
        }).on("error", (err) => {
            if (fs.existsSync(dest)) fs.unlinkSync(dest);
            reject(err);
        });
    });
}

async function main() {
    if (!fs.existsSync(TARGET_DIR)) {
        fs.mkdirSync(TARGET_DIR, { recursive: true });
    }

    if (fs.existsSync(TARGET_FILE) && fs.statSync(TARGET_FILE).size > 10000000) {
        console.log(`[fetch-deps] smtc-reader.exe already exists at ${TARGET_FILE}`);
        return;
    }

    console.log(`[fetch-deps] Fetching ${ASSET_NAME} from GitHub...`);
    try {
        await downloadFile(DOWNLOAD_URL, TARGET_FILE);
        console.log(`[fetch-deps] Successfully downloaded smtc-reader.exe to ${TARGET_FILE}`);
    } catch (err) {
        console.error(`[fetch-deps] Error downloading smtc-reader:`, err.message);
        process.exit(1);
    }
}

main();

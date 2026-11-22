import { ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import streamDeck from "@elgato/streamdeck";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface SmtcTrackInfo {
    appId: string;
    appName: string;
    title: string;
    artist: string;
    albumTitle?: string;
    playbackStatus: "Playing" | "Paused" | "Stopped" | "Closed" | "Changing" | "Opened" | string;
    hasThumbnail?: boolean;
}

export type SmtcChangeCallback = (track: SmtcTrackInfo | null) => void;

/**
 * Service that wraps smtc-reader.exe to monitor Windows System Media Transport Controls
 * in real-time for currently playing media (specifically targeting Apple Music).
 */
export class SmtcService {
    private readonly exePath: string;
    private watchProcess: ChildProcess | null = null;
    private listeners = new Set<SmtcChangeCallback>();
    private currentTrack: SmtcTrackInfo | null = null;
    private buffer = "";

    constructor() {
        // smtc-reader.exe is placed beside plugin.js in bin/
        this.exePath = path.join(__dirname, "smtc-reader.exe");
    }

    /**
     * Get the latest known track info synchronously from memory.
     */
    getCurrentTrack(): SmtcTrackInfo | null {
        return this.currentTrack;
    }

    /**
     * Subscribe to real-time SMTC media updates.
     */
    addChangeListener(callback: SmtcChangeCallback): () => void {
        this.listeners.add(callback);
        if (!this.watchProcess) {
            this.startWatcher();
        }
        // Immediately fire with current state if available
        if (this.currentTrack) {
            try {
                callback(this.currentTrack);
            } catch (err) {
                streamDeck.logger.error(`Error in initial Smtc listener callback: ${err}`);
            }
        }
        return () => {
            this.listeners.delete(callback);
            if (this.listeners.size === 0) {
                this.stopWatcher();
            }
        };
    }

    private startWatcher(): void {
        if (this.watchProcess) return;

        try {
            streamDeck.logger.info("Starting smtc-reader watch process...");
            // Execute smtc-reader with JSON streaming and continuous watch
            this.watchProcess = spawn(this.exePath, ["--json", "--watch", "-i", "1"], {
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"]
            });

            this.watchProcess.stdout?.on("data", (chunk: Buffer) => {
                this.handleStdout(chunk.toString("utf8"));
            });

            this.watchProcess.stderr?.on("data", (chunk: Buffer) => {
                streamDeck.logger.debug(`[smtc-reader stderr]: ${chunk.toString("utf8").trim()}`);
            });

            this.watchProcess.on("error", (err) => {
                streamDeck.logger.error(`smtc-reader process error: ${err.message}`);
                this.stopWatcher();
            });

            this.watchProcess.on("exit", (code, signal) => {
                streamDeck.logger.info(`smtc-reader exited (code: ${code}, signal: ${signal})`);
                this.watchProcess = null;
                // Reconnect if listeners are still active
                if (this.listeners.size > 0) {
                    setTimeout(() => {
                        if (this.listeners.size > 0 && !this.watchProcess) {
                            this.startWatcher();
                        }
                    }, 3000);
                }
            });
        } catch (err: any) {
            streamDeck.logger.error(`Failed to spawn smtc-reader: ${err.message}`);
        }
    }

    private handleStdout(text: string): void {
        this.buffer += text;

        // Try to parse full JSON objects or arrays from the buffer
        let parsed = false;
        try {
            // Check if buffer contains a valid JSON array or object
            const trimmed = this.buffer.trim();
            if ((trimmed.startsWith("[") && trimmed.endsWith("]")) || (trimmed.startsWith("{") && trimmed.endsWith("}"))) {
                const data = JSON.parse(trimmed);
                this.processSessions(data);
                this.buffer = "";
                parsed = true;
            }
        } catch {
            // JSON not complete yet; keep accumulating buffer
        }

        // Safeguard buffer size
        if (!parsed && this.buffer.length > 500000) {
            this.buffer = "";
        }
    }

    private processSessions(data: any): void {
        const sessions: any[] = Array.isArray(data) ? data : [data];
        if (sessions.length === 0) {
            if (this.currentTrack !== null) {
                this.currentTrack = null;
                this.notifyListeners(null);
            }
            return;
        }

        // Prioritize Apple Music session if active, otherwise check the currently playing session
        let target = sessions.find((s) => {
            const appId = (s.appId || s.appName || "").toLowerCase();
            return appId.includes("applemusic") || appId.includes("apple music");
        });

        if (!target) {
            // Fallback to whichever session is actively Playing
            target = sessions.find((s) => s.playbackStatus === "Playing") || sessions[0];
        }

        if (!target || !target.metadata || !target.metadata.title) {
            return;
        }

        const trackInfo: SmtcTrackInfo = {
            appId: target.appId || target.appName || "",
            appName: target.appName || target.appId || "",
            title: target.metadata.title || "",
            artist: target.metadata.artist || "",
            albumTitle: target.metadata.albumTitle || "",
            playbackStatus: target.playbackStatus || "Unknown",
            hasThumbnail: Boolean(target.thumbnail?.hasThumbnail)
        };

        // Notify if track or playback state changed
        if (
            !this.currentTrack ||
            this.currentTrack.title !== trackInfo.title ||
            this.currentTrack.artist !== trackInfo.artist ||
            this.currentTrack.playbackStatus !== trackInfo.playbackStatus
        ) {
            this.currentTrack = trackInfo;
            this.notifyListeners(trackInfo);
        }
    }

    private notifyListeners(track: SmtcTrackInfo | null): void {
        for (const listener of this.listeners) {
            try {
                listener(track);
            } catch (err) {
                streamDeck.logger.error(`Error in Smtc change listener: ${err}`);
            }
        }
    }

    private stopWatcher(): void {
        if (this.watchProcess) {
            streamDeck.logger.info("Stopping smtc-reader watch process...");
            try {
                this.watchProcess.kill();
            } catch {
                // Ignore kill errors
            }
            this.watchProcess = null;
        }
        this.buffer = "";
    }
}

export const smtcService = new SmtcService();

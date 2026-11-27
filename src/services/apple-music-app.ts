import streamDeck from "@elgato/streamdeck";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { playlistItemId, readArtworkIndex } from "./playlist-artwork";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bridgeScript = path.join(pluginDir, "scripts", "apple-music-bridge.ps1");

/** Size of the cover thumbnails pushed to the touch strip, in pixels. */
const THUMB_SIZE = 144;

/** A playlist from the Apple Music app's sidebar. */
export interface AppPlaylist {
	name: string;
	/** UI Automation id of the sidebar item; used to open and play it. */
	automationId: string;
	/** Small PNG of the cover as a data URL, when the app has one cached. */
	artwork?: string;
}

type BridgeResponse = { id: number; ok: boolean; result?: unknown; error?: string };
type SidebarItem = { name: string; aid: string; isFolder: boolean };
type LibraryInfo = { myMusic: string; candidates: string[]; existing: string[] };

/**
 * Talks to the Apple Music for Windows app through a long-running PowerShell process
 * (`scripts/apple-music-bridge.ps1`) that uses Windows UI Automation. No Apple Music API key is needed:
 * playlist names come from the app's sidebar and covers from the artwork cache in the user's library.
 */
export class AppleMusicApp {
	private child: ChildProcessWithoutNullStreams | null = null;
	private ready: Promise<void> | null = null;
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
	private queue: Promise<unknown> = Promise.resolve();
	private libraryPathOverride: string | undefined;

	/** Use this `Apple Music Library.musiclibrary` folder instead of looking for it. */
	setLibraryPath(libraryPath: string | undefined): void {
		this.libraryPathOverride = libraryPath?.trim() || undefined;
	}

	/** Lists the sidebar playlists (folders left out), with their cover art where available. */
	async getPlaylists(): Promise<AppPlaylist[]> {
		const items = (await this.request<SidebarItem[]>("listPlaylists", {}, 30_000)) ?? [];
		const playlists = items.filter((i) => !i.isFolder);
		const withArt = await this.attachArtwork(playlists);
		streamDeck.logger.info(`Apple Music app: ${withArt.length} playlists, ${withArt.filter((p) => p.artwork).length} with artwork`);
		return withArt;
	}

	/** Opens the playlist in the app and presses Play (in order) or Shuffle. */
	async play(playlist: AppPlaylist, shuffle: boolean): Promise<string | null> {
		const result = await this.request<{ status: string | null }>("play", { aid: playlist.automationId, shuffle }, 20_000);
		return result?.status ?? null;
	}

	dispose(): void {
		this.child?.kill();
		this.child = null;
		this.ready = null;
	}

	private async attachArtwork(items: SidebarItem[]): Promise<AppPlaylist[]> {
		const playlists: AppPlaylist[] = items.map((i) => ({ name: i.name, automationId: i.aid }));
		try {
			const library = await this.findLibrary();
			if (!library) {
				streamDeck.logger.warn("Apple Music library folder not found; playlists will show without artwork");
				return playlists;
			}

			const ids = new Map<AppPlaylist, bigint>();
			for (const p of playlists) {
				const id = playlistItemId(p.automationId);
				if (id !== undefined) ids.set(p, id);
			}
			const covers = readArtworkIndex(library, [...ids.values()]);

			const cacheDir = path.join(process.env.LOCALAPPDATA ?? pluginDir, "streamdeck-apple-music", "thumbs");
			const jobs: { src: string; dst: string }[] = [];
			const thumbFor = new Map<AppPlaylist, string>();
			for (const [p, id] of ids) {
				const src = covers.get(id);
				if (!src) continue;
				const dst = path.join(cacheDir, `${path.parse(src).name}-${THUMB_SIZE}.png`);
				thumbFor.set(p, dst);
				if (!existsSync(dst)) jobs.push({ src, dst });
			}
			if (jobs.length > 0) {
				await this.request("thumbnails", { items: jobs, size: THUMB_SIZE }, 60_000);
			}
			for (const [p, file] of thumbFor) {
				if (existsSync(file)) {
					p.artwork = `data:image/png;base64,${readFileSync(file).toString("base64")}`;
				}
			}
		} catch (err) {
			streamDeck.logger.warn(`Could not load playlist artwork: ${(err as Error).message}`);
		}
		return playlists;
	}

	private async findLibrary(): Promise<string | undefined> {
		if (this.libraryPathOverride) {
			return this.libraryPathOverride;
		}
		const info = await this.request<LibraryInfo>("libraryInfo", {}, 10_000);
		return info?.existing?.[0];
	}

	private request<T>(cmd: string, args: object, timeoutMs: number): Promise<T> {
		// The bridge handles one command at a time; queue so a dial press never interleaves with a refresh.
		const run = async (): Promise<T> => {
			await this.start();
			const id = this.nextId++;
			return new Promise<T>((resolve, reject) => {
				const timer = setTimeout(() => {
					this.pending.delete(id);
					reject(new Error(`Apple Music bridge timed out on ${cmd}`));
					// A stuck UI Automation call would block every later command, so start over.
					this.dispose();
				}, timeoutMs);
				this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
				this.child!.stdin.write(JSON.stringify({ id, cmd, args }) + "\n");
			});
		};
		const result = this.queue.then(run, run);
		this.queue = result.catch(() => undefined);
		return result;
	}

	private start(): Promise<void> {
		if (this.ready) return this.ready;
		if (process.platform !== "win32") {
			return Promise.reject(new Error("The Apple Music app bridge only runs on Windows"));
		}

		const child = spawn(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", bridgeScript],
			{ windowsHide: true }
		);
		this.child = child;

		this.ready = new Promise<void>((resolve, reject) => {
			const startTimer = setTimeout(() => reject(new Error("Apple Music bridge did not start")), 15_000);
			createInterface({ input: child.stdout }).on("line", (line) => {
				let msg: BridgeResponse;
				try {
					msg = JSON.parse(line);
				} catch {
					streamDeck.logger.debug(`bridge: ${line}`);
					return;
				}
				if (msg.id === 0) {
					clearTimeout(startTimer);
					resolve();
					return;
				}
				const waiter = this.pending.get(msg.id);
				if (!waiter) return;
				this.pending.delete(msg.id);
				clearTimeout(waiter.timer);
				if (msg.ok) waiter.resolve(msg.result);
				else waiter.reject(new Error(msg.error ?? "Apple Music bridge error"));
			});
			child.stderr.on("data", (d) => streamDeck.logger.warn(`bridge stderr: ${String(d).trim()}`));
			child.on("exit", (code) => {
				clearTimeout(startTimer);
				reject(new Error(`Apple Music bridge exited (${code})`));
				for (const [, w] of this.pending) {
					clearTimeout(w.timer);
					w.reject(new Error("Apple Music bridge exited"));
				}
				this.pending.clear();
				if (this.child === child) {
					this.child = null;
					this.ready = null;
				}
			});
		});
		return this.ready;
	}
}

export const appleMusicApp = new AppleMusicApp();

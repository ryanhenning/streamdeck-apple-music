import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import streamDeck from "@elgato/streamdeck";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface PlaylistSummary {
	id: string;
	name: string;
	description?: string;
	trackCount?: number;
	artworkUrl?: string;
	playUrl?: string;
}

export interface AppleMusicTokens {
	developerToken?: string;
	userToken?: string;
}

export class AppleMusicService {
	private developerToken: string = "";
	private userToken: string = "";
	private playlistCache: PlaylistSummary[] = [];
	private lastFetchTime: number = 0;

	constructor() {
		this.loadLocalConfig();
	}

	public setTokens(tokens: AppleMusicTokens): void {
		if (tokens.developerToken) {
			let dev = tokens.developerToken.trim();
			// Strip leading 'Bearer ' if the user pasted it with the Bearer keyword
			if (dev.toLowerCase().startsWith("bearer ")) {
				dev = dev.slice(7).trim();
			}
			this.developerToken = dev;
		}
		if (tokens.userToken) {
			this.userToken = tokens.userToken.trim();
		}
	}

	private loadLocalConfig(): void {
		try {
			// Check both current working directory and beside the plugin directory
			const candidates = [
				path.resolve(process.cwd(), "config.local.json"),
				path.resolve(__dirname, "..", "config.local.json"),
				path.resolve(__dirname, "config.local.json")
			];

			for (const configPath of candidates) {
				if (fs.existsSync(configPath)) {
					const content = fs.readFileSync(configPath, "utf-8");
					const json = JSON.parse(content);
					if (json.developerToken) {
						let dev = json.developerToken.trim();
						if (dev.toLowerCase().startsWith("bearer ")) dev = dev.slice(7).trim();
						this.developerToken = dev;
					}
					if (json.userToken) this.userToken = json.userToken.trim();
					streamDeck.logger.info(`Loaded Apple Music credentials from: ${configPath}`);
					break;
				}
			}
		} catch (err) {
			streamDeck.logger.warn("Could not load config.local.json: " + (err as Error).message);
		}
	}

	public hasValidTokens(): boolean {
		return Boolean(this.developerToken && this.userToken);
	}

	public async getPlaylists(forceRefresh = false): Promise<PlaylistSummary[]> {
		const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minute cache
		if (!forceRefresh && this.playlistCache.length > 0 && Date.now() - this.lastFetchTime < CACHE_TTL_MS) {
			return this.playlistCache;
		}

		if (!this.hasValidTokens()) {
			throw new Error("Apple Music developerToken or userToken is missing.");
		}

		const data = await this.apiRequest<{ data: Array<{ id: string; attributes: { name: string; description?: { standard?: string }; trackCount?: number; artwork?: { url: string }; playParams?: { id: string; globalId?: string; kind: string } } }> }>("/v1/me/library/playlists?limit=50");

		if (!data?.data) {
			return this.playlistCache;
		}

		this.playlistCache = data.data.map((item) => {
			let artwork: string | undefined;
			if (item.attributes.artwork?.url) {
				artwork = item.attributes.artwork.url.replace("{w}", "200").replace("{h}", "100");
			}

			// Prefer catalog globalId for deep-linking via music:// URI scheme.
			// Library-local p. IDs don't work with the Windows Apple Music app.
			const globalId = item.attributes.playParams?.globalId;
			const playUrl = globalId
				? `music://music.apple.com/playlist/${globalId}`
				: `https://music.apple.com/library/playlist/${item.id}`;

			return {
				id: item.id,
				name: item.attributes.name,
				description: item.attributes.description?.standard,
				trackCount: item.attributes.trackCount,
				artworkUrl: artwork,
				playUrl
			};
		});

		this.lastFetchTime = Date.now();
		return this.playlistCache;
	}

	public async searchSong(term: string): Promise<{ id: string; name: string; artistName: string } | null> {
		if (!this.hasValidTokens()) {
			throw new Error("Tokens missing for searchSong.");
		}

		const encoded = encodeURIComponent(term);
		const data = await this.apiRequest<{
			results?: {
				songs?: {
					data?: Array<{ id: string; attributes: { name: string; artistName: string } }>;
				};
			};
		}>(`/v1/catalog/us/search?term=${encoded}&types=songs&limit=1`);

		const song = data?.results?.songs?.data?.[0];
		if (!song) return null;

		return {
			id: song.id,
			name: song.attributes.name,
			artistName: song.attributes.artistName
		};
	}

	public async favoriteTrack(songId: string): Promise<boolean> {
		if (!this.hasValidTokens()) {
			throw new Error("Tokens missing for favoriting track.");
		}

		const body = JSON.stringify({
			type: "ratings",
			attributes: {
				value: 1
			}
		});

		const res = await this.apiRequest<{ data: unknown }>(`/v1/me/ratings/songs/${songId}`, "PUT", body);
		return Boolean(res);
	}

	private apiRequest<T>(endpoint: string, method = "GET", body?: string): Promise<T> {
		return new Promise((resolve, reject) => {
			const options: https.RequestOptions = {
				hostname: "amp-api.music.apple.com",
				path: endpoint,
				method,
				headers: {
					Authorization: `Bearer ${this.developerToken}`,
					"Music-User-Token": this.userToken,
					Origin: "https://music.apple.com",
					Referer: "https://music.apple.com/",
					...(body ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } : {})
				}
			};

			const req = https.request(options, (res) => {
				let responseData = "";
				res.on("data", (chunk) => (responseData += chunk));
				res.on("end", () => {
					if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
						try {
							resolve(JSON.parse(responseData) as T);
						} catch {
							resolve({} as T);
						}
					} else {
						reject(new Error(`Apple Music API returned ${res.statusCode}: ${responseData}`));
					}
				});
			});

			req.on("error", (err) => reject(err));
			if (body) req.write(body);
			req.end();
		});
	}
}

export const appleMusic = new AppleMusicService();

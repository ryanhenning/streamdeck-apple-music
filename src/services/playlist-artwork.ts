import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Pulls the persistent playlist ID out of an Apple Music sidebar AutomationId, e.g.
 * `DBID:0xe81c736ed43d09f7-PID:0x35f82ce9d2c85caa-PPID:0x0-PIPID:0x0-IKIND:ePlaylist` and returns it the
 * way `artwork.sqlite` stores it: as a signed 64-bit integer.
 */
export function playlistItemId(automationId: string): bigint | undefined {
	const match = /(?:^|-)PID:0x([0-9a-f]{1,16})(?:-|$)/i.exec(automationId);
	if (!match) {
		return undefined;
	}
	return BigInt.asIntN(64, BigInt(`0x${match[1]}`));
}

/** Path of the cached cover for one item, keyed by its `item_to_artwork.item_id`. */
export type ArtworkIndex = Map<bigint, string>;

/**
 * Reads `artwork.sqlite` from an `Apple Music Library.musiclibrary` folder and maps each requested item ID
 * to its cached JPEG in the library's `artwork` folder. The app keeps the database open, so it is copied
 * (with its WAL) to a temp folder first and the copy is opened read-only.
 */
export function readArtworkIndex(libraryPath: string, itemIds: bigint[]): ArtworkIndex {
	const index: ArtworkIndex = new Map();
	const dbPath = path.join(libraryPath, "artwork.sqlite");
	if (itemIds.length === 0 || !existsSync(dbPath)) {
		return index;
	}

	const scratch = mkdtempSync(path.join(tmpdir(), "am-artwork-"));
	try {
		const copy = path.join(scratch, "artwork.sqlite");
		copyFileSync(dbPath, copy);
		for (const suffix of ["-wal", "-shm"]) {
			if (existsSync(dbPath + suffix)) {
				copyFileSync(dbPath + suffix, copy + suffix);
			}
		}

		const db = new DatabaseSync(copy, { readOnly: true });
		try {
			const query = db.prepare(
				`SELECT i.artwork_id AS artworkId, ci.size_kind AS sizeKind, ci.extension AS extension
				   FROM item_to_artwork i
				   JOIN cache_items ci ON ci.artwork_id = i.artwork_id
				  WHERE i.item_id = ?
				  ORDER BY ci.size_kind DESC`
			);
			query.setReadBigInts(true);
			for (const id of itemIds) {
				for (const row of query.all(id) as { artworkId: string; sizeKind: bigint; extension: string | null }[]) {
					const file = path.join(libraryPath, "artwork", `${row.artworkId}_sk${row.sizeKind}.${row.extension ?? "jpeg"}`);
					if (existsSync(file)) {
						index.set(id, file);
						break;
					}
				}
			}
		} finally {
			db.close();
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
	return index;
}

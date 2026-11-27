import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { playlistItemId, readArtworkIndex } from "../src/services/playlist-artwork";
import { truncate, wrapIndex } from "../src/actions/playlist-dial-helpers";

describe("playlistItemId", () => {
	it("reads the PID as a signed 64-bit integer", () => {
		// Example from a real library: Power Pop Essentials.
		expect(playlistItemId("DBID:0xe81c736ed43d09f7-PID:0x994808321cda20bc-PPID:0x0-PIPID:0x0-IKIND:ePlaylist")).toBe(-7401656976257965892n);
		expect(playlistItemId("DBID:0xe81c736ed43d09f7-PID:0x35f82ce9d2c85caa-PPID:0x0-PIPID:0x0-IKIND:ePlaylist")).toBe(0x35f82ce9d2c85caan);
	});

	it("does not confuse PPID or PIPID with PID", () => {
		expect(playlistItemId("PPID:0x5-PIPID:0x6")).toBeUndefined();
		expect(playlistItemId("Sidebar_AllPlaylists")).toBeUndefined();
	});
});

describe("readArtworkIndex", () => {
	it("maps item ids to cached JPEGs that exist", () => {
		const lib = mkdtempSync(path.join(tmpdir(), "lib-"));
		mkdirSync(path.join(lib, "artwork"));
		const db = new DatabaseSync(path.join(lib, "artwork.sqlite"));
		db.exec(`CREATE TABLE cache_items (artwork_id TEXT NOT NULL, size_kind INTEGER NOT NULL, extension TEXT, image_hash TEXT, width INTEGER, height INTEGER, status INTEGER NOT NULL, PRIMARY KEY (artwork_id,size_kind));
			CREATE TABLE item_to_artwork (item_id INTEGER NOT NULL, source_kind INTEGER NOT NULL, remote_id INTEGER DEFAULT 0, artwork_id TEXT NOT NULL, PRIMARY KEY (item_id));`);
		db.prepare("INSERT INTO item_to_artwork VALUES (?, 63, 0, ?)").run(-7401656976257965892n, "AAA");
		db.prepare("INSERT INTO item_to_artwork VALUES (?, 63, 0, ?)").run(42n, "BBB");
		db.prepare("INSERT INTO cache_items VALUES (?, 1, 'jpeg', '', 1200, 1200, 1)").run("AAA");
		db.prepare("INSERT INTO cache_items VALUES (?, 1, 'jpeg', '', 1200, 1200, 1)").run("BBB");
		db.close();
		writeFileSync(path.join(lib, "artwork", "AAA_sk1.jpeg"), "x");

		const index = readArtworkIndex(lib, [-7401656976257965892n, 42n, 7n]);
		expect(index.get(-7401656976257965892n)).toBe(path.join(lib, "artwork", "AAA_sk1.jpeg"));
		expect(index.has(42n)).toBe(false); // row exists but file is missing
		expect(index.has(7n)).toBe(false);
	});

	it("returns nothing when the library has no artwork database", () => {
		expect(readArtworkIndex(mkdtempSync(path.join(tmpdir(), "lib-")), [1n]).size).toBe(0);
	});
});

describe("dial helpers", () => {
	it("wraps in both directions", () => {
		expect(wrapIndex(-1, 5)).toBe(4);
		expect(wrapIndex(7, 5)).toBe(2);
		expect(wrapIndex(3, 0)).toBe(0);
	});
	it("truncates with an ellipsis", () => {
		expect(truncate("Power Pop Essentials", 14)).toBe("Power Pop Ess…");
		expect(truncate("Get Up!", 14)).toBe("Get Up!");
	});
});

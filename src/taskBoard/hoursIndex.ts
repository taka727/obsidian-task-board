import { App, TFile } from 'obsidian';

// 日次ノートの「今日の作業時間（案件ごと）」に書く工数行の形式:
//   - [[案件名]]  (hours:: 1.5)
// Dataviewのインラインフィールド自動認識規則（丸括弧/角括弧で包まれた場合のみ認識）を
// そのまま踏襲した記法。元々はdataviewjsの`item.outlinks`/`item.hours`で読んでいたが、
// dataviewjs（任意コードの実行環境、fetch()等も書けてしまう）への依存を断つため、
// 自作プラグイン側の正規表現パーサーに置き換えた。
const HOURS_LINE_RE = /\(hours::\s*([0-9]+(?:\.[0-9]+)?)\)/;
const WIKILINK_RE = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;

export interface HourEntry {
	projectPath: string;
	hours: number;
}

// 1行から工数エントリを抽出する。行内に複数の[[リンク]]がある場合は
// 元のdataviewjs実装（item.outlinksをループ）と同じく、全リンクに同じ時間を計上する。
export function parseHourEntriesFromLine(
	app: App,
	line: string,
	sourcePath: string,
): HourEntry[] {
	const hoursMatch = HOURS_LINE_RE.exec(line);
	if (!hoursMatch) return [];
	const hours = Number(hoursMatch[1]);
	if (Number.isNaN(hours)) return [];

	const entries: HourEntry[] = [];
	WIKILINK_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = WIKILINK_RE.exec(line))) {
		const dest = app.metadataCache.getFirstLinkpathDest(match[1]!, sourcePath);
		if (dest) entries.push({ projectPath: dest.path, hours });
	}
	return entries;
}

// 指定ファイル内の全リスト行から工数エントリを収集する。
export async function collectHourEntriesInFile(
	app: App,
	file: TFile,
): Promise<HourEntry[]> {
	const content = await app.vault.cachedRead(file);
	const entries: HourEntry[] = [];
	for (const line of content.split('\n')) {
		entries.push(...parseHourEntriesFromLine(app, line, file.path));
	}
	return entries;
}

// 案件（ファイルパス）ごとに工数を合算する。同じ案件が複数行に分かれていても1つにまとめる。
export function sumHoursByProject(entries: HourEntry[]): Map<string, number> {
	const totals = new Map<string, number>();
	for (const entry of entries) {
		totals.set(entry.projectPath, (totals.get(entry.projectPath) ?? 0) + entry.hours);
	}
	return totals;
}

export function roundHours(hours: number): number {
	return Math.round(hours * 10) / 10;
}

export function projectLabelFromPath(path: string): string {
	const base = path.split('/').pop() ?? path;
	return base.replace(/\.md$/, '');
}

import { App } from 'obsidian';

const HOLIDAYS_PATH = '_data/holidays.json';

// _data/holidays.json（"YYYY-MM-DD": "祝日名"のフラットなJSON）を読み込む。
// ダッシュボード.mdのdataviewjsブロックと同じ挙動：読み込めない場合は土日のみを非営業日とみなす。
export async function loadHolidays(app: App): Promise<Record<string, string>> {
	try {
		const raw = await app.vault.adapter.read(HOLIDAYS_PATH);
		return JSON.parse(raw) as Record<string, string>;
	} catch {
		return {};
	}
}

export function isBusinessDay(
	dateISO: string,
	holidays: Record<string, string>,
): boolean {
	const dow = new Date(`${dateISO}T00:00:00`).getDay();
	if (dow === 0 || dow === 6) return false;
	return !Object.prototype.hasOwnProperty.call(holidays, dateISO);
}

export function todayISO(): string {
	const d = new Date();
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	return `${d.getFullYear()}-${mm}-${dd}`;
}

export function daysBetween(fromISO: string, toISO: string): number {
	const from = new Date(`${fromISO}T00:00:00`);
	const to = new Date(`${toISO}T00:00:00`);
	return Math.round((to.getTime() - from.getTime()) / 86400000);
}

// 完了列の「直近」判定に使う。完了日（✅）が未記録のタスク（完了日の自動記録より前に
// 完了した分）は、直近ではなく古い扱いにして折りたたみ側へ回す。
export function isWithinRecentDays(
	dateISO: string | null,
	days: number,
): boolean {
	if (!dateISO) return false;
	// 未来日（手で先付けした場合など）も「直近」に含める。
	return daysBetween(dateISO, todayISO()) < days;
}

export type DueUrgency = 'overdue' | 'soon' | 'normal';

export function getDueUrgency(
	dueDateISO: string | null,
	thresholdDays = 3,
): DueUrgency | null {
	if (!dueDateISO) return null;
	const diff = daysBetween(todayISO(), dueDateISO);
	if (diff < 0) return 'overdue';
	if (diff <= thresholdDays) return 'soon';
	return 'normal';
}

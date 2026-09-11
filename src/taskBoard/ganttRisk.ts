import { App } from 'obsidian';
import { todayISO } from './dateUtils';
import { TaskItem } from './types';

export type RiskLevel = 'warning' | 'danger';

export interface GanttRisk {
	level: RiskLevel;
	message: string;
	filePath: string | null;
	line: number | null;
}

const OVERLAP_THRESHOLD = 3;

// 案件ノート（03_Projects配下）のフロントマターdue_dateを案件名→期日のマップにして返す。
// 案件の実質的な期限を超えるタスクの検出に使う。
export function loadProjectDueDates(
	app: App,
	projectsFolder: string,
): Map<string, string> {
	const map = new Map<string, string>();
	const prefix = `${projectsFolder}/`;
	for (const file of app.vault.getMarkdownFiles()) {
		if (!file.path.startsWith(prefix)) continue;
		const dueDate = app.metadataCache.getFileCache(file)?.frontmatter?.due_date as
			| string
			| undefined;
		if (dueDate) map.set(file.basename, dueDate);
	}
	return map;
}

export function computeRisks(
	tasks: TaskItem[],
	projectDueDates: Map<string, string>,
): GanttRisk[] {
	const risks: GanttRisk[] = [];
	const today = todayISO();

	for (const task of tasks) {
		if (task.status === 'done') continue;

		if (task.startDate && task.dueDate && task.startDate > task.dueDate) {
			risks.push({
				level: 'danger',
				message: `「${task.text}」は開始日(${task.startDate})が期日(${task.dueDate})より後になっています`,
				filePath: task.filePath,
				line: task.line,
			});
		}

		if (
			task.startDate &&
			(task.status === 'todo' || task.status === 'backlog') &&
			task.startDate < today
		) {
			risks.push({
				level: 'warning',
				message: `「${task.text}」は開始日(${task.startDate})を過ぎていますが未着手です`,
				filePath: task.filePath,
				line: task.line,
			});
		}

		if (task.dueDate && task.dueDate < today) {
			const reasonNote = task.delayReason
				? `理由: ${task.delayReason}`
				: '理由未記入';
			risks.push({
				level: 'danger',
				message: `「${task.text}」は期日(${task.dueDate})を超過しています（${reasonNote}）`,
				filePath: task.filePath,
				line: task.line,
			});
		}

		if (task.project && task.dueDate) {
			const projectDue = projectDueDates.get(task.project);
			if (projectDue && task.dueDate > projectDue) {
				risks.push({
					level: 'warning',
					message: `「${task.text}」の期日(${task.dueDate})が案件「${task.project}」の期限(${projectDue})を超えています`,
					filePath: task.filePath,
					line: task.line,
				});
			}
		}
	}

	risks.push(...computeOverlapRisks(tasks));

	return risks;
}

function computeOverlapRisks(tasks: TaskItem[]): GanttRisk[] {
	const ranged = tasks.filter(
		(t): t is TaskItem & { startDate: string; dueDate: string } =>
			t.status !== 'done' && !!t.startDate && !!t.dueDate && t.startDate <= t.dueDate,
	);
	if (ranged.length === 0) return [];

	const counts = new Map<string, TaskItem[]>();
	for (const task of ranged) {
		for (const day of eachDay(task.startDate, task.dueDate)) {
			const list = counts.get(day) ?? [];
			list.push(task);
			counts.set(day, list);
		}
	}

	const risks: GanttRisk[] = [];
	for (const [day, dayTasks] of counts) {
		if (dayTasks.length >= OVERLAP_THRESHOLD) {
			risks.push({
				level: 'warning',
				message: `${day} に${dayTasks.length}件のタスクが並行しています（${dayTasks
					.map((t) => t.text)
					.join('、')}）`,
				filePath: null,
				line: null,
			});
		}
	}
	return risks;
}

// toISOString()（UTC基準）は使わない：ローカル日付をUTC変換すると、タイムゾーンによっては
// 日付が前後にずれてしまう（dateUtils.tsのtodayISO()と同じくローカルの年月日をそのまま使う）。
function formatISO(d: Date): string {
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	return `${d.getFullYear()}-${mm}-${dd}`;
}

function eachDay(fromISO: string, toISO: string): string[] {
	const days: string[] = [];
	const from = new Date(`${fromISO}T00:00:00`);
	const to = new Date(`${toISO}T00:00:00`);
	for (const d = from; d <= to; d.setDate(d.getDate() + 1)) {
		days.push(formatISO(d));
	}
	return days;
}

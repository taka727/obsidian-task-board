import { GanttRisk } from './ganttRisk';
import { TaskItem, TaskStatus } from './types';

export type ExportFormat = 'markdown' | 'csv';

const EXPORT_STATUS_LABELS: Partial<Record<TaskStatus, string>> = {
	todo: '未着手',
	doing: '進行中',
	hold: '保留',
	done: '完了',
};

const EXPORT_HEADER = [
	'案件',
	'タスク',
	'ステータス',
	'開始日(予定)',
	'期日(予定)',
	'実績開始',
	'実績完了',
	'遅延理由',
];

const NO_PROJECT_LABEL = '（案件なし）';

export function buildExportRows(tasks: TaskItem[]): string[][] {
	const sorted = [...tasks].sort((a, b) => {
		const aKey = a.startDate ?? a.dueDate ?? '9999-99-99';
		const bKey = b.startDate ?? b.dueDate ?? '9999-99-99';
		return aKey.localeCompare(bKey);
	});
	const body = sorted.map((task) => [
		task.project ?? NO_PROJECT_LABEL,
		task.text || '(no text)',
		EXPORT_STATUS_LABELS[task.status] ?? task.status,
		task.startDate ?? '',
		task.dueDate ?? '',
		task.startedAt ?? '',
		task.completedAt ?? '',
		task.delayReason ?? '',
	]);
	return [EXPORT_HEADER, ...body];
}

function csvEscape(value: string): string {
	if (/[",\n]/.test(value)) {
		return `"${value.replace(/"/g, '""')}"`;
	}
	return value;
}

export function toCSV(rows: string[][]): string {
	return rows.map((row) => row.map(csvEscape).join(',')).join('\n');
}

export function toMarkdown(rows: string[][], risks: GanttRisk[], title: string): string {
	const [header, ...body] = rows;
	if (!header) return `# ${title}\n`;

	const escapeCell = (cell: string) => cell.replace(/\|/g, '\\|').replace(/\n/g, ' ');
	const lines: string[] = [`# ${title}`, ''];
	lines.push(`| ${header.map(escapeCell).join(' | ')} |`);
	lines.push(`| ${header.map(() => '---').join(' | ')} |`);
	body.forEach((row) => {
		lines.push(`| ${row.map(escapeCell).join(' | ')} |`);
	});

	lines.push('', `## ⚠️ リスク・注意事項 (${risks.length})`);
	if (risks.length === 0) {
		lines.push('検出されたリスクはありません');
	} else {
		risks.forEach((risk) => {
			lines.push(`- ${risk.level === 'danger' ? '🔴' : '🟠'} ${risk.message}`);
		});
	}
	lines.push('');

	return lines.join('\n');
}

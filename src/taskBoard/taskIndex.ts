import { App } from 'obsidian';
import { TaskItem, TaskPriority, TaskStatus } from './types';

export const TASK_LINE_RE = /^(\s*[-*]\s\[)([ xX])(\]\s*)(.*)$/;

export const STATUS_TAGS: Record<Exclude<TaskStatus, 'backlog'>, string> = {
	todo: 'todo',
	doing: 'doing',
	hold: 'hold',
	done: 'done',
};

// 案件ラベルは本物の [[wikilink]] として保存する。プレーンテキストの
// #project/名前 だとObsidianのノートリネーム時のリンク自動更新が効かず、
// 案件ノートを改名してもラベル側に反映されない不具合があったため。
const PROJECT_LINK_RE = /project::\s*\[\[([^\]|#]+)(?:\|[^\]]*)?\]\]/i;
// 旧形式（#project/名前）は読み取り互換のためだけに残す。保存時は使わない。
const PROJECT_LEGACY_RE = /#project\/(\S+)/i;
const PRIORITY_RE = /#priority\/(high|mid|low)\b/i;
const START_DATE_RE = /🛫(\d{4}-\d{2}-\d{2})/;
const STARTED_RE = /⏱️(\d{4}-\d{2}-\d{2})/;
const COMPLETED_RE = /✅(\d{4}-\d{2}-\d{2})/;
const DUE_RE = /📅(\d{4}-\d{2}-\d{2})/;
// 遅延理由は角括弧で包んだインラインフィールドとして保存する（Dataviewのインラインフィールド
// 自動認識が角括弧/丸括弧での包み込みを要求するため、将来Dataviewから読む場合にも対応できる形）。
const DELAY_RE = /\[delay::\s*([^\]]*)\]/i;
const ALL_MARKERS_RE =
	/#(?:todo|doing|hold|done)\b|project::\s*\[\[[^\]]+\]\]|#project\/\S+|#priority\/(?:high|mid|low)\b|🛫\d{4}-\d{2}-\d{2}|⏱️\d{4}-\d{2}-\d{2}|✅\d{4}-\d{2}-\d{2}|📅\d{4}-\d{2}-\d{2}|\[delay::[^\]]*\]/gi;

export interface ParsedTaskLine {
	status: TaskStatus;
	text: string;
	project: string | null;
	priority: TaskPriority | null;
	startDate: string | null;
	startedAt: string | null;
	completedAt: string | null;
	dueDate: string | null;
	delayReason: string | null;
}

function parseStatus(checked: boolean, rawText: string): TaskStatus {
	if (checked) return 'done';
	if (/#done\b/i.test(rawText)) return 'done';
	if (/#doing\b/i.test(rawText)) return 'doing';
	if (/#hold\b/i.test(rawText)) return 'hold';
	if (/#todo\b/i.test(rawText)) return 'todo';
	return 'backlog';
}

export function parseTaskLine(checked: boolean, rawText: string): ParsedTaskLine {
	const status = parseStatus(checked, rawText);
	const project =
		PROJECT_LINK_RE.exec(rawText)?.[1] ??
		PROJECT_LEGACY_RE.exec(rawText)?.[1] ??
		null;
	const priority =
		(PRIORITY_RE.exec(rawText)?.[1] as TaskPriority | undefined) ?? null;
	const startDate = START_DATE_RE.exec(rawText)?.[1] ?? null;
	const startedAt = STARTED_RE.exec(rawText)?.[1] ?? null;
	const completedAt = COMPLETED_RE.exec(rawText)?.[1] ?? null;
	const dueDate = DUE_RE.exec(rawText)?.[1] ?? null;
	const delayReason = DELAY_RE.exec(rawText)?.[1]?.trim() || null;
	const text = rawText.replace(ALL_MARKERS_RE, '').replace(/\s{2,}/g, ' ').trim();
	return {
		status,
		text,
		project,
		priority,
		startDate,
		startedAt,
		completedAt,
		dueDate,
		delayReason,
	};
}

// インデントが深いチェックボックス行は、直近の親タスク（トップレベルの行）の
// 子タスクとして扱う。孫タスクも同じ親のサブタスクとしてフラットに扱う。
export async function collectTasks(app: App): Promise<TaskItem[]> {
	const tasks: TaskItem[] = [];
	for (const file of app.vault.getMarkdownFiles()) {
		const content = await app.vault.cachedRead(file);
		const lines = content.split('\n');
		let parent: TaskItem | null = null;
		let parentIndent = -1;
		lines.forEach((line, index) => {
			const match = TASK_LINE_RE.exec(line);
			if (!match) return;
			const indent = /^\s*/.exec(line)![0].length;
			const checked = match[2]!.toLowerCase() === 'x';

			if (parent && indent > parentIndent) {
				const child = parseTaskLine(checked, match[4]!);
				parent.subtasks.push({
					line: index,
					checked,
					text: child.text,
					startDate: child.startDate,
					dueDate: child.dueDate,
				});
				return;
			}

			const parsed = parseTaskLine(checked, match[4]!);
			const task: TaskItem = {
				filePath: file.path,
				line: index,
				checked,
				...parsed,
				subtasks: [],
			};
			tasks.push(task);
			parent = task;
			parentIndent = indent;
		});
	}
	return tasks;
}

export function listProjectNames(app: App, projectsFolder: string): string[] {
	const prefix = `${projectsFolder}/`;
	return app.vault
		.getMarkdownFiles()
		.filter((f) => f.path.startsWith(prefix))
		.map((f) => f.basename)
		.sort((a, b) => a.localeCompare(b, 'ja'));
}

// 小チケットの開閉状態などをビュー側で覚えておくためのキー。
// 行番号は小タスクの追加・削除でずれるため、ファイルパスと本文で識別する。
export function taskKey(task: TaskItem): string {
	return `${task.filePath}::${task.text}`;
}

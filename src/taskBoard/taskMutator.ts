import { App, TFile } from 'obsidian';
import { todayISO } from './dateUtils';
import { STATUS_TAGS, TASK_LINE_RE, parseTaskLine } from './taskIndex';
import { SubTaskFields, TaskFields, TaskStatus } from './types';

export function buildLine(
	prefix: string,
	suffix: string,
	checked: boolean,
	fields: TaskFields,
	status: TaskStatus,
	startedAt: string | null,
	completedAt: string | null,
): string {
	const checkbox = checked ? 'x' : ' ';
	const parts: string[] = [fields.text];
	if (status !== 'backlog') parts.push(`#${STATUS_TAGS[status]}`);
	if (fields.project) parts.push(`project:: [[${fields.project}]]`);
	if (fields.priority) parts.push(`#priority/${fields.priority}`);
	if (fields.startDate) parts.push(`🛫${fields.startDate}`);
	if (startedAt) parts.push(`⏱️${startedAt}`);
	if (completedAt) parts.push(`✅${completedAt}`);
	if (fields.dueDate) parts.push(`📅${fields.dueDate}`);
	if (fields.delayReason) parts.push(`[delay:: ${fields.delayReason}]`);
	return `${prefix}${checkbox}${suffix}${parts.join(' ')}`;
}

// 小タスク行は案件・重要度・ステータスを持たず、日程マーカーのみを扱う
// （案件とステータスは親タスクから引き継ぐ想定）。
export function buildSubtaskLine(
	prefix: string,
	suffix: string,
	checked: boolean,
	fields: SubTaskFields,
): string {
	const parts: string[] = [fields.text];
	if (fields.startDate) parts.push(`🛫${fields.startDate}`);
	if (fields.dueDate) parts.push(`📅${fields.dueDate}`);
	return `${prefix}${checked ? 'x' : ' '}${suffix}${parts.join(' ')}`;
}

async function getFile(app: App, filePath: string): Promise<TFile> {
	const file = app.vault.getAbstractFileByPath(filePath);
	if (!(file instanceof TFile)) {
		throw new Error(`Task file not found: ${filePath}`);
	}
	return file;
}

export async function moveTask(
	app: App,
	filePath: string,
	line: number,
	status: TaskStatus,
): Promise<void> {
	const file = await getFile(app, filePath);
	const content = await app.vault.read(file);
	const lines = content.split('\n');
	const match = TASK_LINE_RE.exec(lines[line] ?? '');
	if (!match) return;
	const prefix = match[1]!;
	const suffix = match[3]!;
	const checked = match[2]!.toLowerCase() === 'x';
	const parsed = parseTaskLine(checked, match[4]!);

	let startedAt = parsed.startedAt;
	if (status === 'doing' && parsed.status !== 'doing') {
		startedAt = todayISO();
	} else if (status === 'todo' || status === 'hold' || status === 'backlog') {
		startedAt = null;
	}

	let completedAt = parsed.completedAt;
	if (status === 'done' && parsed.status !== 'done') {
		completedAt = todayISO();
	} else if (status !== 'done') {
		completedAt = null;
	}

	lines[line] = buildLine(
		prefix,
		suffix,
		status === 'done',
		{
			text: parsed.text,
			project: parsed.project,
			priority: parsed.priority,
			dueDate: parsed.dueDate,
			startDate: parsed.startDate,
			delayReason: parsed.delayReason,
		},
		status,
		startedAt,
		completedAt,
	);
	await app.vault.modify(file, lines.join('\n'));
}

export async function editTask(
	app: App,
	filePath: string,
	line: number,
	fields: TaskFields,
): Promise<void> {
	const file = await getFile(app, filePath);
	const content = await app.vault.read(file);
	const lines = content.split('\n');
	const match = TASK_LINE_RE.exec(lines[line] ?? '');
	if (!match) return;
	const prefix = match[1]!;
	const checkedChar = match[2]!;
	const suffix = match[3]!;
	const checked = checkedChar.toLowerCase() === 'x';
	const parsed = parseTaskLine(checked, match[4]!);
	lines[line] = buildLine(
		prefix,
		suffix,
		checked,
		fields,
		parsed.status,
		parsed.startedAt,
		parsed.completedAt,
	);
	await app.vault.modify(file, lines.join('\n'));
}

export async function deleteTask(
	app: App,
	filePath: string,
	line: number,
): Promise<void> {
	const file = await getFile(app, filePath);
	const content = await app.vault.read(file);
	const lines = content.split('\n');
	lines.splice(line, 1);
	await app.vault.modify(file, lines.join('\n'));
}

export async function removeLines(
	app: App,
	filePath: string,
	lines: number[],
): Promise<void> {
	const file = await getFile(app, filePath);
	const content = await app.vault.read(file);
	const arr = content.split('\n');
	for (const line of [...lines].sort((a, b) => b - a)) {
		arr.splice(line, 1);
	}
	await app.vault.modify(file, arr.join('\n'));
}

export async function appendRawLines(
	app: App,
	filePath: string,
	lines: string[],
): Promise<void> {
	const file = await getFile(app, filePath);
	const content = await app.vault.read(file);
	const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
	await app.vault.modify(file, `${content}${separator}${lines.join('\n')}\n`);
}

// バックログ（backlog）にあるタスクを「今日のタスク」へ取り込む。既にtodo/doing/holdなら何もしない
// （案件変更を伴わない、コンテナ全体へのドロップ用）。
export async function bringIntoToday(
	app: App,
	filePath: string,
	line: number,
): Promise<void> {
	const file = await getFile(app, filePath);
	const content = await app.vault.read(file);
	const lines = content.split('\n');
	const match = TASK_LINE_RE.exec(lines[line] ?? '');
	if (!match) return;
	const checked = match[2]!.toLowerCase() === 'x';
	const parsed = parseTaskLine(checked, match[4]!);
	if (parsed.status !== 'backlog') return;

	lines[line] = buildLine(
		match[1]!,
		match[3]!,
		checked,
		{
			text: parsed.text,
			project: parsed.project,
			priority: parsed.priority,
			dueDate: parsed.dueDate,
			startDate: parsed.startDate,
			delayReason: parsed.delayReason,
		},
		'todo',
		null,
		parsed.completedAt,
	);
	await app.vault.modify(file, lines.join('\n'));
}

// 案件スイムレーンへのドロップ用：backlogなら todo に昇格しつつ project を書き換える。
// 既にtodo/doing/holdならステータスは維持し、project だけ変更する（案件間の付け替え）。
export async function promoteAndAssign(
	app: App,
	filePath: string,
	line: number,
	project: string | null,
): Promise<void> {
	const file = await getFile(app, filePath);
	const content = await app.vault.read(file);
	const lines = content.split('\n');
	const match = TASK_LINE_RE.exec(lines[line] ?? '');
	if (!match) return;
	const checked = match[2]!.toLowerCase() === 'x';
	const parsed = parseTaskLine(checked, match[4]!);
	const status = parsed.status === 'backlog' ? 'todo' : parsed.status;
	const startedAt = status === 'todo' || status === 'hold' ? null : parsed.startedAt;

	lines[line] = buildLine(
		match[1]!,
		match[3]!,
		checked,
		{
			text: parsed.text,
			project,
			priority: parsed.priority,
			dueDate: parsed.dueDate,
			startDate: parsed.startDate,
			delayReason: parsed.delayReason,
		},
		status,
		startedAt,
		parsed.completedAt,
	);
	await app.vault.modify(file, lines.join('\n'));
}

export async function toggleSubtask(
	app: App,
	filePath: string,
	line: number,
	checked: boolean,
): Promise<void> {
	const file = await getFile(app, filePath);
	const content = await app.vault.read(file);
	const lines = content.split('\n');
	const match = TASK_LINE_RE.exec(lines[line] ?? '');
	if (!match) return;
	lines[line] = `${match[1]}${checked ? 'x' : ' '}${match[3]}${match[4]}`;
	await app.vault.modify(file, lines.join('\n'));
}

export async function deleteSubtask(
	app: App,
	filePath: string,
	line: number,
): Promise<void> {
	await deleteTask(app, filePath, line);
}

export async function editSubtask(
	app: App,
	filePath: string,
	line: number,
	fields: SubTaskFields,
): Promise<void> {
	const file = await getFile(app, filePath);
	const content = await app.vault.read(file);
	const lines = content.split('\n');
	const match = TASK_LINE_RE.exec(lines[line] ?? '');
	if (!match) return;
	const checked = match[2]!.toLowerCase() === 'x';
	lines[line] = buildSubtaskLine(match[1]!, match[3]!, checked, fields);
	await app.vault.modify(file, lines.join('\n'));
}

export async function addSubtask(
	app: App,
	filePath: string,
	parentLine: number,
	fields: SubTaskFields,
): Promise<void> {
	const file = await getFile(app, filePath);
	const content = await app.vault.read(file);
	const lines = content.split('\n');
	const parentText = lines[parentLine] ?? '';
	const parentIndent = /^\s*/.exec(parentText)![0];

	let insertAt = parentLine + 1;
	let childIndent = `${parentIndent}\t`;
	if (TASK_LINE_RE.test(lines[insertAt] ?? '')) {
		const firstChildIndent = /^\s*/.exec(lines[insertAt]!)![0];
		if (firstChildIndent.length > parentIndent.length) {
			childIndent = firstChildIndent;
			while (
				insertAt < lines.length &&
				TASK_LINE_RE.test(lines[insertAt] ?? '') &&
				/^\s*/.exec(lines[insertAt]!)![0].length >= childIndent.length
			) {
				insertAt++;
			}
		}
	}

	lines.splice(insertAt, 0, buildSubtaskLine(`${childIndent}- [`, '] ', false, fields));
	await app.vault.modify(file, lines.join('\n'));
}

export async function addTask(
	app: App,
	filePath: string,
	fields: TaskFields,
	status: TaskStatus,
): Promise<void> {
	const existing = app.vault.getAbstractFileByPath(filePath);
	const file =
		existing instanceof TFile ? existing : await app.vault.create(filePath, '');
	const content = await app.vault.read(file);
	const startedAt = status === 'doing' ? todayISO() : null;
	const completedAt = status === 'done' ? todayISO() : null;
	const line = buildLine(
		'- [',
		'] ',
		status === 'done',
		fields,
		status,
		startedAt,
		completedAt,
	);
	const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
	await app.vault.modify(file, `${content}${separator}${line}\n`);
}

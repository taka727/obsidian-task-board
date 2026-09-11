import { DueUrgency } from './dateUtils';
import { TaskItem, TaskPriority, TaskStatus } from './types';

// 未完了一覧（TaskInboxBlock）と今日のタスク（TaskTodayBlock）が同じペイロード形式で
// カードをドラッグできるようにする共通のkind。
export const TASK_CARD_DRAG_KIND = 'task-board-card';

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
	high: '高',
	mid: '中',
	low: '低',
};

export const STATUS_LABELS: Partial<Record<TaskStatus, string>> = {
	todo: '未着手',
	doing: '進行中',
	hold: '保留',
};

export function renderTaskBadges(
	cardEl: HTMLElement,
	task: TaskItem,
	urgency: DueUrgency | null,
): void {
	if (!task.project && !task.priority && !task.dueDate) return;

	const badgesEl = cardEl.createDiv({ cls: 'task-board-card-badges' });
	if (task.project) {
		badgesEl.createEl('span', {
			cls: 'task-board-badge task-board-badge-project',
			text: `# ${task.project}`,
		});
	}
	if (task.priority) {
		badgesEl.createEl('span', {
			cls: `task-board-badge task-board-badge-priority-${task.priority}`,
			text: PRIORITY_LABELS[task.priority],
		});
	}
	if (task.dueDate) {
		badgesEl.createEl('span', {
			cls: `task-board-badge task-board-badge-due${
				urgency ? ` task-board-badge-due-${urgency}` : ''
			}`,
			text: `📅${task.dueDate}`,
		});
	}
}

export function setDataTransferPayload(
	dataTransfer: DataTransfer | null,
	filePath: string,
	line: number,
): void {
	dataTransfer?.setData(
		'text/plain',
		JSON.stringify({ kind: TASK_CARD_DRAG_KIND, filePath, line }),
	);
}

export interface CardDragPayload {
	filePath: string;
	line: number;
}

export function parseCardDragPayload(raw: string | undefined): CardDragPayload | null {
	if (!raw) return null;
	try {
		const data = JSON.parse(raw) as Partial<CardDragPayload> & { kind?: string };
		if (
			data.kind === TASK_CARD_DRAG_KIND &&
			typeof data.filePath === 'string' &&
			typeof data.line === 'number'
		) {
			return { filePath: data.filePath, line: data.line };
		}
	} catch {
		// 自分の払い出したペイロードではない
	}
	return null;
}

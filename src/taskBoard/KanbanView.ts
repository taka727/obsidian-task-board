import { App, ItemView, Modal, Setting, WorkspaceLeaf } from 'obsidian';
import type MyPlugin from '../main';
import {
	daysBetween,
	getDueUrgency,
	isWithinRecentDays,
	todayISO,
} from './dateUtils';
import { collectTasks, listProjectNames, taskKey } from './taskIndex';
import {
	addSubtask,
	addTask,
	deleteSubtask,
	deleteTask,
	editSubtask,
	editTask,
	moveTask,
	toggleSubtask,
} from './taskMutator';
import {
	SubTaskFields,
	TaskFields,
	TaskItem,
	TaskPriority,
	TaskStatus,
} from './types';

export const VIEW_TYPE_TASK_BOARD = 'task-board-view';

const COLUMNS: { status: TaskStatus; label: string }[] = [
	{ status: 'backlog', label: 'TODO' },
	{ status: 'todo', label: '未着手' },
	{ status: 'doing', label: '進行中' },
	{ status: 'hold', label: '保留' },
	{ status: 'done', label: '完了' },
];

// 完了列は放っておくと溜まり続けて列が見渡せなくなるので、直近この日数ぶんだけを
// 常時表示し、それ以前は折りたたむ。
const DONE_RECENT_DAYS = 7;

// 完了日の新しい順。完了日が未記録のものは一番古い扱いで末尾へ。
function compareCompletedDesc(a: TaskItem, b: TaskItem): number {
	if (!a.completedAt && !b.completedAt) return 0;
	if (!a.completedAt) return 1;
	if (!b.completedAt) return -1;
	return b.completedAt.localeCompare(a.completedAt);
}

const PRIORITY_LABELS: Record<TaskPriority, string> = {
	high: '高',
	mid: '中',
	low: '低',
};

export class TaskBoardView extends ItemView {
	private projectFilter = 'ALL';
	private priorityFilter = new Set<TaskPriority>();
	// 小チケットを開いているタスクのキー。チェックを1つ付けるたびに render() で
	// カードを作り直すので、開閉状態はここに持って再描画をまたいで復元する。
	private expandedSubtasks = new Set<string>();
	// 完了列の「他N件」を開いているかどうか。小チケットと同様、再描画をまたいで復元する。
	private doneArchiveOpen = false;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: MyPlugin,
	) {
		super(leaf);
	}

	private get targetFile(): string {
		return this.plugin.settings.taskBoardFile;
	}

	getViewType(): string {
		return VIEW_TYPE_TASK_BOARD;
	}

	getDisplayText(): string {
		return 'タスクボード';
	}

	getIcon(): string {
		return 'layout-grid';
	}

	async onOpen(): Promise<void> {
		await this.render();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	private applyFilters(tasks: TaskItem[]): TaskItem[] {
		return tasks.filter((task) => {
			if (this.projectFilter === 'NONE' && task.project !== null) return false;
			if (
				this.projectFilter !== 'ALL' &&
				this.projectFilter !== 'NONE' &&
				task.project !== this.projectFilter
			) {
				return false;
			}
			if (
				this.priorityFilter.size > 0 &&
				(!task.priority || !this.priorityFilter.has(task.priority))
			) {
				return false;
			}
			return true;
		});
	}

	private renderFilterBar(container: HTMLElement, projectOptions: string[]): void {
		const barEl = container.createDiv({ cls: 'task-board-filter-bar' });

		const projectSelect = barEl.createEl('select', {
			cls: 'task-board-filter-select',
		});
		projectSelect.createEl('option', { text: 'すべての案件', value: 'ALL' });
		projectSelect.createEl('option', { text: '（案件なし）', value: 'NONE' });
		projectOptions.forEach((name) => {
			projectSelect.createEl('option', { text: name, value: name });
		});
		projectSelect.value = this.projectFilter;
		projectSelect.addEventListener('change', () => {
			this.projectFilter = projectSelect.value;
			void this.render();
		});

		const priorityGroupEl = barEl.createDiv({
			cls: 'task-board-filter-priority-group',
		});
		(['high', 'mid', 'low'] as TaskPriority[]).forEach((priority) => {
			const isActive = this.priorityFilter.has(priority);
			const btn = priorityGroupEl.createEl('button', {
				cls: `task-board-filter-priority-btn task-board-badge-priority-${priority}${
					isActive ? ' is-active' : ''
				}`,
				text: PRIORITY_LABELS[priority],
			});
			btn.addEventListener('click', () => {
				if (this.priorityFilter.has(priority)) {
					this.priorityFilter.delete(priority);
				} else {
					this.priorityFilter.add(priority);
				}
				void this.render();
			});
		});

		if (this.projectFilter !== 'ALL' || this.priorityFilter.size > 0) {
			const clearButton = barEl.createEl('button', {
				cls: 'task-board-filter-clear',
				text: 'フィルタ解除',
			});
			clearButton.addEventListener('click', () => {
				this.projectFilter = 'ALL';
				this.priorityFilter.clear();
				void this.render();
			});
		}
	}

	private async render(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass('task-board-container');

		const tasks = await collectTasks(this.app);
		const projectOptions = listProjectNames(
			this.app,
			this.plugin.settings.projectsFolder,
		);

		this.renderFilterBar(container, projectOptions);

		const columnsEl = container.createDiv({ cls: 'task-board-columns' });
		const filteredTasks = this.applyFilters(tasks);

		for (const column of COLUMNS) {
			const columnEl = columnsEl.createDiv({ cls: 'task-board-column' });

			const columnTasks = filteredTasks.filter(
				(task) => task.status === column.status,
			);

			// 完了列だけは直近ぶん（recent）と古いぶん（archived）に分ける。
			let recentTasks = columnTasks;
			let archivedTasks: TaskItem[] = [];
			if (column.status === 'done') {
				const sorted = [...columnTasks].sort(compareCompletedDesc);
				recentTasks = sorted.filter((task) =>
					isWithinRecentDays(task.completedAt, DONE_RECENT_DAYS),
				);
				archivedTasks = sorted.filter(
					(task) => !isWithinRecentDays(task.completedAt, DONE_RECENT_DAYS),
				);
			}

			const headerEl = columnEl.createDiv({
				cls: 'task-board-column-header',
			});
			headerEl.createSpan({
				text:
					archivedTasks.length > 0
						? `${column.label} (${recentTasks.length} / ${columnTasks.length})`
						: `${column.label} (${columnTasks.length})`,
			});

			const cardsEl = columnEl.createDiv({ cls: 'task-board-cards' });

			recentTasks.forEach((task) =>
				this.renderCard(cardsEl, task, projectOptions),
			);

			if (archivedTasks.length > 0) {
				const archiveEl = cardsEl.createEl('details', {
					cls: 'task-board-done-archive',
				});
				archiveEl.open = this.doneArchiveOpen;
				archiveEl.addEventListener('toggle', () => {
					this.doneArchiveOpen = archiveEl.open;
				});
				archiveEl.createEl('summary', {
					cls: 'task-board-done-archive-summary',
					text: `他 ${archivedTasks.length} 件（${DONE_RECENT_DAYS}日より前）`,
				});
				const archiveCardsEl = archiveEl.createDiv({
					cls: 'task-board-done-archive-cards',
				});
				archivedTasks.forEach((task) =>
					this.renderCard(archiveCardsEl, task, projectOptions),
				);
			}

			const addButton = columnEl.createEl('button', {
				cls: 'task-board-add-button',
				text: '+ カードを追加',
			});
			addButton.addEventListener('click', () => {
				new TaskEditModal(
					this.app,
					{
						text: '',
						project: null,
						priority: null,
						dueDate: null,
						startDate: null,
						delayReason: null,
					},
					projectOptions,
					async (fields) => {
						await addTask(this.app, this.targetFile, fields, column.status);
						await this.render();
					},
				).open();
			});

			this.registerDropZone(columnEl, column.status);
		}
	}

	private renderCard(
		parent: HTMLElement,
		task: TaskItem,
		projectOptions: string[],
	): void {
		const cardEl = parent.createDiv({ cls: 'task-board-card' });
		cardEl.setAttr('draggable', 'true');

		const urgency = getDueUrgency(task.dueDate);
		if (urgency === 'overdue') cardEl.addClass('is-overdue');
		if (urgency === 'soon') cardEl.addClass('is-due-soon');

		const hasBadges =
			task.project ||
			task.priority ||
			(task.status === 'doing' && task.startedAt) ||
			(task.status === 'done' && task.completedAt) ||
			task.dueDate;

		if (hasBadges) {
			const badgesEl = cardEl.createDiv({ cls: 'task-board-card-badges' });

			if (task.project) {
				const badge = badgesEl.createEl('span', {
					cls: 'task-board-badge task-board-badge-project',
					text: `# ${task.project}`,
				});
				badge.addEventListener('click', (evt) => {
					evt.stopPropagation();
					const project = task.project;
					if (!project) return;
					void this.app.workspace.openLinkText(
						`${this.plugin.settings.projectsFolder}/${project}`,
						'',
						false,
					);
				});
			}

			if (task.priority) {
				badgesEl.createEl('span', {
					cls: `task-board-badge task-board-badge-priority-${task.priority}`,
					text: PRIORITY_LABELS[task.priority],
				});
			}

			if (task.status === 'doing' && task.startedAt) {
				badgesEl.createEl('span', {
					cls: 'task-board-badge task-board-badge-age',
					text: `経過${daysBetween(task.startedAt, todayISO())}日`,
				});
			}

			// 完了列は完了日の新しい順に並べ、直近ぶんだけを常時表示するので、
			// 判断の根拠になる完了日をカード側にも出す。
			if (task.status === 'done' && task.completedAt) {
				badgesEl.createEl('span', {
					cls: 'task-board-badge task-board-badge-completed',
					text: `✅${task.completedAt}`,
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

		const textEl = cardEl.createDiv({ cls: 'task-board-card-text' });
		textEl.setText(task.text || '(no text)');

		this.renderSubtasks(cardEl, task);

		const actionsEl = cardEl.createDiv({ cls: 'task-board-card-actions' });

		const editButton = actionsEl.createEl('button', {
			cls: 'task-board-card-action',
			text: '編集',
		});
		editButton.addEventListener('click', (evt) => {
			evt.stopPropagation();
			new TaskEditModal(
				this.app,
				{
					text: task.text,
					project: task.project,
					priority: task.priority,
					dueDate: task.dueDate,
					startDate: task.startDate,
					delayReason: task.delayReason,
				},
				projectOptions,
				async (fields) => {
					await editTask(this.app, task.filePath, task.line, fields);
					await this.render();
				},
			).open();
		});

		const duplicateButton = actionsEl.createEl('button', {
			cls: 'task-board-card-action',
			text: '複製',
		});
		duplicateButton.addEventListener('click', (evt) => {
			evt.stopPropagation();
			void addTask(
				this.app,
				task.filePath,
				{
					text: task.text,
					project: task.project,
					priority: task.priority,
					dueDate: task.dueDate,
					startDate: task.startDate,
					delayReason: task.delayReason,
				},
				task.status,
			).then(() => this.render());
		});

		const deleteButton = actionsEl.createEl('button', {
			cls: 'task-board-card-action task-board-card-action-danger',
			text: '削除',
		});
		deleteButton.addEventListener('click', (evt) => {
			evt.stopPropagation();
			new ConfirmModal(this.app, `「${task.text}」を削除しますか？`, async () => {
				await deleteTask(this.app, task.filePath, task.line);
				await this.render();
			}).open();
		});

		cardEl.addEventListener('dragstart', (evt) => {
			evt.dataTransfer?.setData(
				'text/plain',
				JSON.stringify({ filePath: task.filePath, line: task.line }),
			);
			cardEl.addClass('is-dragging');
		});
		cardEl.addEventListener('dragend', () => {
			cardEl.removeClass('is-dragging');
		});
	}

	private renderSubtasks(cardEl: HTMLElement, task: TaskItem): void {
		const subtasksEl = cardEl.createDiv({ cls: 'task-board-subtasks' });

		if (task.subtasks.length > 0) {
			const key = taskKey(task);
			const doneCount = task.subtasks.filter((s) => s.checked).length;
			// 小チケットは既定で折りたたむ。カードが縦に伸びて列が見渡せなくなるのを防ぐが、
			// 進捗（n/m とバー）は畳んだままでも分かるようサマリー側に置く。
			const detailsEl = subtasksEl.createEl('details', {
				cls: 'task-board-subtasks-details',
			});
			detailsEl.open = this.expandedSubtasks.has(key);
			detailsEl.addEventListener('toggle', () => {
				if (detailsEl.open) this.expandedSubtasks.add(key);
				else this.expandedSubtasks.delete(key);
			});

			const progressEl = detailsEl.createEl('summary', {
				cls: 'task-board-subtasks-progress',
			});
			progressEl.createSpan({
				text: `サブタスク ${doneCount}/${task.subtasks.length}`,
			});
			const barEl = progressEl.createDiv({ cls: 'task-board-subtasks-bar' });
			barEl
				.createDiv({ cls: 'task-board-subtasks-bar-fill' })
				.setAttr(
					'style',
					`width: ${Math.round((doneCount / task.subtasks.length) * 100)}%`,
				);

			const listEl = detailsEl.createDiv({ cls: 'task-board-subtasks-list' });
			task.subtasks.forEach((sub) => {
				const rowEl = listEl.createDiv({ cls: 'task-board-subtask-row' });

				const checkbox = rowEl.createEl('input', {
					type: 'checkbox',
					cls: 'task-board-subtask-checkbox',
				});
				checkbox.checked = sub.checked;
				checkbox.addEventListener('click', (evt) => evt.stopPropagation());
				checkbox.addEventListener('change', () => {
					void toggleSubtask(
						this.app,
						task.filePath,
						sub.line,
						checkbox.checked,
					).then(() => this.render());
				});

				const textSpan = rowEl.createSpan({
					cls: 'task-board-subtask-text',
					text: sub.text || '(no text)',
				});
				if (sub.checked) textSpan.addClass('is-done');

				const editSubButton = rowEl.createEl('button', {
					cls: 'task-board-subtask-edit',
					text: '✎',
				});
				editSubButton.addEventListener('click', (evt) => {
					evt.stopPropagation();
					new SubtaskEditModal(
						this.app,
						'小タスクを編集',
						{ text: sub.text, startDate: sub.startDate, dueDate: sub.dueDate },
						async (fields) => {
							await editSubtask(this.app, task.filePath, sub.line, fields);
							await this.render();
						},
					).open();
				});

				const removeButton = rowEl.createEl('button', {
					cls: 'task-board-subtask-remove',
					text: '×',
				});
				removeButton.addEventListener('click', (evt) => {
					evt.stopPropagation();
					void deleteSubtask(this.app, task.filePath, sub.line).then(() =>
						this.render(),
					);
				});
			});
		}

		const addButton = subtasksEl.createEl('button', {
			cls: 'task-board-subtask-add',
			text: '+ サブタスク',
		});
		addButton.addEventListener('click', (evt) => {
			evt.stopPropagation();
			new SubtaskEditModal(
				this.app,
				'小タスクを追加',
				{ text: '', startDate: null, dueDate: null },
				async (fields) => {
					await addSubtask(this.app, task.filePath, task.line, fields);
					await this.render();
				},
			).open();
		});
	}

	private registerDropZone(columnEl: HTMLElement, status: TaskStatus): void {
		columnEl.addEventListener('dragover', (evt) => {
			evt.preventDefault();
			columnEl.addClass('is-drag-over');
		});
		columnEl.addEventListener('dragleave', () => {
			columnEl.removeClass('is-drag-over');
		});
		columnEl.addEventListener('drop', (evt) => {
			evt.preventDefault();
			columnEl.removeClass('is-drag-over');
			const raw = evt.dataTransfer?.getData('text/plain');
			if (!raw) return;
			const { filePath, line } = JSON.parse(raw) as {
				filePath: string;
				line: number;
			};
			void moveTask(this.app, filePath, line, status).then(() =>
				this.render(),
			);
		});
	}
}

export class TaskEditModal extends Modal {
	private text: string;
	private project: string;
	private priority: TaskPriority | null;
	private dueDate: string;
	private startDate: string;
	private delayReason: string;

	constructor(
		app: App,
		private initial: TaskFields,
		private projectOptions: string[],
		private onSubmit: (fields: TaskFields) => void | Promise<void>,
	) {
		super(app);
		this.text = initial.text;
		this.project = initial.project ?? '';
		this.priority = initial.priority;
		this.dueDate = initial.dueDate ?? '';
		this.startDate = initial.startDate ?? '';
		this.delayReason = initial.delayReason ?? '';
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'タスク内容' });

		new Setting(contentEl).setName('内容').addText((text) => {
			text.setValue(this.text).onChange((v) => (this.text = v));
			text.inputEl.addClass('task-board-modal-input');
			text.inputEl.focus();
			text.inputEl.addEventListener('keydown', (evt) => {
				// isComposing / keyCode 229: IME変換確定のEnterを送信と誤認しないようにする
				if (evt.key === 'Enter' && !evt.isComposing && evt.keyCode !== 229) {
					evt.preventDefault();
					void this.submit();
				}
			});
		});

		const datalistId = 'task-board-project-options';
		const datalist = contentEl.createEl('datalist');
		datalist.id = datalistId;
		this.projectOptions.forEach((name) => {
			datalist.createEl('option', { value: name });
		});

		new Setting(contentEl).setName('案件').addText((text) => {
			text.setValue(this.project).onChange((v) => (this.project = v.trim()));
			text.setPlaceholder('例: 案件A（空欄可）');
			text.inputEl.setAttr('list', datalistId);
			text.inputEl.addClass('task-board-modal-input');
		});

		new Setting(contentEl).setName('重要度').addDropdown((dropdown) => {
			dropdown
				.addOption('', 'なし')
				.addOption('high', '高')
				.addOption('mid', '中')
				.addOption('low', '低')
				.setValue(this.priority ?? '')
				.onChange((v) => {
					this.priority = (v || null) as TaskPriority | null;
				});
		});

		new Setting(contentEl).setName('開始日').addText((text) => {
			text.inputEl.type = 'date';
			text.setValue(this.startDate);
			text.onChange((v) => (this.startDate = v));
		});

		new Setting(contentEl).setName('期日').addText((text) => {
			text.inputEl.type = 'date';
			text.setValue(this.dueDate);
			text.onChange((v) => (this.dueDate = v));
		});

		new Setting(contentEl).setName('遅延理由').addText((text) => {
			text.setValue(this.delayReason).onChange((v) => (this.delayReason = v));
			text.setPlaceholder('期日を超過した場合の理由（任意）');
			text.inputEl.addClass('task-board-modal-input');
		});

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText('保存')
				.setCta()
				.onClick(() => void this.submit()),
		);
	}

	private async submit(): Promise<void> {
		if (!this.text.trim()) return;
		await this.onSubmit({
			text: this.text.trim(),
			project: this.project ? this.project.trim() : null,
			priority: this.priority,
			dueDate: this.dueDate ? this.dueDate : null,
			startDate: this.startDate ? this.startDate : null,
			delayReason: this.delayReason.trim() ? this.delayReason.trim() : null,
		});
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// 小タスクの追加と編集で同じモーダルを使う。小タスクにも開始日・期日を持たせて
// ガントチャートに行として並べられるようにするため、日付入力を備える。
export class SubtaskEditModal extends Modal {
	private text: string;
	private startDate: string;
	private dueDate: string;

	constructor(
		app: App,
		private title: string,
		initial: SubTaskFields,
		private onSubmit: (fields: SubTaskFields) => void | Promise<void>,
	) {
		super(app);
		this.text = initial.text;
		this.startDate = initial.startDate ?? '';
		this.dueDate = initial.dueDate ?? '';
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: this.title });

		new Setting(contentEl).setName('内容').addText((text) => {
			text.setValue(this.text).onChange((v) => (this.text = v));
			text.inputEl.addClass('task-board-modal-input');
			text.inputEl.focus();
			text.inputEl.addEventListener('keydown', (evt) => {
				if (evt.key === 'Enter' && !evt.isComposing && evt.keyCode !== 229) {
					evt.preventDefault();
					void this.submit();
				}
			});
		});

		new Setting(contentEl).setName('開始日').addText((text) => {
			text.inputEl.type = 'date';
			text.setValue(this.startDate);
			text.onChange((v) => (this.startDate = v));
		});

		new Setting(contentEl).setName('期日').addText((text) => {
			text.inputEl.type = 'date';
			text.setValue(this.dueDate);
			text.onChange((v) => (this.dueDate = v));
		});

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText('保存')
				.setCta()
				.onClick(() => void this.submit()),
		);
	}

	private async submit(): Promise<void> {
		if (!this.text.trim()) return;
		await this.onSubmit({
			text: this.text.trim(),
			startDate: this.startDate ? this.startDate : null,
			dueDate: this.dueDate ? this.dueDate : null,
		});
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class ConfirmModal extends Modal {
	constructor(
		app: App,
		private message: string,
		private onConfirm: () => void | Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('p', { text: this.message });

		const buttonRow = contentEl.createDiv({ cls: 'task-board-modal-buttons' });
		const cancelButton = buttonRow.createEl('button', { text: 'キャンセル' });
		cancelButton.addEventListener('click', () => this.close());

		const confirmButton = buttonRow.createEl('button', {
			text: '削除',
			cls: 'mod-warning',
		});
		confirmButton.addEventListener('click', () => {
			void Promise.resolve(this.onConfirm()).then(() => this.close());
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

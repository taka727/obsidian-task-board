import { MarkdownRenderChild } from 'obsidian';
import type MyPlugin from '../main';
import { getDueUrgency } from './dateUtils';
import { collectTasks } from './taskIndex';
import { moveTask } from './taskMutator';
import { renderTaskBadges, setDataTransferPayload } from './taskCardUI';
import { TaskItem } from './types';

// 日次ノートの「未完了（TODO）」ブロック。自動更新はせず、「ロード」ボタンを押した
// タイミングでのみ Tasks.md の backlog タスクを取得して一覧表示する。
class TaskInboxChild extends MarkdownRenderChild {
	private listEl!: HTMLElement;

	constructor(
		containerEl: HTMLElement,
		private plugin: MyPlugin,
	) {
		super(containerEl);
	}

	onload(): void {
		this.containerEl.empty();
		this.containerEl.addClass('task-inbox-container');

		const loadButton = this.containerEl.createEl('button', {
			cls: 'task-inbox-load-button',
			text: '🔄 ロード',
		});
		loadButton.addEventListener('click', () => void this.loadTasks());

		this.listEl = this.containerEl.createDiv({ cls: 'task-inbox-list' });
		this.listEl.createDiv({
			cls: 'task-inbox-empty',
			text: '「ロード」を押すと最新の未完了タスクを表示します',
		});
	}

	private async loadTasks(): Promise<void> {
		const tasks = (await collectTasks(this.plugin.app)).filter(
			(task) =>
				task.filePath === this.plugin.settings.taskBoardFile &&
				task.status === 'backlog',
		);

		this.listEl.empty();

		if (tasks.length === 0) {
			this.listEl.createDiv({
				cls: 'task-inbox-empty',
				text: '未完了タスクはありません',
			});
			return;
		}

		tasks.forEach((task) => this.renderCard(task));
	}

	private renderCard(task: TaskItem): void {
		const cardEl = this.listEl.createDiv({
			cls: 'task-board-card task-inbox-card',
		});
		cardEl.setAttr('draggable', 'true');

		const urgency = getDueUrgency(task.dueDate);
		if (urgency === 'overdue') cardEl.addClass('is-overdue');
		if (urgency === 'soon') cardEl.addClass('is-due-soon');

		const topRowEl = cardEl.createDiv({ cls: 'task-inbox-card-top' });

		const checkbox = topRowEl.createEl('input', {
			type: 'checkbox',
			cls: 'task-inbox-card-checkbox',
		});
		checkbox.addEventListener('click', (evt) => evt.stopPropagation());
		checkbox.addEventListener('change', () => {
			void moveTask(this.plugin.app, task.filePath, task.line, 'done').then(
				() => this.loadTasks(),
			);
		});

		const textEl = topRowEl.createDiv({ cls: 'task-board-card-text' });
		textEl.setText(task.text || '(no text)');

		renderTaskBadges(cardEl, task, urgency);

		if (task.subtasks.length > 0) {
			const doneCount = task.subtasks.filter((s) => s.checked).length;
			cardEl.createDiv({
				cls: 'task-inbox-subtask-hint',
				text: `サブタスク ${doneCount}/${task.subtasks.length}`,
			});
		}

		cardEl.addEventListener('dragstart', (evt) => {
			setDataTransferPayload(evt.dataTransfer, task.filePath, task.line);
			cardEl.addClass('is-dragging');
		});
		cardEl.addEventListener('dragend', () => cardEl.removeClass('is-dragging'));
	}
}

export function registerTaskInboxBlock(plugin: MyPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor('task-inbox', (_source, el, ctx) => {
		ctx.addChild(new TaskInboxChild(el, plugin));
	});
}

import { MarkdownRenderChild } from 'obsidian';
import type MyPlugin from '../main';
import { getDueUrgency } from './dateUtils';
import { collectTasks, listProjectNames } from './taskIndex';
import { bringIntoToday, moveTask, promoteAndAssign } from './taskMutator';
import {
	STATUS_LABELS,
	parseCardDragPayload,
	renderTaskBadges,
	setDataTransferPayload,
} from './taskCardUI';
import { TaskItem } from './types';

const NO_PROJECT_LABEL = '（案件なし）';

interface TaskGroup {
	project: string | null;
	label: string;
	tasks: TaskItem[];
}

// 案件の箱は「該当タスクがあるかどうか」に関わらず常時表示する（ドラッグの受け皿を常に見せるため）。
// 実在する案件（03_Projects配下のノート）をまず箱として用意し、そこにタスクを割り振る。
// 実在しない案件名を指すタスクがあっても見失わないよう、その場合は追加の箱を作る。
function buildGroups(
	projectNames: string[],
	tasks: TaskItem[],
): TaskGroup[] {
	const map = new Map<string, TaskGroup>();
	for (const name of projectNames) {
		map.set(name, { project: name, label: name, tasks: [] });
	}

	const noProjectGroup: TaskGroup = {
		project: null,
		label: NO_PROJECT_LABEL,
		tasks: [],
	};

	for (const task of tasks) {
		if (task.project === null) {
			noProjectGroup.tasks.push(task);
			continue;
		}
		let group = map.get(task.project);
		if (!group) {
			group = { project: task.project, label: task.project, tasks: [] };
			map.set(task.project, group);
		}
		group.tasks.push(task);
	}

	const groups = [...map.values()];
	groups.sort((a, b) => a.label.localeCompare(b.label, 'ja'));
	groups.push(noProjectGroup);
	return groups;
}

// 日次ノートの「今日のタスク」ブロック。Tasks.md の todo/doing/hold タスクを
// 案件（project::）ごとに自動グルーピングして表示する。Tasks.md の変更で自動再描画。
class TaskTodayChild extends MarkdownRenderChild {
	constructor(
		containerEl: HTMLElement,
		private plugin: MyPlugin,
	) {
		super(containerEl);
	}

	onload(): void {
		void this.render();
		this.registerEvent(
			this.plugin.app.vault.on('modify', (file) => {
				if (file.path === this.plugin.settings.taskBoardFile) void this.render();
			}),
		);
	}

	private async render(): Promise<void> {
		const tasks = (await collectTasks(this.plugin.app)).filter(
			(task) =>
				task.filePath === this.plugin.settings.taskBoardFile &&
				(task.status === 'todo' || task.status === 'doing' || task.status === 'hold'),
		);

		this.containerEl.empty();
		this.containerEl.addClass('task-today-container');
		this.registerContainerDropZone(this.containerEl);

		const projectNames = listProjectNames(
			this.plugin.app,
			this.plugin.settings.projectsFolder,
		);
		buildGroups(projectNames, tasks).forEach((group) => this.renderGroup(group));
	}

	private renderGroup(group: TaskGroup): void {
		const groupEl = this.containerEl.createDiv({ cls: 'task-today-group' });

		const headerEl = groupEl.createDiv({ cls: 'task-today-group-header' });
		headerEl.setText(`${group.label} (${group.tasks.length})`);
		if (group.project) {
			headerEl.addClass('is-clickable');
			headerEl.addEventListener('click', () => {
				void this.plugin.app.workspace.openLinkText(
					`${this.plugin.settings.projectsFolder}/${group.project}`,
					'',
					false,
				);
			});
		}

		const cardsEl = groupEl.createDiv({ cls: 'task-today-cards' });
		if (group.tasks.length === 0) {
			cardsEl.createDiv({
				cls: 'task-inbox-empty',
				text: 'ここにドラッグ',
			});
		}
		group.tasks.forEach((task) => this.renderCard(cardsEl, task));

		this.registerGroupDropZone(groupEl, group.project);
	}

	private renderCard(parent: HTMLElement, task: TaskItem): void {
		const cardEl = parent.createDiv({ cls: 'task-board-card task-today-card' });
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
				() => this.render(),
			);
		});

		const textEl = topRowEl.createDiv({ cls: 'task-board-card-text' });
		textEl.setText(task.text || '(no text)');

		const statusLabel = STATUS_LABELS[task.status];
		if (statusLabel) {
			cardEl.createEl('span', {
				cls: `task-board-badge task-board-badge-status-${task.status}`,
				text: statusLabel,
			});
		}

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

	private registerGroupDropZone(groupEl: HTMLElement, project: string | null): void {
		groupEl.addEventListener('dragover', (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			groupEl.addClass('is-drag-over');
		});
		groupEl.addEventListener('dragleave', () => {
			groupEl.removeClass('is-drag-over');
		});
		groupEl.addEventListener('drop', (evt) => {
			evt.preventDefault();
			evt.stopPropagation();
			groupEl.removeClass('is-drag-over');
			const payload = parseCardDragPayload(evt.dataTransfer?.getData('text/plain'));
			if (!payload) return;
			void promoteAndAssign(
				this.plugin.app,
				payload.filePath,
				payload.line,
				project,
			).then(() => this.render());
		});
	}

	private registerContainerDropZone(containerEl: HTMLElement): void {
		containerEl.addEventListener('dragover', (evt) => {
			evt.preventDefault();
		});
		containerEl.addEventListener('drop', (evt) => {
			evt.preventDefault();
			const payload = parseCardDragPayload(evt.dataTransfer?.getData('text/plain'));
			if (!payload) return;
			void bringIntoToday(this.plugin.app, payload.filePath, payload.line).then(
				() => this.render(),
			);
		});
	}
}

export function registerTaskTodayBlock(plugin: MyPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor('task-today', (_source, el, ctx) => {
		ctx.addChild(new TaskTodayChild(el, plugin));
	});
}

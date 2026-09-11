import { Plugin } from 'obsidian';
import {
	DEFAULT_SETTINGS,
	MyPluginSettings,
	SampleSettingTab,
} from './settings';
import { GanttView, VIEW_TYPE_GANTT } from './taskBoard/GanttView';
import { TaskBoardView, VIEW_TYPE_TASK_BOARD } from './taskBoard/KanbanView';
import { registerTaskCapacityBlock } from './taskBoard/TaskCapacityBlock';
import { registerTaskHoursBlock } from './taskBoard/TaskHoursBlock';
import { registerTaskInboxBlock } from './taskBoard/TaskInboxBlock';
import { registerTaskShareBlock } from './taskBoard/TaskShareBlock';
import { collectTasks } from './taskBoard/taskIndex';
import { registerTaskTodayBlock } from './taskBoard/TaskTodayBlock';
import { TaskItem } from './taskBoard/types';

export default class MyPlugin extends Plugin {
	settings!: MyPluginSettings;

	async onload() {
		await this.loadSettings();

		this.registerView(
			VIEW_TYPE_TASK_BOARD,
			(leaf) => new TaskBoardView(leaf, this),
		);
		this.registerView(VIEW_TYPE_GANTT, (leaf) => new GanttView(leaf, this));

		this.addRibbonIcon('layout-grid', 'タスクボードを開く', () => {
			void this.activateTaskBoard();
		});
		this.addRibbonIcon('calendar-range', 'ガントチャートを開く', () => {
			void this.activateGantt();
		});

		this.addCommand({
			id: 'open-task-board',
			name: 'タスクボードを開く',
			callback: () => {
				void this.activateTaskBoard();
			},
		});
		this.addCommand({
			id: 'open-gantt-view',
			name: 'ガントチャートを開く',
			callback: () => {
				void this.activateGantt();
			},
		});

		this.addSettingTab(new SampleSettingTab(this.app, this));

		registerTaskInboxBlock(this);
		registerTaskTodayBlock(this);
		registerTaskShareBlock(this);
		registerTaskHoursBlock(this);
		registerTaskCapacityBlock(this);
	}

	onunload() {}

	// 週次レビューのTemplaterブロックから
	// app.plugins.plugins['sample-plugin'].getCompletedTasksBetween() として呼ぶ。
	// マーカーの解析はプラグイン側（taskIndex.ts）に集約し、テンプレートに正規表現を
	// 複製しないため。完了日（✅）が未記録のタスクは期間判定できないので対象外。
	async getCompletedTasksBetween(
		fromISO: string,
		toISO: string,
	): Promise<TaskItem[]> {
		const tasks = await collectTasks(this.app);
		return tasks
			.filter(
				(task) =>
					task.status === 'done' &&
					task.completedAt !== null &&
					task.completedAt >= fromISO &&
					task.completedAt <= toISO,
			)
			.sort((a, b) => (a.completedAt ?? '').localeCompare(b.completedAt ?? ''));
	}

	async activateTaskBoard(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_TASK_BOARD)[0];
		if (existing) {
			await workspace.revealLeaf(existing);
			return;
		}
		const leaf = workspace.getLeaf('tab');
		await leaf.setViewState({ type: VIEW_TYPE_TASK_BOARD, active: true });
		await workspace.revealLeaf(leaf);
	}

	async activateGantt(): Promise<void> {
		const { workspace } = this.app;
		const existing = workspace.getLeavesOfType(VIEW_TYPE_GANTT)[0];
		if (existing) {
			await workspace.revealLeaf(existing);
			return;
		}
		const leaf = workspace.getLeaf('tab');
		await leaf.setViewState({ type: VIEW_TYPE_GANTT, active: true });
		await workspace.revealLeaf(leaf);
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<MyPluginSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

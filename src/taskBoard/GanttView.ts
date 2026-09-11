import { ItemView, TFile, WorkspaceLeaf } from 'obsidian';
import type MyPlugin from '../main';
import { loadHolidays, todayISO } from './dateUtils';
import { GanttExportModal } from './GanttExportModal';
import { collectTasks, listProjectNames, taskKey } from './taskIndex';
import { editSubtask, editTask } from './taskMutator';
import { SubtaskEditModal, TaskEditModal } from './KanbanView';
import { computeRisks, GanttRisk, loadProjectDueDates } from './ganttRisk';
import { SubTask, TaskItem } from './types';

export const VIEW_TYPE_GANTT = 'gantt-view';

const DAYS_BEFORE = 7;
const DAYS_AFTER = 60;
const DAY_WIDTH = 28;
const ROW_LABEL_WIDTH = 220;
const REFRESH_DEBOUNCE_MS = 500;
const NO_PROJECT_LABEL = '（案件なし）';
const PROJECT_FILTER_ALL = 'ALL';
const PROJECT_FILTER_NONE = 'NONE';
const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

interface DayCell {
	iso: string;
	label: string;
	weekdayLabel: string;
	isWeekend: boolean;
	isHoliday: boolean;
	isToday: boolean;
}

interface TaskGroup {
	label: string;
	tasks: TaskItem[];
}

function formatISO(d: Date): string {
	const mm = String(d.getMonth() + 1).padStart(2, '0');
	const dd = String(d.getDate()).padStart(2, '0');
	return `${d.getFullYear()}-${mm}-${dd}`;
}

function groupByProject(tasks: TaskItem[]): TaskGroup[] {
	const map = new Map<string, TaskGroup>();
	const noProject: TaskGroup = { label: NO_PROJECT_LABEL, tasks: [] };
	for (const task of tasks) {
		if (!task.project) {
			noProject.tasks.push(task);
			continue;
		}
		let group = map.get(task.project);
		if (!group) {
			group = { label: task.project, tasks: [] };
			map.set(task.project, group);
		}
		group.tasks.push(task);
	}
	const groups = [...map.values()].sort((a, b) => a.label.localeCompare(b.label, 'ja'));
	if (noProject.tasks.length > 0) groups.push(noProject);
	return groups;
}

// このヴォルトのカンバンの列語彙では「TODO」(backlog)は受信箱の列。
// 日程が入っていれば工程表にも乗せたいので既定で表示し、受信箱として使っていて
// 邪魔なときだけトグルで隠せるようにする（バーは点線にして区別する）。
function isBacklog(task: TaskItem): boolean {
	return task.status === 'backlog';
}

export class GanttView extends ItemView {
	private holidays: Record<string, string> = {};
	private refreshTimer: number | null = null;
	// 完了タスクは既定で非表示（工程表としては「これから」を見たいことが多いため）。
	// トグルで表示に切り替えられる。
	private showCompleted = false;
	// 小タスクは既定で表示。行数が増えて見づらいときはトグルで折りたためる。
	private showSubtasks = true;
	// 案件ごとの表示（'ALL' = 全案件、'NONE' = 案件なしのみ、それ以外は案件名）。
	private projectFilter = PROJECT_FILTER_ALL;
	// 下部パネルの開閉状態。チャートを広く使いたいので既定は畳んだ状態にし、
	// 再描画（render）で DOM を作り直しても開閉が戻らないようここで保持する。
	// カンバンの「TODO」列（backlog）も既定で表示する。
	private showBacklog = true;
	private riskPanelOpen = false;
	private unscheduledPanelOpen = false;
	// 小チケットを開いているタスクのキー。既定は折りたたみで、開いたものだけ覚える。
	// 再描画（ファイル更新・フィルタ変更）をまたいでも開いたままにするためビューが持つ。
	private expandedSubtasks = new Set<string>();

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: MyPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_GANTT;
	}

	getDisplayText(): string {
		return 'ガントチャート';
	}

	getIcon(): string {
		return 'calendar-range';
	}

	async onOpen(): Promise<void> {
		this.holidays = await loadHolidays(this.app);
		await this.render();
		this.registerEvent(this.app.vault.on('modify', () => this.scheduleRefresh()));
	}

	async onClose(): Promise<void> {
		if (this.refreshTimer !== null) {
			window.clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}
		this.contentEl.empty();
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			void this.render();
		}, REFRESH_DEBOUNCE_MS);
	}

	private buildDayCells(): DayCell[] {
		const today = todayISO();
		const start = new Date(`${today}T00:00:00`);
		start.setDate(start.getDate() - DAYS_BEFORE);
		const cells: DayCell[] = [];
		for (let i = 0; i < DAYS_BEFORE + DAYS_AFTER + 1; i++) {
			const d = new Date(start);
			d.setDate(start.getDate() + i);
			const iso = formatISO(d);
			cells.push({
				iso,
				label: `${d.getMonth() + 1}/${d.getDate()}`,
				weekdayLabel: WEEKDAY_JA[d.getDay()]!,
				isWeekend: d.getDay() === 0 || d.getDay() === 6,
				isHoliday: Object.prototype.hasOwnProperty.call(this.holidays, iso),
				isToday: iso === today,
			});
		}
		return cells;
	}

	private dateIndex(dayCells: DayCell[], iso: string): number {
		const idx = dayCells.findIndex((c) => c.iso === iso);
		if (idx >= 0) return idx;
		return iso < dayCells[0]!.iso ? 0 : dayCells.length - 1;
	}

	private async render(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass('gantt-container');

		const allTasks = await collectTasks(this.app);
		const projectOptions = this.buildProjectOptions(allTasks);
		const projectTasks = allTasks.filter((t) => this.matchesProjectFilter(t));
		const completedCount = projectTasks.filter((t) => t.status === 'done').length;
		const backlogCount = projectTasks.filter(isBacklog).length;
		const tasks = projectTasks
			.filter((t) => this.showCompleted || t.status !== 'done')
			.filter((t) => this.showBacklog || !isBacklog(t));
		const subtaskCount = tasks.reduce((sum, t) => sum + this.visibleSubtasks(t).length, 0);
		const projectDueDates = loadProjectDueDates(
			this.app,
			this.plugin.settings.projectsFolder,
		);
		const risks = computeRisks(tasks, projectDueDates);
		const dayCells = this.buildDayCells();

		this.renderToolbar(container, completedCount, subtaskCount, backlogCount, projectOptions);
		this.renderGrid(container, tasks, dayCells);
		this.renderUnscheduled(container, tasks);
		this.renderRiskPanel(container, risks);
	}

	// 案件フィルタの選択肢。案件フォルダのノート名に加えて、フォルダ外の案件名が
	// タスク側に書かれていても選べるように和集合を取る。
	private buildProjectOptions(tasks: TaskItem[]): string[] {
		const names = new Set(
			listProjectNames(this.app, this.plugin.settings.projectsFolder),
		);
		tasks.forEach((t) => {
			if (t.project) names.add(t.project);
		});
		return [...names].sort((a, b) => a.localeCompare(b, 'ja'));
	}

	private matchesProjectFilter(task: TaskItem): boolean {
		if (this.projectFilter === PROJECT_FILTER_ALL) return true;
		if (this.projectFilter === PROJECT_FILTER_NONE) return task.project === null;
		return task.project === this.projectFilter;
	}

	// 完了タスクの表示トグルは小タスクにも効かせる（チェック済みの小タスクは既定で隠す）。
	private visibleSubtasks(task: TaskItem): SubTask[] {
		if (!this.showSubtasks) return [];
		return this.showCompleted
			? task.subtasks
			: task.subtasks.filter((s) => !s.checked);
	}

	private renderToolbar(
		container: HTMLElement,
		completedCount: number,
		subtaskCount: number,
		backlogCount: number,
		projectOptions: string[],
	): void {
		const toolbarEl = container.createDiv({ cls: 'gantt-toolbar' });
		toolbarEl.createSpan({ text: `今日: ${todayISO()}` });

		const projectSelect = toolbarEl.createEl('select', { cls: 'gantt-project-select' });
		projectSelect.createEl('option', { text: 'すべての案件', value: PROJECT_FILTER_ALL });
		projectSelect.createEl('option', { text: NO_PROJECT_LABEL, value: PROJECT_FILTER_NONE });
		projectOptions.forEach((name) => {
			projectSelect.createEl('option', { text: name, value: name });
		});
		projectSelect.value = this.projectFilter;
		projectSelect.addEventListener('change', () => {
			this.projectFilter = projectSelect.value;
			void this.render();
		});

		const toggleLabel = toolbarEl.createEl('label', { cls: 'gantt-toggle-completed' });
		const checkbox = toggleLabel.createEl('input', { type: 'checkbox' });
		checkbox.checked = this.showCompleted;
		checkbox.addEventListener('change', () => {
			this.showCompleted = checkbox.checked;
			void this.render();
		});
		toggleLabel.createSpan({ text: `完了タスクを表示 (${completedCount})` });

		const subtaskLabel = toolbarEl.createEl('label', { cls: 'gantt-toggle-completed' });
		const subtaskCheckbox = subtaskLabel.createEl('input', { type: 'checkbox' });
		subtaskCheckbox.checked = this.showSubtasks;
		subtaskCheckbox.addEventListener('change', () => {
			this.showSubtasks = subtaskCheckbox.checked;
			void this.render();
		});
		subtaskLabel.createSpan({ text: `小タスクを表示 (${subtaskCount})` });

		const backlogLabel = toolbarEl.createEl('label', { cls: 'gantt-toggle-completed' });
		const backlogCheckbox = backlogLabel.createEl('input', { type: 'checkbox' });
		backlogCheckbox.checked = this.showBacklog;
		backlogCheckbox.addEventListener('change', () => {
			this.showBacklog = backlogCheckbox.checked;
			void this.render();
		});
		backlogLabel.createSpan({ text: `TODO（受信箱）を表示 (${backlogCount})` });

		const refreshButton = toolbarEl.createEl('button', { text: '🔄 更新' });
		refreshButton.addEventListener('click', () => void this.render());

		const exportButton = toolbarEl.createEl('button', { text: '📤 エクスポート' });
		exportButton.addEventListener('click', () => void this.openExportModal());
	}

	private async openExportModal(): Promise<void> {
		const scheduledTasks = (await collectTasks(this.app))
			.filter((t) => this.showBacklog || !isBacklog(t))
			.filter((t) => this.matchesProjectFilter(t));
		const projectDueDates = loadProjectDueDates(
			this.app,
			this.plugin.settings.projectsFolder,
		);
		const projectNames = [
			...new Set(
				scheduledTasks
					.map((t) => t.project)
					.filter((p): p is string => !!p),
			),
		].sort((a, b) => a.localeCompare(b, 'ja'));

		new GanttExportModal(
			this.app,
			scheduledTasks,
			projectNames,
			projectDueDates,
			this.showCompleted,
		).open();
	}

	private renderGrid(
		container: HTMLElement,
		tasks: TaskItem[],
		dayCells: DayCell[],
	): void {
		const scrollEl = container.createDiv({ cls: 'gantt-scroll' });
		const gridEl = scrollEl.createDiv({ cls: 'gantt-grid' });

		const headerRowEl = gridEl.createDiv({ cls: 'gantt-header-row' });
		headerRowEl.createDiv({ cls: 'gantt-row-label' });
		const headerDaysEl = headerRowEl.createDiv({ cls: 'gantt-header-days' });
		headerDaysEl.style.width = `${dayCells.length * DAY_WIDTH}px`;
		dayCells.forEach((cell) => {
			const cellEl = headerDaysEl.createDiv({ cls: 'gantt-header-cell' });
			if (cell.isWeekend) cellEl.addClass('is-weekend');
			if (cell.isHoliday) cellEl.addClass('is-holiday');
			if (cell.isToday) cellEl.addClass('is-today');
			cellEl.createDiv({ text: cell.label });
			cellEl.createDiv({ cls: 'gantt-header-weekday', text: cell.weekdayLabel });
		});

		const bodyEl = gridEl.createDiv({ cls: 'gantt-body' });
		const groups = groupByProject(tasks);
		if (groups.length === 0) {
			bodyEl.createDiv({
				cls: 'gantt-empty',
				text: '表示できるタスクがありません（開始日または期日を設定してください）',
			});
		}
		groups.forEach((group) => {
			const subCount = group.tasks.reduce(
				(sum, t) => sum + this.visibleSubtasks(t).length,
				0,
			);
			bodyEl.createDiv({
				cls: 'gantt-swimlane-header',
				text:
					subCount > 0
						? `${group.label} (${group.tasks.length} / 小タスク ${subCount})`
						: `${group.label} (${group.tasks.length})`,
			});
			group.tasks.forEach((task) => {
				const subs = this.visibleSubtasks(task);
				// 親タスク行と小チケット行を1つの塊にまとめ、is-collapsed の付け外しだけで
				// 開閉する。再描画しないのでスクロール位置が飛ばない。
				const taskGroupEl = bodyEl.createDiv({ cls: 'gantt-task-group' });
				if (subs.length > 0 && !this.expandedSubtasks.has(taskKey(task))) {
					taskGroupEl.addClass('is-collapsed');
				}
				this.renderTaskRow(taskGroupEl, task, dayCells, subs.length);
				if (subs.length === 0) return;
				const subsEl = taskGroupEl.createDiv({ cls: 'gantt-subtask-rows' });
				subs.forEach((sub) => this.renderSubtaskRow(subsEl, task, sub, dayCells));
			});
		});

		const todayIndex = dayCells.findIndex((c) => c.isToday);
		if (todayIndex >= 0) {
			const lineEl = gridEl.createDiv({ cls: 'gantt-today-line' });
			lineEl.style.left = `${ROW_LABEL_WIDTH + todayIndex * DAY_WIDTH + DAY_WIDTH / 2}px`;
		}
	}

	// parent は「親タスク行＋小チケット行」をまとめた .gantt-task-group。
	// キャレットはこの塊の is-collapsed を付け外しして小チケットを開閉する。
	private renderTaskRow(
		parent: HTMLElement,
		task: TaskItem,
		dayCells: DayCell[],
		subCount = 0,
	): void {
		const rowEl = parent.createDiv({ cls: 'gantt-row' });
		if (isBacklog(task)) rowEl.addClass('is-backlog');

		const labelEl = rowEl.createDiv({ cls: 'gantt-row-label is-parent' });
		if (subCount > 0) {
			const key = taskKey(task);
			const caretEl = labelEl.createSpan({ cls: 'gantt-row-caret' });
			const paintCaret = (): void => {
				const isOpen = this.expandedSubtasks.has(key);
				caretEl.setText(`${isOpen ? '▾' : '▸'}${subCount}`);
				caretEl.setAttr(
					'aria-label',
					isOpen ? '小チケットを閉じる' : `小チケットを開く (${subCount})`,
				);
			};
			paintCaret();
			caretEl.addEventListener('click', (evt) => {
				evt.stopPropagation();
				if (this.expandedSubtasks.has(key)) this.expandedSubtasks.delete(key);
				else this.expandedSubtasks.add(key);
				parent.toggleClass('is-collapsed', !this.expandedSubtasks.has(key));
				paintCaret();
			});
		}
		const titleEl = labelEl.createSpan({
			cls: 'gantt-row-title',
			text: task.text || '(no text)',
		});
		titleEl.addEventListener('click', () => this.openEditModal(task));

		const laneEl = rowEl.createDiv({ cls: 'gantt-lane' });
		laneEl.style.width = `${dayCells.length * DAY_WIDTH}px`;

		if (task.startDate && task.dueDate) {
			const startIdx = this.dateIndex(dayCells, task.startDate);
			const endIdx = Math.max(this.dateIndex(dayCells, task.dueDate), startIdx);
			const barEl = laneEl.createDiv({ cls: 'gantt-bar', text: task.text || '(no text)' });
			if (isBacklog(task)) barEl.addClass('is-backlog');
			if (task.dueDate < todayISO() && task.status !== 'done') barEl.addClass('is-overdue');
			barEl.style.left = `${startIdx * DAY_WIDTH}px`;
			barEl.style.width = `${(endIdx - startIdx + 1) * DAY_WIDTH}px`;
			barEl.addEventListener('click', () => this.openEditModal(task));
		} else if (task.startDate || task.dueDate) {
			const iso = (task.startDate ?? task.dueDate)!;
			const idx = this.dateIndex(dayCells, iso);
			const markerEl = laneEl.createDiv({ cls: 'gantt-marker' });
			if (isBacklog(task)) markerEl.addClass('is-backlog');
			markerEl.style.left = `${idx * DAY_WIDTH + DAY_WIDTH / 2 - 4}px`;
			markerEl.addEventListener('click', () => this.openEditModal(task));
		}

		if (task.startedAt) {
			const actualEndISO = task.completedAt ?? todayISO();
			const startIdx = this.dateIndex(dayCells, task.startedAt);
			const endIdx = Math.max(this.dateIndex(dayCells, actualEndISO), startIdx);
			const actualEl = laneEl.createDiv({ cls: 'gantt-bar-actual' });
			actualEl.style.left = `${startIdx * DAY_WIDTH}px`;
			actualEl.style.width = `${(endIdx - startIdx + 1) * DAY_WIDTH}px`;
		}
	}

	// 小タスクは親タスクの直下に一段下げた行として描く。日程が未設定なら
	// バーの代わりにヒントを出し、クリックでそのまま日程を入力できるようにする。
	private renderSubtaskRow(
		parent: HTMLElement,
		task: TaskItem,
		sub: SubTask,
		dayCells: DayCell[],
	): void {
		const rowEl = parent.createDiv({ cls: 'gantt-row is-subtask' });
		const text = sub.text || '(no text)';

		const labelEl = rowEl.createDiv({
			cls: 'gantt-row-label is-subtask',
			text: `└ ${text}`,
		});
		if (sub.checked) labelEl.addClass('is-done');
		labelEl.addEventListener('click', () => this.openSubtaskEditModal(task, sub));

		const laneEl = rowEl.createDiv({ cls: 'gantt-lane is-subtask' });
		laneEl.style.width = `${dayCells.length * DAY_WIDTH}px`;

		if (sub.startDate && sub.dueDate) {
			const startIdx = this.dateIndex(dayCells, sub.startDate);
			const endIdx = Math.max(this.dateIndex(dayCells, sub.dueDate), startIdx);
			const barEl = laneEl.createDiv({ cls: 'gantt-bar is-subtask', text });
			if (sub.checked) barEl.addClass('is-done');
			else if (sub.dueDate < todayISO()) barEl.addClass('is-overdue');
			barEl.style.left = `${startIdx * DAY_WIDTH}px`;
			barEl.style.width = `${(endIdx - startIdx + 1) * DAY_WIDTH}px`;
			barEl.addEventListener('click', () => this.openSubtaskEditModal(task, sub));
			return;
		}

		if (sub.startDate || sub.dueDate) {
			const iso = (sub.startDate ?? sub.dueDate)!;
			const idx = this.dateIndex(dayCells, iso);
			const markerEl = laneEl.createDiv({ cls: 'gantt-marker is-subtask' });
			markerEl.style.left = `${idx * DAY_WIDTH + DAY_WIDTH / 2 - 4}px`;
			markerEl.addEventListener('click', () => this.openSubtaskEditModal(task, sub));
			return;
		}

		const hintEl = laneEl.createDiv({
			cls: 'gantt-lane-hint',
			text: '日程未設定（クリックして入力）',
		});
		hintEl.addEventListener('click', () => this.openSubtaskEditModal(task, sub));
	}

	private openSubtaskEditModal(task: TaskItem, sub: SubTask): void {
		new SubtaskEditModal(
			this.app,
			'小タスクの日程',
			{ text: sub.text, startDate: sub.startDate, dueDate: sub.dueDate },
			async (fields) => {
				await editSubtask(this.app, task.filePath, sub.line, fields);
				await this.render();
			},
		).open();
	}

	// 下部パネルは <details> で開閉する。開閉状態はビュー側に持ち回すので、
	// ファイル変更による再描画をはさんでも畳んだまま／開いたままを維持できる。
	private createCollapsiblePanel(
		container: HTMLElement,
		cls: string,
		title: string,
		isOpen: boolean,
		onToggle: (open: boolean) => void,
	): HTMLElement {
		const panelEl = container.createEl('details', { cls: `gantt-panel ${cls}` });
		panelEl.open = isOpen;
		panelEl.createEl('summary', { cls: 'gantt-panel-summary', text: title });
		panelEl.addEventListener('toggle', () => onToggle(panelEl.open));
		return panelEl.createDiv({ cls: 'gantt-panel-body' });
	}

	private renderUnscheduled(container: HTMLElement, tasks: TaskItem[]): void {
		const missing = tasks.filter((t) => !t.startDate || !t.dueDate);
		if (missing.length === 0) return;

		const listEl = this.createCollapsiblePanel(
			container,
			'gantt-unscheduled',
			`📅 日程が未設定のタスク (${missing.length})`,
			this.unscheduledPanelOpen,
			(open) => {
				this.unscheduledPanelOpen = open;
			},
		);
		missing.forEach((task) => {
			const missingLabel =
				!task.startDate && !task.dueDate
					? '開始日・期日とも未設定'
					: !task.startDate
						? '開始日が未設定'
						: '期日が未設定';
			const itemEl = listEl.createDiv({
				cls: 'gantt-unscheduled-item',
				text: `${task.text || '(no text)'} — ${missingLabel}`,
			});
			itemEl.addEventListener('click', () => this.openEditModal(task));
		});
	}

	private renderRiskPanel(container: HTMLElement, risks: GanttRisk[]): void {
		const bodyEl = this.createCollapsiblePanel(
			container,
			'gantt-risk-panel',
			`⚠️ リスク・注意事項 (${risks.length})`,
			this.riskPanelOpen,
			(open) => {
				this.riskPanelOpen = open;
			},
		);
		if (risks.length === 0) {
			bodyEl.createDiv({ cls: 'gantt-risk-empty', text: '検出されたリスクはありません' });
			return;
		}
		risks.forEach((risk) => {
			const itemEl = bodyEl.createDiv({
				cls: `gantt-risk-item is-${risk.level}`,
				text: risk.message,
			});
			if (risk.filePath && risk.line !== null) {
				itemEl.addClass('is-clickable');
				const filePath = risk.filePath;
				const line = risk.line;
				itemEl.addEventListener('click', () => void this.openTaskSource(filePath, line));
			}
		});
	}

	private async openTaskSource(filePath: string, line: number): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) return;
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file, { eState: { line } });
	}

	private openEditModal(task: TaskItem): void {
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
			listProjectNames(this.app, this.plugin.settings.projectsFolder),
			async (fields) => {
				await editTask(this.app, task.filePath, task.line, fields);
				await this.render();
			},
		).open();
	}
}

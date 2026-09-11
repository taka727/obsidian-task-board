import { App, Modal, Notice, Setting, TFile, normalizePath } from 'obsidian';
import { todayISO } from './dateUtils';
import { buildExportRows, ExportFormat, toCSV, toMarkdown } from './ganttExport';
import { computeRisks } from './ganttRisk';
import { TaskItem } from './types';

const EXPORT_FOLDER = '_exports';
const SCOPE_ALL = 'ALL';
const SCOPE_NONE = 'NONE';
const ALL_LABEL = 'すべての案件（まとめて出力）';
const NONE_LABEL = '（案件なし）のタスクのみ';

export class GanttExportModal extends Modal {
	private format: ExportFormat = 'markdown';
	private exportScope: string = SCOPE_ALL;
	private includeCompleted: boolean;

	constructor(
		app: App,
		private tasks: TaskItem[],
		private projectOptions: string[],
		private projectDueDates: Map<string, string>,
		initialIncludeCompleted: boolean,
	) {
		super(app);
		this.includeCompleted = initialIncludeCompleted;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'ガントチャートの出力' });

		new Setting(contentEl).setName('出力形式').addDropdown((dropdown) => {
			dropdown
				.addOption('markdown', 'Markdown（表＋リスク一覧）')
				.addOption('csv', 'CSV（Excel等で開けます）')
				.setValue(this.format)
				.onChange((v) => (this.format = v as ExportFormat));
		});

		new Setting(contentEl).setName('対象').addDropdown((dropdown) => {
			dropdown.addOption(SCOPE_ALL, ALL_LABEL);
			this.projectOptions.forEach((name) => {
				dropdown.addOption(name, name);
			});
			dropdown.addOption(SCOPE_NONE, NONE_LABEL);
			dropdown.setValue(this.exportScope).onChange((v) => (this.exportScope = v));
		});

		new Setting(contentEl).setName('完了タスクを含める').addToggle((toggle) => {
			toggle.setValue(this.includeCompleted).onChange((v) => (this.includeCompleted = v));
		});

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText('出力')
				.setCta()
				.onClick(() => void this.runExport()),
		);
	}

	private scopeLabel(): string {
		if (this.exportScope === SCOPE_ALL) return '全案件';
		if (this.exportScope === SCOPE_NONE) return '案件なし';
		return this.exportScope;
	}

	private async runExport(): Promise<void> {
		let targetTasks = this.tasks;
		if (this.exportScope === SCOPE_NONE) {
			targetTasks = targetTasks.filter((t) => !t.project);
		} else if (this.exportScope !== SCOPE_ALL) {
			targetTasks = targetTasks.filter((t) => t.project === this.exportScope);
		}
		if (!this.includeCompleted) {
			targetTasks = targetTasks.filter((t) => t.status !== 'done');
		}

		if (targetTasks.length === 0) {
			new Notice('出力対象のタスクがありません');
			return;
		}

		const rows = buildExportRows(targetTasks);
		const dateStamp = todayISO();
		const scopeLabel = this.scopeLabel();

		let content: string;
		let ext: string;
		if (this.format === 'markdown') {
			const risks = computeRisks(targetTasks, this.projectDueDates);
			content = toMarkdown(rows, risks, `工程表: ${scopeLabel}（${dateStamp}時点）`);
			ext = 'md';
		} else {
			content = toCSV(rows);
			ext = 'csv';
		}

		if (!this.app.vault.getAbstractFileByPath(EXPORT_FOLDER)) {
			await this.app.vault.createFolder(EXPORT_FOLDER);
		}
		const path = normalizePath(
			`${EXPORT_FOLDER}/ガント_${scopeLabel}_${dateStamp}.${ext}`,
		);

		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(path, content);
		}

		new Notice(`出力しました: ${path}`);
		this.close();

		if (this.format === 'markdown') {
			await this.app.workspace.openLinkText(path, '', false);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

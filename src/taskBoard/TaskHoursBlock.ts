import { MarkdownRenderChild, TFile } from 'obsidian';
import type MyPlugin from '../main';
import {
	collectHourEntriesInFile,
	projectLabelFromPath,
	roundHours,
	sumHoursByProject,
} from './hoursIndex';

// 日次ノートの「今日の作業時間（案件ごと）」ブロック。
// 元はdataviewjsで実装していたが（このファイルが書かれた行の[[リンク]]+(hours::N)を
// 自ノート内だけ集計するもの）、dataviewjsを介さず読めるよう自作コードブロックに置き換えた。
// 表示内容・集計ロジックは元のdataviewjsブロックと同じ。
class TaskHoursChild extends MarkdownRenderChild {
	constructor(
		containerEl: HTMLElement,
		private plugin: MyPlugin,
		private sourcePath: string,
	) {
		super(containerEl);
	}

	onload(): void {
		void this.render();
		this.registerEvent(
			this.plugin.app.vault.on('modify', (file) => {
				if (file instanceof TFile && file.path === this.sourcePath) void this.render();
			}),
		);
	}

	private async render(): Promise<void> {
		this.containerEl.empty();
		this.containerEl.addClass('task-hours-container');

		const file = this.plugin.app.vault.getFileByPath(this.sourcePath);
		if (!file) {
			this.containerEl.createDiv({
				cls: 'task-inbox-empty',
				text: 'ファイルが見つかりませんでした。',
			});
			return;
		}

		const entries = await collectHourEntriesInFile(this.plugin.app, file);
		const totals = sumHoursByProject(entries);

		if (totals.size === 0) {
			this.containerEl.createDiv({
				cls: 'task-inbox-empty',
				text: 'まだ工数が入力されていません。',
			});
			return;
		}

		const rows = [...totals.entries()].sort((a, b) =>
			projectLabelFromPath(a[0]).localeCompare(projectLabelFromPath(b[0]), 'ja'),
		);

		const table = this.containerEl.createEl('table', { cls: 'task-hours-table' });
		const headRow = table.createEl('thead').createEl('tr');
		headRow.createEl('th', { text: '案件' });
		headRow.createEl('th', { text: '時間' });

		const tbody = table.createEl('tbody');
		let total = 0;
		for (const [projectPath, hours] of rows) {
			total += hours;
			const row = tbody.createEl('tr');
			const nameCell = row.createEl('td');
			const nameLink = nameCell.createSpan({
				cls: 'internal-link is-clickable',
				text: projectLabelFromPath(projectPath),
			});
			nameLink.addEventListener('click', () => {
				void this.plugin.app.workspace.openLinkText(
					projectPath,
					this.sourcePath,
					false,
				);
			});
			row.createEl('td', { text: `${roundHours(hours)}h` });
		}

		this.containerEl.createEl('p', {
			cls: 'task-hours-total',
			text: `合計: ${roundHours(total)}h`,
		});
	}
}

export function registerTaskHoursBlock(plugin: MyPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor('task-hours', (_source, el, ctx) => {
		ctx.addChild(new TaskHoursChild(el, plugin, ctx.sourcePath));
	});
}

import { MarkdownRenderChild, TFile } from 'obsidian';
import type MyPlugin from '../main';
import { isBusinessDay, loadHolidays, todayISO } from './dateUtils';
import {
	collectHourEntriesInFile,
	HourEntry,
	projectLabelFromPath,
	roundHours,
	sumHoursByProject,
} from './hoursIndex';

// 日次ノートのファイル名（01_Daily/YYYY-MM-DD.md）から年月を判定するための正規表現。
// 案件フォルダと違い、こちらは folder_templates 等では設定化されていないので
// ダッシュボード.mdの元dataviewjsブロックと同じくハードコードする。
const DAILY_NOTES_FOLDER = '01_Daily';
const DAILY_NOTE_NAME_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// ダッシュボード.mdの「案件別 工数消化状況（今月）」ブロック。
// 元はdataviewjsで実装していたが、dataviewjsを介さず読めるよう自作コードブロックに置き換えた。
// 集計ロジック・表示列は元のブロックと同じ:
//   案件名 / 人月 / 今月の割当時間 / 今月の使用時間(集計) / 残り時間
class TaskCapacityChild extends MarkdownRenderChild {
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
				if (!(file instanceof TFile)) return;
				if (
					file.path.startsWith(`${DAILY_NOTES_FOLDER}/`) ||
					file.path.startsWith(`${this.plugin.settings.projectsFolder}/`)
				) {
					void this.render();
				}
			}),
		);
	}

	private async render(): Promise<void> {
		this.containerEl.empty();
		this.containerEl.addClass('task-capacity-container');

		const holidays = await loadHolidays(this.plugin.app);
		const today = new Date(`${todayISO()}T00:00:00`);
		const year = today.getFullYear();
		const month = today.getMonth() + 1; // 1-12
		const daysInMonth = new Date(year, month, 0).getDate();

		let businessDays = 0;
		for (let d = 1; d <= daysInMonth; d++) {
			const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
			if (isBusinessDay(dateStr, holidays)) businessDays++;
		}
		const hoursPerPersonMonth = businessDays * 8;

		this.containerEl.createEl('p', {
			text: `${year}年${month}月の営業日数: ${businessDays}日（1人月 = ${hoursPerPersonMonth}時間）`,
		});

		const projectsFolder = this.plugin.settings.projectsFolder;
		const projects = this.plugin.app.vault
			.getMarkdownFiles()
			.filter((f) => f.path.startsWith(`${projectsFolder}/`))
			.map((f) => {
				const frontmatter: Record<string, unknown> | undefined =
					this.plugin.app.metadataCache.getFileCache(f)?.frontmatter;
				const personMonths: unknown = frontmatter?.['person_months'];
				return { file: f, personMonths };
			})
			.filter(
				(p) => p.personMonths !== undefined && p.personMonths !== null && p.personMonths !== '',
			)
			.sort((a, b) => a.file.basename.localeCompare(b.file.basename, 'ja'));

		if (projects.length === 0) {
			this.containerEl.createDiv({
				cls: 'task-inbox-empty',
				text: '`person_months` が設定されている案件がありません。',
			});
			return;
		}

		// 今月の日次ノートから工数エントリを収集する。
		const dailyFiles = this.plugin.app.vault.getMarkdownFiles().filter((f) => {
			if (!f.path.startsWith(`${DAILY_NOTES_FOLDER}/`)) return false;
			const match = DAILY_NOTE_NAME_RE.exec(f.basename);
			if (!match) return false;
			return Number(match[1]) === year && Number(match[2]) === month;
		});

		const allEntries: HourEntry[] = [];
		for (const f of dailyFiles) {
			allEntries.push(...(await collectHourEntriesInFile(this.plugin.app, f)));
		}
		const totals = sumHoursByProject(allEntries);

		const table = this.containerEl.createEl('table', { cls: 'task-capacity-table' });
		const headRow = table.createEl('thead').createEl('tr');
		['案件名', '人月', '今月の割当時間', '今月の使用時間(集計)', '残り時間'].forEach(
			(text) => headRow.createEl('th', { text }),
		);

		const tbody = table.createEl('tbody');
		for (const p of projects) {
			const personMonths = Number(p.personMonths);
			const allocated = roundHours(personMonths * hoursPerPersonMonth);
			const used = roundHours(totals.get(p.file.path) ?? 0);
			const remaining = roundHours(allocated - used);

			const row = tbody.createEl('tr');
			const nameCell = row.createEl('td');
			const nameLink = nameCell.createSpan({
				cls: 'internal-link is-clickable',
				text: projectLabelFromPath(p.file.path),
			});
			nameLink.addEventListener('click', () => {
				void this.plugin.app.workspace.openLinkText(p.file.path, '', false);
			});
			row.createEl('td', { text: String(personMonths) });
			row.createEl('td', { text: `${allocated}h` });
			row.createEl('td', { text: `${used}h` });
			const remainingCell = row.createEl('td', { text: `${remaining}h` });
			if (remaining < 0) remainingCell.addClass('task-capacity-over');
		}
	}
}

export function registerTaskCapacityBlock(plugin: MyPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor('task-capacity', (_source, el, ctx) => {
		ctx.addChild(new TaskCapacityChild(el, plugin));
	});
}

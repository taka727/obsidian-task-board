import { MarkdownRenderChild, Notice, TFile } from 'obsidian';
import type MyPlugin from '../main';
import { TASK_LINE_RE, parseTaskLine } from './taskIndex';
import { appendRawLines, buildLine } from './taskMutator';

const HEADING_RE = /^##\s+タスク追加\s*$/;
const H2_RE = /^##\s+/;

interface Section {
	start: number;
	end: number;
}

function findTaskAddSection(lines: string[]): Section | null {
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		if (HEADING_RE.test(lines[i]!)) {
			start = i;
			break;
		}
	}
	if (start === -1) return null;

	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (H2_RE.test(lines[i]!)) {
			end = i;
			break;
		}
	}
	return { start, end };
}

// 「## タスク追加」配下に手書きされた `- [ ]` 行を集め、Tasks.md へ #todo（未着手）
// として登録した上で、日次ノート側からは削除する（＝バックログではなく今日やる前提で登録）。
class TaskShareChild extends MarkdownRenderChild {
	private statusEl!: HTMLElement;

	constructor(
		containerEl: HTMLElement,
		private plugin: MyPlugin,
		private sourcePath: string,
	) {
		super(containerEl);
	}

	onload(): void {
		this.containerEl.empty();
		this.containerEl.addClass('task-share-container');

		const button = this.containerEl.createEl('button', {
			cls: 'task-share-button',
			text: '📤 共有',
		});
		button.addEventListener('click', () => void this.share(button));

		this.statusEl = this.containerEl.createDiv({ cls: 'task-share-status' });
	}

	private async share(button: HTMLButtonElement): Promise<void> {
		button.disabled = true;
		try {
			const count = await this.doShare();
			this.statusEl.setText(
				count === 0
					? '共有するタスクがありません'
					: `${count}件をタスクボードへ共有しました`,
			);
		} catch (err) {
			console.error('task-share: failed', err);
			new Notice(`タスクの共有に失敗しました: ${String(err)}`);
		} finally {
			button.disabled = false;
		}
	}

	private async doShare(): Promise<number> {
		const app = this.plugin.app;
		const file = app.vault.getAbstractFileByPath(this.sourcePath);
		if (!(file instanceof TFile)) return 0;

		const content = await app.vault.read(file);
		const lines = content.split('\n');
		const section = findTaskAddSection(lines);
		if (!section) return 0;

		const toRemove: number[] = [];
		const toAppend: string[] = [];
		let parentCount = 0;

		let i = section.start + 1;
		while (i < section.end) {
			const line = lines[i]!;
			const match = TASK_LINE_RE.exec(line);
			if (!match) {
				i++;
				continue;
			}
			const indent = /^\s*/.exec(line)![0].length;
			if (indent !== 0) {
				i++;
				continue;
			}

			const checked = match[2]!.toLowerCase() === 'x';
			const parsed = parseTaskLine(checked, match[4]!);
			toRemove.push(i);
			toAppend.push(
				buildLine(
					'- [',
					'] ',
					false,
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
				),
			);
			parentCount++;

			let j = i + 1;
			while (j < section.end) {
				const childLine = lines[j]!;
				const childMatch = TASK_LINE_RE.exec(childLine);
				if (!childMatch) break;
				const childIndent = /^\s*/.exec(childLine)![0].length;
				if (childIndent <= indent) break;
				toAppend.push(childLine);
				toRemove.push(j);
				j++;
			}
			i = j;
		}

		if (toAppend.length === 0) return 0;

		// 先にTasks.mdへの追記を確定させてから、成功した場合だけ元の行を消す
		await appendRawLines(app, this.plugin.settings.taskBoardFile, toAppend);

		const remaining = lines.filter((_, idx) => !toRemove.includes(idx));
		await app.vault.modify(file, remaining.join('\n'));

		return parentCount;
	}
}

export function registerTaskShareBlock(plugin: MyPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor('task-share', (_source, el, ctx) => {
		ctx.addChild(new TaskShareChild(el, plugin, ctx.sourcePath));
	});
}

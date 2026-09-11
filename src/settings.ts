import { App, PluginSettingTab, Setting } from 'obsidian';
import MyPlugin from './main';

export interface MyPluginSettings {
	taskBoardFile: string;
	projectsFolder: string;
}

export const DEFAULT_SETTINGS: MyPluginSettings = {
	taskBoardFile: 'Tasks.md',
	projectsFolder: '03_Projects',
};

export class SampleSettingTab extends PluginSettingTab {
	plugin: MyPlugin;

	constructor(app: App, plugin: MyPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('タスクボードの保存先ファイル')
			.setDesc(
				'タスクボードでカードを新規追加した際に書き込むMarkdownファイルのパス',
			)
			.addText((text) =>
				text
					.setPlaceholder('Tasks.md')
					.setValue(this.plugin.settings.taskBoardFile)
					.onChange(async (value) => {
						this.plugin.settings.taskBoardFile = value || 'Tasks.md';
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('案件フォルダ')
			.setDesc(
				'カードの「案件」ラベルが参照するプロジェクトノートの格納フォルダ',
			)
			.addText((text) =>
				text
					.setPlaceholder('03_Projects')
					.setValue(this.plugin.settings.projectsFolder)
					.onChange(async (value) => {
						this.plugin.settings.projectsFolder = value || '03_Projects';
						await this.plugin.saveSettings();
					}),
			);
	}
}

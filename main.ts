import { Plugin, MarkdownView, TAbstractFile, PluginSettingTab, App, Setting, TFile, Notice } from 'obsidian';

class CuboxSettings {
  targetFolder: string = '';
  geminiApiKey: string = '';
}

class CuboxSettingTab extends PluginSettingTab {
  plugin: CuboxPlugin;

  constructor(app: App, plugin: CuboxPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    let { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Target folder')
      .setDesc('Enter the path of the folder you want to use.')
      .addText(text => text
        .setValue(this.plugin.settings.targetFolder)
        .onChange(async (value) => {
          this.plugin.settings.targetFolder = value;
          await this.plugin.saveData(this.plugin.settings);
       }));

	new Setting(containerEl)
	.setName('Gemini API Key')
	.setDesc('输入你的 Google Gemini API Key')
	.addText(text => text
		.setValue(this.plugin.settings.geminiApiKey || "")
		.onChange(async (value) => {
			this.plugin.settings.geminiApiKey = value.trim();
			await this.plugin.saveData(this.plugin.settings);
		}));
  }
}

export default class CuboxPlugin extends Plugin {
	settings: CuboxSettings;

	async onload() {
		this.settings = await this.loadData() || new CuboxSettings();
    this.addSettingTab(new CuboxSettingTab(this.app, this));

		this.registerEvent(this.app.vault.on('create', async (file: TAbstractFile) => {
			if (!this.settings.targetFolder) return;

			console.log("before insert created attribute:")
			if (file instanceof TFile && file.parent?.path === this.settings.targetFolder) {
				console.log("check created attribute:")
				const now = new Date();
				const formatted = now.getFullYear() + '-' +
					String(now.getMonth() + 1).padStart(2, '0') + '-' +
					String(now.getDate()).padStart(2, '0');

				// 读取原内容
				let content = await this.app.vault.read(file);
				// 如果没有 front matter，就加上
				if (!content.startsWith('---')) {
					content = `---\ncreated: ${formatted}\n---\n` + content;
					await this.app.vault.modify(file, content);
				} else {
					// 有 front matter 的情况，可以插入到里面
					const lines = content.split('\n');
					lines.splice(1, 0, `created: ${formatted}`);
					await this.app.vault.modify(file, lines.join('\n'));
				}
			}
			
			if (file.name.includes('.md') && file.parent?.path === this.settings.targetFolder) {
				setTimeout(() => {
					const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
					if (!markdownView) return;
					this.batchDelete(markdownView);
				}, 1000);
			}
		}));

		this.addCommand({
			id: 'format-cubox-annotation',
			name: 'Format cubox annotation',
			checkCallback: (checking: boolean) => {
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					if (!checking) {
						this.batchDelete(markdownView);
					}
					return true;
				}
				return false;
			}
		});


    this.addCommand({
  id: 'ask-gemini',
  name: 'Ask Gemini (LLM)',
  editorCallback: async (editor, view) => {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("未找到当前文件");
      return;
    }

    if (file.parent?.path !== this.settings.targetFolder) {
      new Notice("该命令只对目标文件夹生效: " + this.settings.targetFolder);
      return;
    }

    const doc = editor.getDoc();
    const fullContent = doc.getValue();
    if (!fullContent.trim()) {
      new Notice("笔记内容为空，无法生成总结");
      return;
    }

    const prompt = `用100 字以内总结下内容:\n${fullContent}`;

    const totalLines = doc.lineCount();
    let summaryLine = -1;

    // 查找 "# 总结" 标题
    for (let i = 0; i < totalLines; i++) {
      if (doc.getLine(i).trim() === "# 总结") {
        summaryLine = i;
        break;
      }
    }

    let insertLine: number;

    if (summaryLine === -1) {
      // 没有总结标题，末尾添加
      doc.replaceRange("\n# 总结\n- 正在生成总结...\n", { line: totalLines, ch: 0 });
      insertLine = totalLines + 1; // 临时提示行
    } else {
      // 有总结标题，检查标题下一行是否已经有“正在生成总结”
      if (doc.getLine(summaryLine + 1)?.includes("正在生成总结...") ||
          doc.getLine(summaryLine + 1)?.startsWith("- ")) {
        insertLine = summaryLine + 1;
        doc.replaceRange("- 正在生成总结...", { line: insertLine, ch: 0 }, { line: insertLine, ch: doc.getLine(insertLine).length });
      } else {
        insertLine = summaryLine + 1;
        doc.replaceRange("- 正在生成总结...\n", { line: insertLine, ch: 0 });
      }
    }

    const answer = await this.askGemini(prompt);
    if (!answer) return;

    // 替换临时文本为真实总结
    doc.replaceRange("- " + answer, { line: insertLine, ch: 0 }, { line: insertLine, ch: doc.getLine(insertLine).length });
  }
});

	}

	batchDelete(markdownView: MarkdownView) {
		const editor = markdownView.editor;
		const doc = editor.getDoc();

		let totalLines = doc.lineCount();
		for (let lineNumber = 0; lineNumber < totalLines; lineNumber++) {
			let line = doc.getLine(lineNumber);
			const matchCubeBox = line.match(/cubox:\/\/(\S*)/);
			const matchWebLink = line.match(/https:\/\/cubox.pro\/my\/highlight\?id=(\S*)/);
			const matchH1 = line.match(/^#\s+/); // Matches h1 tags at the beginning of the line
			console.log(line);
			// Delete the line if it has a link, if it's a h1 tag, or if it's empty
			if (matchCubeBox || matchWebLink || matchH1) {
				doc.replaceRange('', { line: lineNumber, ch: 0 }, { line: lineNumber + 1, ch: 0 });
				lineNumber--;
				totalLines--;
			}
		}

		// Deletes the last line if it has any form of http or https link
		const lastLine = doc.getLine(totalLines - 1);
		const matchLastLineWebLink = lastLine.match(/https?:\/\/(\S*)/); // Matches any form of http or https link

		if (matchLastLineWebLink) {
			doc.replaceRange('', { line: totalLines - 1, ch: 0 }, { line: totalLines, ch: 0 });
		}
	}

    // ✅ 定义 askGemini
  async askGemini(prompt: string): Promise<string | null> {
    if (!this.settings.geminiApiKey) {
      new Notice("请先在设置中输入 Gemini API Key");
      return null;
    }

    try {
          const resp = await fetch("https://api.deepseek.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.settings.geminiApiKey}`, // 复用 geminiApiKey 字段
          },
          body: JSON.stringify({
            model: "deepseek-chat", // 使用 deepseek-chat 模型
            messages: [
              { role: "system", content: "You are a helpful assistant." },
              { role: "user", content: prompt }
            ],
            stream: false
          }),
        });

          if (!resp.ok) throw new Error("API error: " + resp.statusText);

          const data = await resp.json();
          return data?.choices?.[0]?.message?.content || "⚠️ Gemini 没有返回结果";
        } catch (err) {
          console.error(err);
          new Notice("调用 Gemini 失败: " + (err as Error).message);
          return null;
        }
      }

}
import { App, Modal, Setting, SuggestModal, TFile, TFolder } from "obsidian";
import { ROOT_LABELS, ROOT_OBS, AttachPathSettings } from "./settings";

export class FieldPicker extends SuggestModal<string> {
  private fields: string[];
  private cb: (field: string) => void;

  constructor(app: App, fields: string[], cb: (field: string) => void) {
    super(app);
    this.fields = fields;
    this.cb = cb;
    this.setPlaceholder("选择字段…");
  }

  getSuggestions(q: string): string[] {
    const l = q.toLowerCase();
    return this.fields.filter(f => f.toLowerCase().includes(l));
  }

  renderSuggestion(f: string, el: HTMLElement): void {
    el.createEl("div", { text: f });
  }

  onChooseSuggestion(f: string): void {
    this.cb(f);
  }
}

export class ConfirmModal extends Modal {
  private title_: string;
  private msg: string;
  private onConfirm: () => void;

  constructor(app: App, title: string, msg: string, onConfirm: () => void) {
    super(app);
    this.title_ = title;
    this.msg = msg;
    this.onConfirm = onConfirm;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: this.title_ });
    contentEl.createEl("p", { text: this.msg });
    new Setting(contentEl)
      .addButton(b => b.setButtonText("取消").onClick(() => this.close()))
      .addButton(b =>
        b.setButtonText("继续").setCta().onClick(() => {
          this.close();
          this.onConfirm();
        }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export interface OverridePlugin {
  app: App;
  settings: { overridePath: Record<string, AttachPathSettings> };
  saveSettings(): Promise<void>;
}

export class OverrideModal extends Modal {
  private plugin: OverridePlugin;
  private file: TFile | TFolder;
  private setting: AttachPathSettings;

  constructor(plugin: OverridePlugin, file: TFile | TFolder, setting: AttachPathSettings) {
    super(plugin.app);
    this.plugin = plugin;
    this.file = file;
    this.setting = setting;
  }

  onOpen(): void {
    const { contentEl } = this;
    const s = this.setting;
    const isFolder = this.file instanceof TFolder;
    contentEl.createEl("h3", { text: `覆盖设置：${this.file.path}` });

    new Setting(contentEl).setName("存储位置").addDropdown(d => {
      for (const [k, v] of Object.entries(ROOT_LABELS)) d.addOption(k, v);
      d.setValue(s.saveAttE || ROOT_OBS).onChange(v => (s.saveAttE = v));
    });
    new Setting(contentEl)
      .setName("附件根目录")
      .setDesc("仅在「子文件夹」或「笔记同级」模式下生效")
      .addText(t =>
        t
          .setValue(s.attachmentRoot || "")
          .setPlaceholder("attachment/media")
          .onChange(v => (s.attachmentRoot = v)),
      );
    new Setting(contentEl)
      .setName("附件子路径")
      .setDesc("变量：${notename} ${notepath} ${parent} ${date}")
      .addText(t =>
        t
          .setValue(s.attachmentPath || "")
          .setPlaceholder("${notepath}/${notename}")
          .onChange(v => (s.attachmentPath = v)),
      );
    new Setting(contentEl)
      .setName("附件命名格式")
      .setDesc("变量：${date} ${notename} ${originalname} ${md5}")
      .addText(t =>
        t
          .setValue(s.attachFormat || "")
          .setPlaceholder("img-${date}")
          .onChange(v => (s.attachFormat = v)),
      );
    new Setting(contentEl)
      .addButton(b => b.setButtonText("取消").onClick(() => this.close()))
      .addButton(b =>
        b
          .setButtonText("保存")
          .setCta()
          .onClick(async () => {
            s.type = isFolder ? "FOLDER" : "FILE";
            this.plugin.settings.overridePath[this.file.path] = s;
            await this.plugin.saveSettings();
            this.close();
          }),
      );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

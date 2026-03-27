/* eslint-disable obsidianmd/ui/sentence-case */
import { PluginSettingTab, App, Setting, Notice, Plugin } from "obsidian";
import {
  ROOT_LABELS,
  ROOT_OBS,
  PATH_FMTS,
  AttachmentHubSettings,
} from "./settings";
import { testFFmpeg } from "./ffmpeg-handler";

export interface SettingsPlugin extends Plugin {
  settings: AttachmentHubSettings;
  saveSettings(): Promise<void>;
}

export class AttachmentHubSettingTab extends PluginSettingTab {
  plugin: SettingsPlugin;

  constructor(app: App, plugin: SettingsPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl: el } = this;
    el.empty();
    ;

    // ── 附件存储 ──
    new Setting(el).setName("附件存储").setHeading();

    new Setting(el)
      .setName("存储位置")
      .setDesc("新附件的存储位置。「跟随 Obsidian 设置」使用 vault 的附件文件夹配置。")
      .addDropdown(d => {
        for (const [k, v] of Object.entries(ROOT_LABELS)) d.addOption(k, v);
        d.setValue(this.plugin.settings.attachPath.saveAttE || ROOT_OBS).onChange(async v => {
          this.plugin.settings.attachPath.saveAttE = v;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    if (this.plugin.settings.attachPath.saveAttE !== ROOT_OBS) {
      new Setting(el)
        .setName("附件根目录")
        .setClass("fps-sub-setting")
        .addText(t =>
          t
            .setValue(this.plugin.settings.attachPath.attachmentRoot || "")
            .setPlaceholder("attachment/media")
            .onChange(async v => {
              this.plugin.settings.attachPath.attachmentRoot = v;
              await this.plugin.saveSettings();
            }),
        );
    }

    new Setting(el)
      .setName("附件子路径")
      .setDesc("根目录下的子文件夹。变量：${notename} ${notepath} ${parent} ${date}")
      .addText(t =>
        t
          .setValue(this.plugin.settings.attachPath.attachmentPath || "")
          .setPlaceholder("例如 ${notename}")
          .onChange(async v => {
            this.plugin.settings.attachPath.attachmentPath = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(el)
      .setName("附件命名格式")
      .setDesc("粘贴/拖拽文件的命名规则。变量：${date} ${notename} ${originalname} ${md5}")
      .addText(t =>
        t
          .setValue(this.plugin.settings.attachPath.attachFormat || "")
          .setPlaceholder("img-${date}")
          .onChange(async v => {
            this.plugin.settings.attachPath.attachFormat = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(el)
      .setName("日期格式")
      .setDesc("${date} 变量使用的 Moment.js 格式")
      .addText(t =>
        t
          .setValue(this.plugin.settings.dateFormat || "")
          .setPlaceholder("YYYYMMDDHHmmssSSS")
          .onChange(async v => {
            this.plugin.settings.dateFormat = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(el)
      .setName("附件移动/重命名时更新路径")
      .setDesc("当被追踪的附件移动或重命名时，自动更新 frontmatter 和正文中的链接。")
      .addToggle(t =>
        t.setValue(this.plugin.settings.handleAttachmentMove).onChange(async v => {
          this.plugin.settings.handleAttachmentMove = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName("笔记移动/重命名时更新路径")
      .setDesc("笔记移动时自动重新计算 frontmatter 和正文中的相对路径。")
      .addToggle(t =>
        t.setValue(this.plugin.settings.handleNoteMove).onChange(async v => {
          this.plugin.settings.handleNoteMove = v;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(el)
      .setName("附件删除时清空字段")
      .setDesc("当引用的附件被删除时，自动清空对应的 frontmatter 字段。")
      .addToggle(t =>
        t.setValue(this.plugin.settings.clearOnDelete).onChange(async v => {
          this.plugin.settings.clearOnDelete = v;
          await this.plugin.saveSettings();
        }),
      );

    // ── 扩展名覆盖 ──
    new Setting(el).setName("扩展名覆盖").setHeading();
    el.createEl("p", {
      text: "针对不同文件扩展名设置独立的命名格式。扩展名支持正则匹配。",
      cls: "setting-item-description",
    });

    const eoContainer = el.createDiv("fps-ext-container");
    this._renderExtOverrides(eoContainer);

    new Setting(el).addButton(b =>
      b.setButtonText("添加扩展名规则").onClick(async () => {
        this.plugin.settings.attachPath.extensionOverride.push({
          extension: "",
          attachmentRoot: "",
          saveAttE: ROOT_OBS,
          attachmentPath: "",
          attachFormat: "img-${date}",
        });
        await this.plugin.saveSettings();
        this._renderExtOverrides(eoContainer);
      }),
    );

    // ── Frontmatter 同步 ──
    new Setting(el).setName("Frontmatter 同步").setHeading();

    new Setting(el)
      .setName("路径格式")
      .setDesc("frontmatter 字段中附件路径的存储格式。")
      .addDropdown(d => {
        for (const [k, v] of Object.entries(PATH_FMTS)) d.addOption(k, v);
        d.setValue(this.plugin.settings.pathFormat || "plain").onChange(async v => {
          this.plugin.settings.pathFormat = v;
          await this.plugin.saveSettings();
        });
      });

    new Setting(el).setName("追踪字段").setHeading();
    el.createEl("p", {
      text: "包含附件路径的 frontmatter 字段名。",
      cls: "setting-item-description",
    });
    const fc = el.createDiv("fps-fields-container");
    this._renderFields(fc);
    new Setting(el).addButton(b =>
      b
        .setButtonText("添加字段")
        .setCta()
        .onClick(async () => {
          this.plugin.settings.trackedFields.push("");
          await this.plugin.saveSettings();
          this._renderFields(fc);
        }),
    );

    // ── 图片处理 ──
    new Setting(el).setName("图片处理").setHeading();

    new Setting(el)
      .setName("粘贴时转换格式")
      .setDesc("粘贴/拖拽图片时自动转换为指定格式。")
      .addDropdown(d => {
        d.addOption("disabled", "不转换");
        d.addOption("webp", "WEBP");
        d.addOption("jpg", "JPEG");
        d.addOption("png", "PNG");
        d.setValue(this.plugin.settings.convertTo || "disabled").onChange(async v => {
          this.plugin.settings.convertTo = v;
          await this.plugin.saveSettings();
          this.display();
        });
      });

    if (this.plugin.settings.convertTo !== "disabled") {
      new Setting(el)
        .setName("可转换图片扩展名")
        .setDesc("逗号分隔。留空使用内置默认：jpg,jpeg,png,gif,svg,bmp,eps,webp,avif,heic,heif")
        .setClass("fps-sub-setting")
        .addText(t =>
          t
            .setValue(this.plugin.settings.convertImageExtensions || "")
            .setPlaceholder("例如 jpg,png,heic")
            .onChange(async v => {
              this.plugin.settings.convertImageExtensions = v;
              await this.plugin.saveSettings();
            }),
        );

      new Setting(el)
        .setName("压缩质量")
        .setDesc(`当前质量：${this.plugin.settings.quality}%`)
        .setClass("fps-sub-setting")
        .addSlider(s =>
          s
            .setLimits(1, 100, 1)
            .setValue(this.plugin.settings.quality)
            .setDynamicTooltip()
            .onChange(async v => {
              this.plugin.settings.quality = v;
              await this.plugin.saveSettings();
            }),
        );

      new Setting(el)
        .setName("保留 EXIF 元数据")
        .setDesc("保留相机型号、拍摄日期、曝光参数等信息。")
        .setClass("fps-sub-setting")
        .addToggle(t =>
          t.setValue(this.plugin.settings.preserveExif).onChange(async v => {
            this.plugin.settings.preserveExif = v;
            await this.plugin.saveSettings();
            this.display();
          }),
        );

      if (this.plugin.settings.preserveExif) {
        new Setting(el)
          .setName("保留 GPS 位置信息")
          .setDesc("保留 EXIF 中的 GPS 坐标。关闭可去除位置信息以保护隐私。")
          .setClass("fps-sub-setting")
          .addToggle(t =>
            t.setValue(this.plugin.settings.preserveGps).onChange(async v => {
              this.plugin.settings.preserveGps = v;
              await this.plugin.saveSettings();
            }),
          );
      }

      new Setting(el)
        .setName("粘贴时缩放")
        .setDesc("粘贴/拖拽图片时自动调整尺寸。")
        .setClass("fps-sub-setting")
        .addDropdown(d => {
          d.addOption("disabled", "不缩放");
          d.addOption("width", "最大宽度");
          d.addOption("height", "最大高度");
          d.addOption("longest", "最长边");
          d.addOption("shortest", "最短边");
          d.setValue(this.plugin.settings.resizeMode || "disabled").onChange(async v => {
            this.plugin.settings.resizeMode = v;
            await this.plugin.saveSettings();
            this.display();
          });
        });

      if (this.plugin.settings.resizeMode !== "disabled") {
        new Setting(el)
          .setName("缩放尺寸 (px)")
          .setClass("fps-sub-setting")
          .addText(t =>
            t
              .setValue(String(this.plugin.settings.resizeValue || 1920))
              .onChange(async v => {
                const n = parseInt(v);
                if (!isNaN(n) && n > 0) {
                  this.plugin.settings.resizeValue = n;
                  await this.plugin.saveSettings();
                }
              }),
          );
      }
    }

    // ── FFmpeg / 视频 ──
    new Setting(el).setName("FFmpeg / 视频").setHeading();

    new Setting(el)
      .setName("FFmpeg 路径")
      .setDesc("系统 FFmpeg 二进制文件路径。留空则禁用视频转换。")
      .addText(t =>
        t
          .setValue(this.plugin.settings.ffmpegPath || "")
          .setPlaceholder("/usr/local/bin/ffmpeg")
          .onChange(async v => {
            this.plugin.settings.ffmpegPath = v.trim();
            await this.plugin.saveSettings();
            this.display();
          }),
      )
      .addButton(b =>
        b.setButtonText("测试").onClick(async () => {
          const p = this.plugin.settings.ffmpegPath;
          if (!p) {
            new Notice("FFmpeg 路径为空");
            return;
          }
          try {
            const ver = await testFFmpeg(p);
            new Notice(`FFmpeg 正常：${ver}`);
          } catch (e: unknown) {
            new Notice(`FFmpeg 测试失败：${e instanceof Error ? e.message : String(e)}`);
          }
        }),
      );

    if (this.plugin.settings.ffmpegPath) {
      new Setting(el)
        .setName("视频转换格式")
        .setDesc("将粘贴/拖拽的视频文件（MP4、MOV 等）转换为指定格式。")
        .setClass("fps-sub-setting")
        .addDropdown(d => {
          d.addOption("disabled", "不转换");
          d.addOption("webp", "Animated WEBP");
          d.addOption("gif", "GIF");
          d.setValue(this.plugin.settings.videoConvertTo || "disabled").onChange(async v => {
            this.plugin.settings.videoConvertTo = v;
            await this.plugin.saveSettings();
          });
        });
    }

    // ── 排除规则 ──
    new Setting(el).setName("排除规则").setHeading();

    new Setting(el)
      .setName("排除扩展名")
      .setDesc("正则匹配需要忽略的文件扩展名（如 pdf|zip）")
      .addText(t =>
        t
          .setValue(this.plugin.settings.excludeExtensionPattern || "")
          .setPlaceholder("pdf|zip")
          .onChange(async v => {
            this.plugin.settings.excludeExtensionPattern = v;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(el)
      .setName("排除路径")
      .setDesc("逗号分隔的 vault 路径，这些路径下的文件不会被处理")
      .addTextArea(t =>
        t
          .setValue(this.plugin.settings.excludedPaths || "")
          .setPlaceholder("templates, archive")
          .onChange(async v => {
            this.plugin.settings.excludedPaths = v;
            this.plugin.settings.excludePathsArray = v
              .split(",")
              .map(s => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(el)
      .setName("包含子路径")
      .setDesc("开启后，排除路径的所有子文件夹也会被排除。")
      .addToggle(t =>
        t.setValue(this.plugin.settings.excludeSubpaths).onChange(async v => {
          this.plugin.settings.excludeSubpaths = v;
          await this.plugin.saveSettings();
        }),
      );

    // ── 其他 ──
    new Setting(el).setName("其他").setHeading();

    new Setting(el)
      .setName("关闭通知")
      .setDesc("关闭附件操作的通知提示。")
      .addToggle(t =>
        t.setValue(this.plugin.settings.disableNotification).onChange(async v => {
          this.plugin.settings.disableNotification = v;
          await this.plugin.saveSettings();
        }),
      );
  }

  private _renderFields(c: HTMLElement): void {
    c.empty();
    this.plugin.settings.trackedFields.forEach((f, i) => {
      new Setting(c)
        .setClass("fps-field-item")
        .addText(t =>
          t
            .setPlaceholder("如 ogImage, cover, banner")
            .setValue(f)
            .onChange(async v => {
              this.plugin.settings.trackedFields[i] = v.trim();
              await this.plugin.saveSettings();
            }),
        )
        .addExtraButton(b =>
          b
            .setIcon("trash")
            .setTooltip("删除")
            .onClick(async () => {
              this.plugin.settings.trackedFields.splice(i, 1);
              await this.plugin.saveSettings();
              this._renderFields(c);
            }),
        );
    });
  }

  private _renderExtOverrides(c: HTMLElement): void {
    c.empty();
    const overrides = this.plugin.settings.attachPath.extensionOverride || [];
    overrides.forEach((eo, i) => {
      new Setting(c)
        .setName(`#${i + 1}`)
        .addText(t =>
          t
            .setValue(eo.extension || "")
            .setPlaceholder("扩展名正则，如 webp|avif")
            .onChange(async v => {
              eo.extension = v;
              await this.plugin.saveSettings();
            }),
        )
        .addText(t =>
          t
            .setValue(eo.attachFormat || "")
            .setPlaceholder("命名格式，如 img-${date}")
            .onChange(async v => {
              eo.attachFormat = v;
              await this.plugin.saveSettings();
            }),
        )
        .addExtraButton(b =>
          b
            .setIcon("trash")
            .setTooltip("删除")
            .onClick(async () => {
              overrides.splice(i, 1);
              await this.plugin.saveSettings();
              this._renderExtOverrides(c);
            }),
        );
    });
  }
}
